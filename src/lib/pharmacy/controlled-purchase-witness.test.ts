import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// DEV-879: these fixtures model an approver with no approval authenticator, so the PIN is
// checked exactly as before. approval-authenticator.test.ts covers the authenticator path.
vi.mock('@/lib/approval-authenticator', async () => {
  const { verifyOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
  return {
    verifyApprovalSecret: async (
      _db: unknown,
      input: { secret: string; credentialHash: string }
    ) =>
      (await verifyOperatorCredential('PIN', input.secret, input.credentialHash)) ? 'PIN' : null,
  };
});
vi.mock('@/lib/abac', () => ({ can: vi.fn(async () => true) }));
vi.mock('@/lib/restaurant/operator-credentials', () => ({
  verifyOperatorCredential: vi.fn(async () => false),
  isLockedOut: vi.fn(() => false),
  registerFailedAttempt: vi.fn(() => ({ failedAttempts: 1, lockedUntil: null })),
  clearLockout: vi.fn(() => ({ failedAttempts: 0, lockedUntil: null })),
}));

import { can } from '@/lib/abac';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { verifyControlledPurchaseWitness } from './goods-receipt';

const credential = {
  id: 'cred',
  credentialHash: 'hash',
  failedAttempts: 0,
  lockedUntil: null,
  staffProfile: {
    status: 'ACTIVE',
    user: {
      id: 'pharmacist',
      organizationId: 'org',
      status: 'ACTIVE',
    },
  },
};

function witnessDb() {
  const update = vi.fn();
  const db = {
    pharmacyGoodsReceipt: {
      findFirst: vi.fn(async () => ({
        branchId: 'branch',
        qualifiedPersonUserId: 'pharmacist',
        lines: [{ medicineId: 'med', acceptedCanonicalUnits: 2 }],
      })),
    },
    medicine: {
      findMany: vi.fn(async () => [{ id: 'med' }]),
    },
    $queryRaw: vi.fn(),
    restaurantOperatorCredential: {
      findFirst: vi.fn(async () => credential),
      update,
    },
  } as unknown as ScopedDb;
  return { db, update };
}

describe('verifyControlledPurchaseWitness', () => {
  beforeEach(() => {
    vi.mocked(can).mockResolvedValue(true);
    vi.mocked(verifyOperatorCredential).mockResolvedValue(false);
  });

  it('does not ask for a PIN when the receipt has no controlled line', async () => {
    const { db } = witnessDb();
    vi.mocked(db.medicine.findMany).mockResolvedValueOnce([]);
    await expect(
      verifyControlledPurchaseWitness(
        db,
        { organizationId: 'org', branchId: 'branch', actorId: 'receiver' },
        { goodsReceiptId: 'receipt' }
      )
    ).resolves.toEqual({ pharmacistId: null });
    expect(db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a witness who is not the qualified person named on the receipt', async () => {
    const { db, update } = witnessDb();
    vi.mocked(db.restaurantOperatorCredential.findFirst).mockResolvedValueOnce({
      ...credential,
      staffProfile: {
        ...credential.staffProfile,
        user: { ...credential.staffProfile.user, id: 'someone-else' },
      },
    } as never);
    await expect(
      verifyControlledPurchaseWitness(
        db,
        { organizationId: 'org', branchId: 'branch', actorId: 'receiver' },
        { goodsReceiptId: 'receipt', staffProfileId: 'staff', pin: '1234' }
      )
    ).resolves.toEqual({
      blocked: 'A different qualified person must enter their PIN.',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('records a failed PIN and does not return the pharmacist', async () => {
    const { db, update } = witnessDb();
    await expect(
      verifyControlledPurchaseWitness(
        db,
        { organizationId: 'org', branchId: 'branch', actorId: 'receiver' },
        { goodsReceiptId: 'receipt', staffProfileId: 'staff', pin: '1234' }
      )
    ).resolves.toEqual({
      blocked: 'Incorrect witness PIN. Ask the receipt’s designated qualified person to try again.',
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'cred' },
      data: { failedAttempts: 1, lockedUntil: null },
    });
  });

  it('accepts the named pharmacist PIN', async () => {
    const { db } = witnessDb();
    vi.mocked(verifyOperatorCredential).mockResolvedValueOnce(true);
    await expect(
      verifyControlledPurchaseWitness(
        db,
        { organizationId: 'org', branchId: 'branch', actorId: 'receiver' },
        { goodsReceiptId: 'receipt', staffProfileId: 'staff', pin: '1234' }
      )
    ).resolves.toEqual({ pharmacistId: 'pharmacist' });
  });

  // DEV-879: the purchasing router proves the witness once, in its own transaction, then
  // posts. A single-use authenticator code cannot be checked a second time while posting.
  describe('posting a witness the request already proved', () => {
    const scope = { organizationId: 'org', branchId: 'branch', actorId: 'receiver' };

    it('re-checks eligibility without checking the secret or touching the counter again', async () => {
      const { db, update } = witnessDb();
      await expect(
        verifyControlledPurchaseWitness(db, scope, {
          goodsReceiptId: 'receipt',
          staffProfileId: 'staff',
          verifiedPharmacistId: 'pharmacist',
        })
      ).resolves.toEqual({ pharmacistId: 'pharmacist' });
      expect(verifyOperatorCredential).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(can).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'pharmacist' }),
        'pharmacy:dispense',
        undefined,
        expect.anything()
      );
    });

    it('refuses when the proven witness is not the credential holder now', async () => {
      const { db } = witnessDb();
      await expect(
        verifyControlledPurchaseWitness(db, scope, {
          goodsReceiptId: 'receipt',
          staffProfileId: 'staff',
          verifiedPharmacistId: 'someone-else',
        })
      ).resolves.toHaveProperty('blocked');
    });

    it('refuses a controlled receipt when no witness was proven', async () => {
      const { db } = witnessDb();
      await expect(
        verifyControlledPurchaseWitness(db, scope, {
          goodsReceiptId: 'receipt',
          staffProfileId: 'staff',
          verifiedPharmacistId: null,
        })
      ).resolves.toHaveProperty('blocked');
      expect(verifyOperatorCredential).not.toHaveBeenCalled();
    });

    it('refuses a proven witness who has since lost the dispensing permission', async () => {
      const { db } = witnessDb();
      vi.mocked(can).mockResolvedValue(false);
      await expect(
        verifyControlledPurchaseWitness(db, scope, {
          goodsReceiptId: 'receipt',
          staffProfileId: 'staff',
          verifiedPharmacistId: 'pharmacist',
        })
      ).resolves.toHaveProperty('blocked');
    });
  });
});
