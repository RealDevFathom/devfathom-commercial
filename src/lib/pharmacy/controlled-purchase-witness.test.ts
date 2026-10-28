import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

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
      blocked: 'A different qualified person must enter their PIN.',
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
    expect(vi.mocked(db.$queryRaw).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(db.restaurantOperatorCredential.findFirst).mock.invocationCallOrder[0]!
    );
  });
});
