import { describe, expect, it } from 'vitest';
import {
  billAllocationDiscount,
  billDiscountExclusion,
  BillDiscountRefused,
  cappedLargestRemainder,
  largestRemainder,
  planBillDiscount,
  type BillDiscountLine,
} from './bill-discount';

const NO_LIMITS = { minMarginBps: 0, maxDiscountBps: 10_000 };
let sequence = 0;

/** One OTC line with one allocation per [gross, cost]. */
function line(lots: [number, number][], extra: Partial<BillDiscountLine> = {}): BillDiscountLine {
  sequence += 1;
  const id = `line_${String(sequence).padStart(3, '0')}`;
  return {
    id,
    createdAt: new Date(Date.UTC(2026, 10, 19, 0, 0, sequence)),
    grossMinor: lots.reduce((sum, [gross]) => sum + gross, 0),
    discountMinor: 0,
    medicine: { rx: false, restricted: false, controlled: false },
    allocations: lots.map(([gross, cost], index) => ({
      id: `${id}_a${index}`,
      canonicalUnits: 1,
      grossMinor: gross,
      discountMinor: 0,
      lot: { unitCostMinor: cost },
    })),
    ...extra,
  };
}

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof BillDiscountRefused) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('largest remainder (DEV-956)', () => {
  it('adds up to the paisa and gives the leftover to the largest remainders, ties to the first', () => {
    expect(largestRemainder(101, [300, 333])).toEqual([48, 53]);
    expect(largestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(largestRemainder(0, [5, 5])).toEqual([0, 0]);
    expect(largestRemainder(7, [0, 0])).toEqual([0, 0]);
  });

  it('stays exact past 2^53 intermediate products', () => {
    const shares = largestRemainder(1_999_999_999, [999_999_937, 1_000_000_007, 3]);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(1_999_999_999);
    expect(shares.every(Number.isSafeInteger)).toBe(true);
  });

  it('moves what a capped share cannot take onto the others, never past any cap', () => {
    const shares = cappedLargestRemainder(300, [100, 100, 100], [10, 500, 500]);
    expect(shares).toEqual([10, 145, 145]);
    expect(() => cappedLargestRemainder(31, [1, 1], [10, 20])).toThrow(RangeError);
  });
});

describe('planBillDiscount (DEV-956)', () => {
  it('shares an amount over the lines by price, exactly, and each lot by its own room', () => {
    const a = line([
      [100, 50],
      [200, 50],
    ]);
    const b = line([[333, 100]]);
    const plan = planBillDiscount([b, a], { kind: 'AMOUNT', minor: 101 }, NO_LIMITS);
    expect(plan.totalMinor).toBe(101);
    expect(plan.shares).toEqual([
      {
        saleLineId: a.id,
        discountMinor: 48,
        allocations: { [`${a.id}_a0`]: 12, [`${a.id}_a1`]: 36 },
      },
      { saleLineId: b.id, discountMinor: 53, allocations: { [`${b.id}_a0`]: 53 } },
    ]);
    expect(plan.shares.reduce((sum, share) => sum + share.discountMinor, 0)).toBe(101);
  });

  it('takes a percentage of the lines it can discount, rounded down', () => {
    const a = line([[300, 0]]);
    const b = line([[333, 0]]);
    const rx = line([[1000, 0]], { medicine: { rx: true, restricted: false, controlled: false } });
    const plan = planBillDiscount([a, b, rx], { kind: 'PERCENT', bps: 1000 }, NO_LIMITS);
    expect(plan).toMatchObject({ requestedMinor: 63, totalMinor: 63, eligibleGrossMinor: 633 });
    expect(plan.shares.map((share) => share.discountMinor)).toEqual([30, 33]);
    expect(plan.excluded).toEqual([{ saleLineId: rx.id, reason: 'REGULATED' }]);
  });

  it("keeps every line within the owner's maximum on its own price and moves the rest", () => {
    const small = line([[100, 0]]);
    const large = line([[900, 0]]);
    const limits = { minMarginBps: 0, maxDiscountBps: 2_000 };
    const plan = planBillDiscount([small, large], { kind: 'AMOUNT', minor: 200 }, limits);
    expect(plan.shares.map((share) => share.discountMinor)).toEqual([20, 180]);
    // The same request as a percentage above the maximum is refused outright.
    expect(
      refusal(() => planBillDiscount([small, large], { kind: 'PERCENT', bps: 2_001 }, limits))
        .reason
    ).toBe('DISCOUNT_ABOVE_MAXIMUM');
  });

  it('never takes a lot below its cost or the minimum margin, and refuses more than the bill can take', () => {
    const tight = line([
      [100, 95],
      [100, 10],
    ]);
    const other = line([[100, 50]]);
    const limits = { minMarginBps: 2_000, maxDiscountBps: 10_000 };
    // Lot floors at a 20% margin: ceil(95 / 0.8) = 119 (no room), ceil(10 / 0.8) = 13, so the
    // lots have 0 + 87 room. The whole line must also keep its margin on its total cost:
    // ceil(105 / 0.8) = 132, so line A takes at most 200 - 132 = 68. Line B: 100 - 63 = 37.
    const error = refusal(() =>
      planBillDiscount([tight, other], { kind: 'AMOUNT', minor: 106 }, limits)
    );
    expect(error.reason).toBe('ABOVE_LIMIT');
    expect(error.plan?.capacityMinor).toBe(68 + 37);
    const plan = planBillDiscount([tight, other], { kind: 'AMOUNT', minor: 105 }, limits);
    expect(plan.shares).toEqual([
      {
        saleLineId: tight.id,
        discountMinor: 68,
        allocations: { [`${tight.id}_a0`]: 0, [`${tight.id}_a1`]: 68 },
      },
      { saleLineId: other.id, discountMinor: 37, allocations: { [`${other.id}_a0`]: 37 } },
    ]);
    // Every planned share passes the same whole-line rule an item discount meets.
    for (const share of plan.shares) {
      const planned = [tight, other].find((candidate) => candidate.id === share.saleLineId)!;
      const cost = planned.allocations.reduce((sum, a) => sum + a.lot.unitCostMinor, 0);
      expect(planned.grossMinor - share.discountMinor).toBeGreaterThanOrEqual(
        Math.ceil((cost * 10_000) / 8_000)
      );
    }
  });

  it('leaves out, and names, every line that may not take a share', () => {
    const plain = line([[500, 100]]);
    const lines = [
      plain,
      line([[500, 100]], { medicine: { rx: false, restricted: true, controlled: false } }),
      line([[500, 100]], { medicine: { rx: false, restricted: false, controlled: true } }),
      // An item discount, a complimentary line, a voucher and an automatic promotion.
      line([[500, 100]], { discountMinor: 10, discountKind: 'DISCOUNT' }),
      line([[500, 100]], { discountMinor: 500, discountKind: 'COMPLIMENTARY' }),
      line([[500, 100]], { discountMinor: 50, discountKind: 'VOUCHER', voucherId: 'v' }),
      line([[500, 100]], { discountMinor: 25, discountKind: 'PROMOTION', promotionId: 'p' }),
      // A zero-amount promotion or voucher still priced the line by its own rule.
      line([[500, 100]], { promotionId: 'p0' }),
      line([[500, 100]], { discountMinor: 5, tierDiscountMinor: 5, tierName: 'Bronze' }),
      line([[500, 500]]),
      {
        ...line([[500, 100]]),
        allocations: [{ ...line([[500, 100]]).allocations[0]!, grossMinor: null }],
      },
    ];
    const plan = planBillDiscount(lines, { kind: 'AMOUNT', minor: 40 }, NO_LIMITS);
    expect(plan.shares.map((share) => [share.saleLineId, share.discountMinor])).toEqual([
      [plain.id, 40],
    ]);
    expect(plan.excluded.map((entry) => entry.reason)).toEqual([
      'REGULATED',
      'REGULATED',
      'OWN_DISCOUNT',
      'OWN_DISCOUNT',
      'OWN_DISCOUNT',
      'OWN_DISCOUNT',
      'OWN_DISCOUNT',
      'TIER_PRICED',
      'AT_FLOOR',
      'UNPRICED',
    ]);
  });

  it('replaces a line’s earlier bill share instead of adding to it', () => {
    const shared = line([[300, 0]], {
      discountMinor: 30,
      billDiscountMinor: 30,
      discountKind: 'DISCOUNT',
    });
    expect(billDiscountExclusion(shared)).toBeNull();
    const plan = planBillDiscount([shared], { kind: 'AMOUNT', minor: 300 }, NO_LIMITS);
    expect(plan.shares[0]!.discountMinor).toBe(300);
  });

  it('plans a removal for zero, and refuses a discount that comes to nothing', () => {
    const a = line([[300, 0]]);
    expect(planBillDiscount([a], { kind: 'AMOUNT', minor: 0 }, NO_LIMITS).shares).toEqual([]);
    expect(planBillDiscount([a], { kind: 'PERCENT', bps: 0 }, NO_LIMITS).shares).toEqual([]);
    expect(
      refusal(() => planBillDiscount([a], { kind: 'PERCENT', bps: 1 }, NO_LIMITS)).reason
    ).toBe('NOTHING_TO_DISCOUNT');
    const rx = line([[300, 0]], { medicine: { rx: true, restricted: false, controlled: false } });
    expect(
      refusal(() => planBillDiscount([rx], { kind: 'AMOUNT', minor: 10 }, NO_LIMITS)).reason
    ).toBe('NOTHING_TO_DISCOUNT');
    // No maximum readable (0) means no discount at all, never an unlimited one.
    expect(
      refusal(() =>
        planBillDiscount([a], { kind: 'AMOUNT', minor: 1 }, { minMarginBps: 0, maxDiscountBps: 0 })
      ).reason
    ).toBe('NOTHING_TO_DISCOUNT');
    expect(
      refusal(() => planBillDiscount([a], { kind: 'AMOUNT', minor: -1 }, NO_LIMITS)).reason
    ).toBe('INVALID_REQUEST');
  });

  it('reads a lot share from the snapshot and ignores anything malformed', () => {
    expect(billAllocationDiscount({ a: 12 }, 'a')).toBe(12);
    for (const snapshot of [null, [], { a: -1 }, { a: 1.5 }, { a: '3' }])
      expect(billAllocationDiscount(snapshot, 'a')).toBe(0);
  });
});
