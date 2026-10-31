import { beforeEach, describe, expect, it, vi } from 'vitest';
import { can } from '@/lib/abac';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { reverseGoodsReceipt } from './goods-receipt';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: vi.fn() }));

vi.mock('@/lib/abac', () => ({ can: vi.fn() }));
vi.mock('@/lib/restaurant/operator-credentials', () => ({
  verifyOperatorCredential: vi.fn(),
  isLockedOut: () => false,
  clearLockout: () => ({}),
  registerFailedAttempt: () => ({ failedAttempts: 1 }),
}));

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'original-witness' };
const input = {
  goodsReceiptId: 'receipt',
  reason: 'Wrong consignment',
  at: new Date(),
  controlledWitness: { staffProfileId: 'staff', pin: '1234' },
};

function fixture() {
  const purchase = {
    id: 'purchase',
    medicineId: 'medicine',
    inventoryLotId: 'lot',
    stockMovementId: 'receipt-movement',
    quantityCanonicalUnits: 2,
    batchNumber: 'batch',
    witnessedByUserId: scope.actorId,
    signatureRef: 'pin:historical',
  };
  const db = {
    $queryRaw: vi.fn(),
    user: { findFirst: vi.fn().mockResolvedValue({ id: scope.actorId, status: 'ACTIVE' }) },
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch' }) },
    pharmacyBranchAssignment: { findMany: vi.fn().mockResolvedValue([{ branchId: 'branch' }]) },
    restaurantOperatorCredential: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'credential',
        credentialHash: 'hash',
        staffProfile: {
          status: 'ACTIVE',
          user: { id: 'fresh-witness', organizationId: 'org', status: 'ACTIVE' },
        },
      }),
      update: vi.fn(),
    },
    pharmacyGoodsReceipt: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'receipt',
        branchId: 'branch',
        status: 'POSTED',
        lines: [{ id: 'line' }],
      }),
      update: vi.fn(),
    },
    pharmacyControlledRegisterEntry: {
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          where.inventoryLotId ? { runningBalance: 2 } : purchase
        ),
      findMany: vi.fn().mockResolvedValue([purchase]),
      aggregate: vi.fn().mockResolvedValue({ _max: { serial: 1 } }),
      create: vi.fn(),
    },
    pharmacyStockMovement: {
      findMany: vi.fn().mockResolvedValue([{ id: 'receipt-movement' }]),
      findFirst: vi.fn().mockImplementation(async ({ where }) =>
        where.reversesMovementId
          ? { id: 'reversal', quantityUnits: -2 }
          : {
              id: 'receipt-movement',
              inventoryLotId: 'lot',
              quantityUnits: 2,
              sealedPackDelta: 2,
              looseUnitDelta: 0,
            }
      ),
      create: vi.fn().mockResolvedValue({ id: 'reversal' }),
    },
    pharmacyStockBalance: { aggregate: vi.fn().mockResolvedValue({ _sum: { onHandUnits: 0 } }) },
  };
  vi.mocked(withTenantDb).mockImplementation(async (_organizationId, run) => run(db as never));
  return {
    db,
    run: (request: Parameters<typeof reverseGoodsReceipt>[2] = input) =>
      reverseGoodsReceipt(db as unknown as ScopedDb, scope, request),
  };
}

describe('controlled goods receipt reversal authorization', () => {
  beforeEach(() => {
    vi.mocked(can).mockResolvedValue(true);
    vi.mocked(verifyOperatorCredential).mockResolvedValue(true);
  });

  it('lets the original witness reverse with a different fresh witness', async () => {
    const { db, run } = fixture();
    await expect(run()).resolves.toMatchObject({ reversalMovementIds: ['reversal'] });
    expect(can).toHaveBeenCalledWith(
      expect.objectContaining({ id: scope.actorId }),
      'pharmacy:safety',
      undefined,
      expect.anything()
    );
    expect(db.pharmacyControlledRegisterEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correctsEntryId: 'purchase',
        restorationMovementId: 'reversal',
        quantityCanonicalUnits: 0,
        balanceDelta: -2,
        runningBalance: 0,
        recordedByUserId: scope.actorId,
        witnessedByUserId: 'fresh-witness',
        signatureRef: expect.stringMatching(/^pin:credential:/),
      }),
    });
  });

  it.each(['permission', 'branch', 'missing PIN', 'wrong PIN', 'self witness'])(
    'rejects %s before stock, register or receipt writes',
    async (failure) => {
      const { db, run } = fixture();
      if (failure === 'permission') vi.mocked(can).mockResolvedValue(false);
      if (failure === 'branch') db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);
      if (failure === 'wrong PIN') vi.mocked(verifyOperatorCredential).mockResolvedValue(false);
      if (failure === 'self witness') {
        const credential = await db.restaurantOperatorCredential.findFirst();
        credential.staffProfile.user.id = scope.actorId;
      }
      await expect(
        run(failure === 'missing PIN' ? { ...input, controlledWitness: undefined } : input)
      ).rejects.toThrow();
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyControlledRegisterEntry.create).not.toHaveBeenCalled();
      expect(db.pharmacyGoodsReceipt.update).not.toHaveBeenCalled();
      if (failure === 'wrong PIN')
        expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
          where: { id: 'credential' },
          data: { failedAttempts: 1 },
        });
    }
  );

  it('keeps ordinary receipt reversal available without a witness', async () => {
    const { db, run } = fixture();
    db.pharmacyControlledRegisterEntry.findFirst.mockResolvedValue(null as never);
    db.pharmacyControlledRegisterEntry.findMany.mockResolvedValue([]);
    await expect(run({ ...input, controlledWitness: undefined })).resolves.toMatchObject({
      reversalMovementIds: ['reversal'],
    });
    expect(db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
  });

  it('locks the branch register before the first compensating stock movement', async () => {
    const { db, run } = fixture();
    await run();
    const lockIndex = db.$queryRaw.mock.calls.findIndex(([sql]) =>
      String(sql).includes('pg_advisory_xact_lock')
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(db.$queryRaw.mock.calls[lockIndex]!.slice(1)).toEqual(['org:branch']);
    expect(db.$queryRaw.mock.invocationCallOrder[lockIndex]).toBeLessThan(
      db.pharmacyStockMovement.create.mock.invocationCallOrder[0]!
    );
  });

  it('reverses two posted lines that landed on the same controlled lot', async () => {
    const { db, run } = fixture();
    const base = {
      medicineId: 'medicine',
      inventoryLotId: 'lot',
      batchNumber: 'batch',
      witnessedByUserId: scope.actorId,
      signatureRef: 'pin:historical',
    };
    const purchases = [
      { ...base, id: 'p1', stockMovementId: 'm1', quantityCanonicalUnits: 2 },
      { ...base, id: 'p2', stockMovementId: 'm2', quantityCanonicalUnits: 3 },
    ];
    const originals: Record<string, number> = { m1: 2, m2: 3 };
    let onHand = 5;
    let running = 5;
    const reversed: Record<string, number> = {};
    db.pharmacyStockMovement.findMany.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    db.pharmacyStockMovement.findFirst.mockImplementation(async ({ where }) =>
      where.reversesMovementId
        ? reversed[where.reversesMovementId] === undefined
          ? null
          : {
              id: `${where.reversesMovementId}:rev`,
              quantityUnits: reversed[where.reversesMovementId],
            }
        : {
            id: where.id,
            inventoryLotId: 'lot',
            quantityUnits: originals[where.id],
            sealedPackDelta: originals[where.id],
            looseUnitDelta: 0,
          }
    );
    db.pharmacyStockMovement.create.mockImplementation(async ({ data }) => {
      reversed[data.reversesMovementId] = data.quantityUnits;
      onHand += data.quantityUnits;
      return { id: `${data.reversesMovementId}:rev` };
    });
    db.pharmacyStockBalance.aggregate.mockImplementation(async () => ({
      _sum: { onHandUnits: onHand },
    }));
    db.pharmacyControlledRegisterEntry.findMany.mockImplementation(async ({ where }) =>
      purchases.filter((entry) => where.stockMovementId.in.includes(entry.stockMovementId))
    );
    db.pharmacyControlledRegisterEntry.findFirst.mockImplementation(async ({ where }) =>
      where.inventoryLotId ? { runningBalance: running } : purchases[0]
    );
    db.pharmacyControlledRegisterEntry.create.mockImplementation(async ({ data }) => {
      running = data.runningBalance;
      return { id: 'row' };
    });

    await expect(run()).resolves.toMatchObject({ reversalMovementIds: ['m1:rev', 'm2:rev'] });
    expect(db.pharmacyControlledRegisterEntry.create).toHaveBeenCalledTimes(2);
    expect(db.pharmacyControlledRegisterEntry.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ correctsEntryId: 'p1', balanceDelta: -2, runningBalance: 3 }),
    });
    expect(db.pharmacyControlledRegisterEntry.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ correctsEntryId: 'p2', balanceDelta: -3, runningBalance: 0 }),
    });
  });

  it('reports stock that moved on since posting as a domain error', async () => {
    const { db, run } = fixture();
    db.pharmacyStockBalance.aggregate.mockResolvedValue({ _sum: { onHandUnits: 1 } });
    await expect(run()).rejects.toMatchObject({ reason: 'INSUFFICIENT_STOCK' });
    expect(db.pharmacyControlledRegisterEntry.create).not.toHaveBeenCalled();
  });
});
