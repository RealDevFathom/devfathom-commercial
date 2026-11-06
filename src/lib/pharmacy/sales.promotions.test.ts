import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addSaleLine, returnedLineValue } from './sales';
import { priceCounterPromotion } from './promotions';

vi.mock('./stock-ledger', async (original) => ({
  ...(await original<typeof import('./stock-ledger')>()),
  allocateForSale: vi.fn(
    async (_db: unknown, _scope: unknown, input: { requiredUnits: number }) => ({
      allocations: [
        { inventoryLotId: 'lot', stockLocationId: 'shelf', units: input.requiredUnits },
      ],
      movementIds: ['movement'],
    })
  ),
}));
vi.mock('./promotions', () => ({ priceCounterPromotion: vi.fn() }));
const scope = { organizationId: 'org-727', branchId: 'branch-727', actorId: 'cashier' };
const input = {
  saleId: 'sale',
  medicineId: 'otc',
  presentationId: 'presentation',
  packLevelId: 'pack',
  saleUnit: 'UNIT' as const,
  quantity: 2,
  canonicalUnitsPerSaleUnit: 1,
  idempotencyKey: 'add-1',
};
function fixture(regulated = false) {
  return {
    pharmacySale: {
      findFirst: vi.fn(async () => ({ id: 'sale', status: 'OPEN' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    medicine: {
      findFirst: vi.fn(async () => ({ rx: regulated, restricted: false, controlled: false })),
    },
    pharmacyInventoryLot: {
      findMany: vi.fn(async () => [
        { id: 'lot', printedMrpMinor: 100, unitsPerPack: 1, unitCostMinor: 25 },
      ]),
    },
    pharmacySaleLine: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'line',
        ...data,
      })),
    },
    pharmacySaleLineAllocation: { create: vi.fn() },
    pharmacySaleEvent: { create: vi.fn() },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(priceCounterPromotion).mockResolvedValue({
    discountMinor: 20,
    promotion: {
      id: 'offer',
      name: 'November offer',
      createdByUserId: 'owner',
      effectiveFrom: new Date('2026-11-01'),
      effectiveTo: new Date('2026-11-02'),
      benefitBasisPoints: 1000,
      benefitMinor: null,
    },
  } as never);
});
describe('#727 counter pricing hook', () => {
  it('persists the evaluator discount, authorization and receipt name on the actual line', async () => {
    const db = fixture();
    const result = await addSaleLine(db as never, scope, input, { applyCounterPromotions: true });
    expect(priceCounterPromotion).toHaveBeenCalledWith(
      db,
      scope,
      expect.objectContaining({
        medicineId: 'otc',
        regulated: false,
        grossMinor: 200,
        costMinor: 50,
        at: expect.any(Date),
      })
    );
    expect(result.line).toMatchObject({
      discountKind: 'PROMOTION',
      discountMinor: 20,
      promotionId: 'offer',
      promotionName: 'November offer',
      approvedByUserId: 'owner',
      approvalPolicy: 'pharmacy-promotion:offer',
    });
    expect(db.pharmacySaleEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'cashier',
        kind: 'LINE_ADDED',
        payload: expect.objectContaining({
          saleLineId: 'line',
          promotionId: 'offer',
          discountMinor: 20,
          approvedByUserId: 'owner',
        }),
      }),
    });
    expect(db.pharmacySaleLineAllocation.create).toHaveBeenCalledOnce();
  });
  it('retains every paisa across cumulative partial returns of a promoted line', async () => {
    vi.mocked(priceCounterPromotion).mockResolvedValue({
      discountMinor: 11,
      promotion: {
        id: 'offer',
        name: 'offer',
        createdByUserId: 'owner',
        effectiveFrom: new Date('2026-11-01'),
        effectiveTo: new Date('2026-11-02'),
        benefitBasisPoints: null,
        benefitMinor: 11,
      },
    } as never);
    const { line } = await addSaleLine(
      fixture() as never,
      scope,
      {
        ...input,
        quantity: 3,
      },
      { applyCounterPromotions: true }
    );
    const cumulative = [0, 1, 2, 3].map((units) => returnedLineValue(line, units));
    expect(cumulative).toEqual([0, 96, 192, 289]);
    expect(cumulative[3]).toBe(line.quantity * line.unitPriceMinor - line.discountMinor);
  });
  it('leaves signed replay and existing direct callers at the original price', async () => {
    const result = await addSaleLine(fixture() as never, scope, input);
    expect(priceCounterPromotion).not.toHaveBeenCalled();
    expect(result.line.discountMinor).toBe(0);
    expect(result.line.promotionId).toBeUndefined();
  });
  it('preserves manual discounts and their original approval without stacking', async () => {
    const result = await addSaleLine(
      fixture() as never,
      scope,
      {
        ...input,
        discountKind: 'DISCOUNT',
        discountMinor: 5,
        approvedByUserId: 'manager',
        approvalPolicy: 'manual-policy',
      },
      { applyCounterPromotions: true }
    );
    expect(priceCounterPromotion).not.toHaveBeenCalled();
    expect(result.line).toMatchObject({
      discountMinor: 5,
      approvedByUserId: 'manager',
      approvalPolicy: 'manual-policy',
    });
  });
  it.each([
    ['rx', true],
    ['below cost', false],
  ] as const)('still enforces the existing %s guardrail', async (_name, regulated) => {
    vi.mocked(priceCounterPromotion).mockResolvedValue({
      discountMinor: regulated ? 20 : 151,
      promotion: { id: 'offer', name: 'offer', createdByUserId: 'owner' },
    } as never);
    const db = fixture(regulated);
    await expect(
      addSaleLine(db as never, scope, input, { applyCounterPromotions: true })
    ).rejects.toMatchObject({
      reason: regulated ? 'REGULATED_DISCOUNT_REFUSED' : 'MARGIN_GUARDRAIL',
    });
    expect(db.pharmacySaleLine.create).not.toHaveBeenCalled();
  });
});
