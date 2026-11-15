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

vi.mock('./voucher-scope', async () => ({
  ...(await vi.importActual<typeof import('./voucher-scope')>('./voucher-scope')),
  assertVoucherEligibleLine: vi.fn(),
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

function counterDb(
  medicine: Record<string, unknown> = {},
  promotions = [promotion],
  creator: Record<string, unknown> | null = {
    id: 'manager-a',
    organizationId: 'org-a',
    status: 'ACTIVE',
    role: 'ADMIN',
  }
) {
  return {
    pharmacyBranchAssignment: {
      findFirst: vi.fn<(args: unknown) => Promise<{ branchId: string } | null>>(async () => ({
        branchId: 'branch-a',
      })),
    },
    user: {
      findFirst: vi.fn(async () => creator),
      // The creating manager's `pharmacy:manage` grant is re-checked on every application.
      findUnique: vi.fn(async () => ({
        organizationRole: null,
        permissionOverrides: [{ capability: 'pharmacy:manage', effect: 'ALLOW' }],
      })),
    },
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
    // DEV-830: the stored pack setup the server derives the line multiplier from.
    packLevel: {
      findMany: vi.fn(async () => [
        { id: 'pack-a', level: 'PACK', parentPackLevelId: null, unitsPerParent: 10 },
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

  it.each([
    [
      'is deactivated',
      { id: 'manager-a', organizationId: 'org-a', status: 'SUSPENDED', role: 'ADMIN' },
    ],
    ['is gone', null],
  ])('does not apply a promotion whose creator %s (QA-8)', async (_label, change) => {
    const db = counterDb({}, [promotion], change);

    await addSaleLine(db as never, scope, lineInput, { applyCounterPromotions: true });

    expect(db.pharmacySaleLine.create.mock.calls[0]![0].data).toMatchObject({
      discountMinor: 0,
      discountKind: undefined,
      promotionId: undefined,
    });
  });

  it('does not apply a promotion whose creator lost the manage capability (QA-8)', async () => {
    const db = counterDb();
    db.user.findUnique.mockResolvedValue({
      organizationRole: null,
      permissionOverrides: [],
    } as never);

    await addSaleLine(db as never, scope, lineInput, { applyCounterPromotions: true });

    expect(db.pharmacySaleLine.create.mock.calls[0]![0].data).toMatchObject({
      discountMinor: 0,
      promotionId: undefined,
    });
  });

  it('does not apply a promotion whose creator was unassigned from the branch (QA-8)', async () => {
    const db = counterDb({}, [promotion], {
      id: 'manager-a',
      organizationId: 'org-a',
      status: 'ACTIVE',
      role: 'EMPLOYEE',
    });
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);

    await addSaleLine(db as never, scope, lineInput, { applyCounterPromotions: true });

    expect(db.pharmacySaleLine.create.mock.calls[0]![0].data).toMatchObject({
      discountMinor: 0,
      promotionId: undefined,
    });
  });

  it('skips the promotion, never blocks the line, when the creator lookup fails (QA-8)', async () => {
    const db = counterDb();
    db.user.findFirst.mockRejectedValue(new Error('db down'));

    await addSaleLine(db as never, scope, lineInput, { applyCounterPromotions: true });

    expect(db.pharmacySaleLine.create.mock.calls[0]![0].data).toMatchObject({
      discountMinor: 0,
      promotionId: undefined,
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

  it('does not stack a promotion on a redeemed voucher', async () => {
    const db = {
      ...counterDb(),
      user: {
        findFirst: vi.fn(async () => ({
          id: 'manager-v',
          organizationId: scope.organizationId,
          status: 'ACTIVE',
          role: 'ADMIN',
        })),
        findUnique: vi.fn(async () => ({ organizationRole: null, permissionOverrides: [] })),
      },
      pharmacyVoucher: {
        findFirst: vi.fn(async () => ({
          id: 'voucher-a',
          discountMinor: 40,
          eligibleCategories: null,
          issuedByUserId: 'manager-v',
          approvedByUserId: 'manager-v',
          approvalPolicy: 'VOUCHER_WITHIN_CAP',
          validUntil: new Date(Date.now() + 86_400_000),
          maxUses: 1,
          usedCount: 0,
          revokedAt: null,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };

    await addSaleLine(
      db as never,
      scope,
      { ...lineInput, voucherId: 'voucher-a', voucherCashierPinVerified: true },
      { applyCounterPromotions: true }
    );

    expect(db.pharmacyPromotion.findMany).not.toHaveBeenCalled();
    expect(db.pharmacySaleLine.create.mock.calls[0]![0].data).toMatchObject({
      discountKind: 'VOUCHER',
      discountMinor: 40,
      voucherId: 'voucher-a',
      approvedByUserId: 'manager-v',
      approvalPolicy: 'voucher:voucher-a',
      promotionId: undefined,
    });
    expect(db.pharmacyVoucher.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'voucher-a', usedCount: 0 }),
      data: { usedCount: { increment: 1 } },
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
