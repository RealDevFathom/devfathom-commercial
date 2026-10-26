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
import { listGoodsReceiptPinWitnesses, verifyControlledPurchaseWitness } from './goods-receipt';

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
    pharmacyBranchAssignment: {
      findFirst: vi.fn(async () => ({ id: 'assignment' })),
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
  });

  it('refuses the named pharmacist when they are not assigned to the receipt branch', async () => {
    const { db, update } = witnessDb();
    vi.mocked(db.pharmacyBranchAssignment.findFirst).mockResolvedValueOnce(null);
    vi.mocked(verifyOperatorCredential).mockResolvedValueOnce(true);

    await expect(
      verifyControlledPurchaseWitness(
        db,
        { organizationId: 'org', branchId: 'branch', actorId: 'receiver' },
        { goodsReceiptId: 'receipt', staffProfileId: 'staff', pin: '1234' }
      )
    ).resolves.toEqual({
      blocked: 'A different qualified person must enter their PIN.',
    });
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('listGoodsReceiptPinWitnesses', () => {
  it.each([
    ['has no named qualified person', null],
    ['names the current actor', 'receiver'],
  ])(
    'does not enumerate profiles when the receipt %s',
    async (_case, qualifiedPersonUserId) => {
      const findFirst = vi.fn();
      const db = {
        pharmacyGoodsReceipt: {
          findFirst: vi.fn().mockResolvedValue({ qualifiedPersonUserId }),
        },
        restaurantStaffProfile: { findFirst },
      } as unknown as ScopedDb;

      await expect(
        listGoodsReceiptPinWitnesses(
          db,
          { organizationId: 'org', branchId: 'branch', actorId: 'receiver' },
          'receipt'
        )
      ).resolves.toEqual([]);
      expect(findFirst).not.toHaveBeenCalled();
    }
  );

  it('returns only the receipt qualified person assigned to its branch', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'staff',
      displayName: 'Named pharmacist',
      user: credential.staffProfile.user,
      credentials: [credential],
    });
    const db = {
      pharmacyGoodsReceipt: {
        findFirst: vi.fn().mockResolvedValue({ qualifiedPersonUserId: 'pharmacist' }),
      },
      restaurantStaffProfile: { findFirst },
    } as unknown as ScopedDb;

    await expect(
      listGoodsReceiptPinWitnesses(
        db,
        { organizationId: 'org', branchId: 'branch', actorId: 'receiver' },
        'receipt'
      )
    ).resolves.toEqual([{ id: 'staff', name: 'Named pharmacist' }]);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org',
          userId: 'pharmacist',
          status: 'ACTIVE',
          user: expect.objectContaining({
            organizationId: 'org',
            status: 'ACTIVE',
            pharmacyBranchAssignments: {
              some: { organizationId: 'org', branchId: 'branch', active: true },
            },
          }),
          credentials: { some: { type: 'PIN', revokedAt: null, deviceId: null } },
        }),
      })
    );
  });

  it('does not offer the named qualified person without an eligible branch profile', async () => {
    vi.mocked(can).mockClear();
    const db = {
      pharmacyGoodsReceipt: {
        findFirst: vi.fn().mockResolvedValue({ qualifiedPersonUserId: 'pharmacist' }),
      },
      restaurantStaffProfile: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as ScopedDb;

    await expect(
      listGoodsReceiptPinWitnesses(
        db,
        { organizationId: 'org', branchId: 'branch', actorId: 'receiver' },
        'receipt'
      )
    ).resolves.toEqual([]);
    expect(can).not.toHaveBeenCalled();
  });

  it('does not enumerate profiles when the receipt belongs to another branch', async () => {
    const findFirst = vi.fn();
    const receiptFindFirst = vi.fn().mockResolvedValue(null);
    const db = {
      pharmacyGoodsReceipt: { findFirst: receiptFindFirst },
      restaurantStaffProfile: { findFirst },
    } as unknown as ScopedDb;

    await expect(
      listGoodsReceiptPinWitnesses(
        db,
        { organizationId: 'org', branchId: 'branch', actorId: 'receiver' },
        'receipt'
      )
    ).resolves.toEqual([]);
    expect(receiptFindFirst).toHaveBeenCalledWith({
      where: { id: 'receipt', organizationId: 'org', branchId: 'branch' },
      select: { qualifiedPersonUserId: true },
    });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
