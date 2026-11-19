/**
 * DEV-956: once shared onto lines, the whole-bill discount is read wherever a line's money is:
 * per-lot charged money (journal, returns, refunds), the prepaid tier's lot floor, the receipt,
 * the sales report and the idempotent line replay.
 */
import { describe, expect, it, vi } from 'vitest';
import { planBillDiscount, type BillDiscountLine } from './bill-discount';
import {
  COUNTER_RECEIPT_STRINGS,
  receiptPromotionLabel,
  receiptTierLines,
} from './counter-receipt';
import { prepaidLineDiscount } from './prepaid-discount';
import { priceReturn, saleAllocationMoney } from './sale-line-money';
import { replaySaleLine } from './sales';

// A line of two lots, Rs 1.00 and Rs 2.00, cost 0.50 each, with a bill share of 48 (12 + 36).
const sold = {
  id: 'line-a',
  createdAt: new Date('2026-11-19T00:00:00Z'),
  quantity: 2,
  unitPriceMinor: 150,
  canonicalUnits: 2,
  grossMinor: 300,
  discountMinor: 48,
  billDiscountMinor: 48,
  billAllocationDiscounts: { 'alloc-1': 12, 'alloc-2': 36 },
  tierDiscountMinor: 0,
  medicine: { rx: false, restricted: false, controlled: false },
  allocations: [
    {
      id: 'alloc-1',
      canonicalUnits: 1,
      grossMinor: 100,
      discountMinor: 0,
      lot: { unitCostMinor: 50 },
    },
    {
      id: 'alloc-2',
      canonicalUnits: 1,
      grossMinor: 200,
      discountMinor: 0,
      lot: { unitCostMinor: 50 },
    },
  ],
};

describe('bill discount money on each lot (DEV-956)', () => {
  it('charges each lot its own share, so journal and returns use the paid price', () => {
    const charged = saleAllocationMoney(sold);
    expect(charged.map((row) => [row.grossMinor, row.discountMinor])).toEqual([
      [100, 12],
      [200, 36],
    ]);
    // Returning each lot gives back exactly what was paid for it, and the two add up.
    const first = priceReturn({ ...sold, returnLines: [] }, 1, charged[0]);
    expect(first).toEqual({ grossMinor: 100, discountMinor: 12 });
    const second = priceReturn(
      { ...sold, returnLines: [{ canonicalUnits: 1, ...first }] },
      1,
      charged[1]
    );
    expect(second).toEqual({ grossMinor: 200, discountMinor: 36 });
    expect(first.grossMinor - first.discountMinor + second.grossMinor - second.discountMinor).toBe(
      300 - 48
    );
  });

  it("prices the prepaid tier on what the bill discount left, within each lot's floor", () => {
    // Lot room above cost after the bill share: 100 - 12 - 50 = 38 and 200 - 36 - 50 = 114.
    expect(prepaidLineDiscount(sold, 10_000, 200)).toEqual({
      amountMinor: 152,
      allocations: [38, 114],
    });
    // The owner's maximum counts the bill share too: 50% of 300 less the 48 already given.
    expect(
      prepaidLineDiscount(sold, 10_000, 200, { minMarginBps: 0, maxDiscountBps: 5_000 })
    ).toMatchObject({ amountMinor: 102 });
  });

  it('prices the bill discount first, then the tier never takes a lot below cost', () => {
    const line: BillDiscountLine = {
      ...sold,
      discountMinor: 0,
      billDiscountMinor: 0,
      billAllocationDiscounts: undefined,
    } as BillDiscountLine;
    const plan = planBillDiscount(
      [line],
      { kind: 'AMOUNT', minor: 190 },
      {
        minMarginBps: 0,
        maxDiscountBps: 10_000,
      }
    );
    const share = plan.shares[0]!;
    const priced = {
      ...sold,
      discountMinor: share.discountMinor,
      billDiscountMinor: share.discountMinor,
      billAllocationDiscounts: share.allocations,
    };
    const tier = prepaidLineDiscount(priced, 1_000);
    // 10% of the 110 left is 11, but only 10 is left above cost on the two lots.
    expect(tier.amountMinor).toBe(10);
    sold.allocations.forEach((allocation, i) => {
      expect(
        allocation.grossMinor - share.allocations[allocation.id]! - tier.allocations[i]!
      ).toBeGreaterThanOrEqual(allocation.lot.unitCostMinor);
    });
  });

  it('shows the whole-bill discount once on the receipt, before any tier line, in both languages', () => {
    const receipt = {
      lines: [
        { billDiscountMinor: 48, tierDiscountMinor: 0, tierName: null },
        { billDiscountMinor: 53, tierDiscountMinor: 7, tierName: 'Bronze' },
      ],
    } as unknown as Parameters<typeof receiptTierLines>[0];
    expect(receiptTierLines(receipt, 'en')).toEqual([
      'Whole-bill discount: -1.01',
      'Prepaid tier discount · Bronze: -0.07',
    ]);
    expect(receiptTierLines(receipt, 'ur')[0]).toContain(COUNTER_RECEIPT_STRINGS.ur.billDiscount);
    expect(receiptTierLines({ lines: [] } as never, 'en')).toEqual([]);
    expect(
      receiptPromotionLabel(
        { promotionName: 'Winter', discountMinor: 30, tierDiscountMinor: 5, billDiscountMinor: 0 },
        'en'
      )
    ).toBe('Promotion: Winter (-0.25)');
  });
});

describe('line replay after a bill discount (DEV-956)', () => {
  const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };
  const input = {
    saleId: 'sale-a',
    medicineId: 'med-a',
    presentationId: 'pres-a',
    packLevelId: 'pack-a',
    saleUnit: 'UNIT' as const,
    quantity: 2,
    canonicalUnitsPerSaleUnit: 1,
    idempotencyKey: 'key-a',
  };
  const previous = {
    ...input,
    id: 'line-a',
    branchId: 'branch-a',
    voucherId: null,
    promotionId: null,
    discountKind: 'DISCOUNT',
    discountMinor: 48,
    billDiscountMinor: 48,
    allocations: [],
  };
  const db = (row: unknown) =>
    ({
      $queryRaw: vi.fn(async () => [{ locked: '' }]),
      pharmacySaleLine: { findFirst: vi.fn(async () => row) },
    }) as never;

  it('replays the original add, which had no discount of its own', async () => {
    await expect(replaySaleLine(db(previous), scope, input)).resolves.toMatchObject({
      replayed: true,
    });
  });

  it('still refuses a replay that now asks for an item discount', async () => {
    await expect(
      replaySaleLine(db(previous), scope, { ...input, discountKind: 'DISCOUNT', discountMinor: 48 })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  });
});
