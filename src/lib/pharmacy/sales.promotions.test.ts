import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./regulatory', async () => ({
  ...(await vi.importActual<typeof import('./regulatory')>('./regulatory')),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));
vi.mock('./stock-ledger', async () => ({
  ...(await vi.importActual<typeof import('./stock-ledger')>('./stock-ledger')),
  allocateForSale: vi.fn(async () => ({
    allocations: [{ inventoryLotId: 'lot-a', stockLocationId: 'location-a', units: 10 }],
    movementIds: ['movement-a'],
  })),
}));

import { addSaleLine } from './sales';

/**
 * #727: the online counter prices a line against the branch's live promotions;
 * the discount is attributed to the promotion and its authorizing manager and
 * flows through the same `discountMinor` that tenders, journals and returns use.
 */
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };
const NOW = new Date('2026-11-03T10:00:00.000Z');

const promotion = {
  id: 'promo-a',
  organizationId: 'org-a',
  branchId: 'branch-a',
  name: 'Winter week',
  medicineId: null,
  effectiveFrom: new Date('2026-11-01T00:00:00.000Z'),
  effectiveTo: new Date('2026-11-08T00:00:00.000Z'),
  benefitBasisPoints: 1_000,
  benefitMinor: null,
  priority: 0,
  active: true,
  createdByUserId: 'manager-a',
};

function counterDb(medicine: Record<string, unknown> = {}, promotions = [promotion]) {
  return {
    pharmacySale: {
      findFirst: vi.fn(async () => ({ id: 'sale-a', status: 'OPEN', lines: [] })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    medicine: {
      findFirst: vi.fn(async () => ({
        id: 'medicine-a',
        rx: false,
        restricted: false,
        controlled: false,
        ...medicine,
      })),
    },
    pharmacyInventoryLot: {
      findMany: vi.fn(async () => [
        {
          id: 'lot-a',
          packLevelId: 'pack-a',
          printedMrpMinor: 1_000,
          unitsPerPack: 10,
          unitCostMinor: 50,
          batch: { batchNumber: 'B-1' },
        },
      ]),
    },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
    pharmacyPromotion: { findMany: vi.fn(async () => promotions) },
    pharmacySaleLine: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'line-a',
        ...data,
      })),
    },
    pharmacySaleLineAllocation: {
      create: vi.fn<(args: { data: Record<string, unknown> }) => Promise<object>>(async () => ({})),
    },
    pharmacySaleEvent: {
      create: vi.fn<(args: { data: Record<string, unknown> }) => Promise<object>>(async () => ({})),
    },
  };
}

const lineInput = {
  saleId: 'sale-a',
  medicineId: 'medicine-a',
  presentationId: 'presentation-a',
  packLevelId: 'pack-a',
  saleUnit: 'PACK' as const,
  quantity: 1,
  canonicalUnitsPerSaleUnit: 10,
  idempotencyKey: 'line-a',
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('addSaleLine counter promotion hook (#727)', () => {
  it('prices the line with the live promotion and attributes it', async () => {
    const db = counterDb();

    await addSaleLine(db as never, scope, lineInput, { applyCounterPromotions: true });

    expect(db.pharmacyPromotion.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        branchId: 'branch-a',
        active: true,
        effectiveFrom: { lte: NOW },
        effectiveTo: { gt: NOW },
        OR: [{ medicineId: null }, { medicineId: 'medicine-a' }],
      },
    });
    expect(db.pharmacySaleLine.create.mock.calls[0]![0].data).toMatchObject({
      grossMinor: 1_000,
      discountKind: 'PROMOTION',
      discountMinor: 100,
      promotionId: 'promo-a',
      promotionName: 'Winter week',
      approvedByUserId: 'manager-a',
      approvalPolicy: 'pharmacy-promotion:promo-a',
    });
    expect(db.pharmacySaleLineAllocation.create.mock.calls[0]![0]).toMatchObject({
      data: { grossMinor: 1_000, discountMinor: 100 },
    });
    expect(db.pharmacySaleEvent.create.mock.calls[0]![0].data).toMatchObject({
      kind: 'LINE_ADDED',
      payload: {
        saleLineId: 'line-a',
        promotionId: 'promo-a',
        discountMinor: 100,
        approvedByUserId: 'manager-a',
        evaluatedAt: NOW.toISOString(),
      },
    });
  });

  it('keeps the quoted price on paths that do not opt in (offline replay, orders)', async () => {
    const db = counterDb();

    await addSaleLine(db as never, scope, lineInput);

    expect(db.pharmacyPromotion.findMany).not.toHaveBeenCalled();
    expect(db.pharmacySaleLine.create.mock.calls[0]![0].data).toMatchObject({
      discountMinor: 0,
      promotionId: undefined,
    });
  });

  it.each([{ rx: true }, { restricted: true }, { controlled: true }])(
    'never applies a promotion to a regulated medicine (%o)',
    async (flags) => {
      const db = counterDb(flags);

      await addSaleLine(db as never, scope, lineInput, { applyCounterPromotions: true });

      expect(db.pharmacyPromotion.findMany).not.toHaveBeenCalled();
      expect(db.pharmacySaleLine.create.mock.calls[0]![0].data).toMatchObject({
        discountMinor: 0,
        discountKind: undefined,
      });
    }
  );

  it('does not stack a promotion on a manual discount', async () => {
    const db = counterDb();

    await addSaleLine(
      db as never,
      scope,
      {
        ...lineInput,
        discountKind: 'DISCOUNT',
        discountMinor: 30,
        approvedByUserId: 'manager-b',
        approvalPolicy: 'manager-pin',
      },
      { applyCounterPromotions: true }
    );

    expect(db.pharmacyPromotion.findMany).not.toHaveBeenCalled();
    expect(db.pharmacySaleLine.create.mock.calls[0]![0].data).toMatchObject({
      discountKind: 'DISCOUNT',
      discountMinor: 30,
      approvedByUserId: 'manager-b',
      promotionId: undefined,
    });
  });

  it('sells at full price when the only promotion would go below cost', async () => {
    const db = counterDb({}, [{ ...promotion, benefitBasisPoints: 6_000 }]);

    await addSaleLine(db as never, scope, lineInput, { applyCounterPromotions: true });

    expect(db.pharmacySaleLine.create.mock.calls[0]![0].data).toMatchObject({
      discountMinor: 0,
      promotionId: undefined,
    });
  });
});
