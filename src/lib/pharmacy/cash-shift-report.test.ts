import { describe, expect, it } from 'vitest';

import {
  cashShiftNeedsApproval,
  computeCashShiftFigures,
  sumCashShifts,
} from './cash-shift-report';

describe('DEV-958B cash shift figures', () => {
  it('expects the counted float plus cash in, less cash out, and never adds the float twice', () => {
    const figures = computeCashShiftFigures({
      openingFloatMinor: 10_000,
      tenders: [
        { type: 'CASH', amountMinor: 300, saleId: 'a' },
        { type: 'CARD', amountMinor: 450, saleId: 'b' },
        { type: 'CASH', amountMinor: 120, saleId: 'b' },
      ],
      refunds: [{ type: 'CASH', amountMinor: 70 }],
      movements: [
        // The first shift's float movement is the opening float itself.
        { kind: 'OPENING_FLOAT', amountMinor: 10_000 },
        { kind: 'CASH_SALE', amountMinor: 300 },
        { kind: 'CASH_SALE', amountMinor: 120 },
        { kind: 'CASH_REFUND', amountMinor: 70 },
        { kind: 'PAID_IN', amountMinor: 500 },
        { kind: 'PAID_OUT', amountMinor: 80 },
      ],
    });
    expect(figures.cash).toEqual({
      openingFloatMinor: 10_000,
      cashSalesMinor: 420,
      cashRefundsMinor: 70,
      paidInMinor: 500,
      paidOutMinor: 80,
      expectedMinor: 10_770,
    });
    expect(figures.tenders).toEqual([
      { type: 'CARD', count: 1, amountMinor: 450 },
      { type: 'CASH', count: 2, amountMinor: 420 },
    ]);
    expect(figures.salesCount).toBe(2);
    expect(figures.netTakenMinor).toBe(870 - 70);
  });

  it('refuses a figure that is not a whole amount', () => {
    expect(() =>
      computeCashShiftFigures({
        openingFloatMinor: 0,
        tenders: [{ type: 'CASH', amountMinor: 1.5, saleId: 'a' }],
        refunds: [],
        movements: [],
      })
    ).toThrow();
  });

  it('needs approval only above the tolerance, either way', () => {
    expect(cashShiftNeedsApproval(0, 0)).toBe(false);
    expect(cashShiftNeedsApproval(-1, 0)).toBe(true);
    expect(cashShiftNeedsApproval(1, 0)).toBe(true);
    expect(cashShiftNeedsApproval(-500, 500)).toBe(false);
    expect(cashShiftNeedsApproval(501, 500)).toBe(true);
    // A negative tolerance never loosens the rule.
    expect(cashShiftNeedsApproval(1, -10)).toBe(true);
  });

  it('adds the day up from its shifts: variances, handover differences and late arrivals', () => {
    // Float 1,000. Shift 1 takes 400 cash and counts 1,350 (short 50). Shift 2 counts 1,370 at
    // open (20 more than left), takes 200 cash and counts 1,570 (balanced). A late offline sale of
    // 100, sold in shift 1, arrives after it closed.
    const total = sumCashShifts(
      [
        {
          tenders: [{ type: 'CASH', count: 1, amountMinor: 400 }],
          refunds: [],
          varianceMinor: -50,
          openingDifferenceMinor: 0,
          status: 'CLOSED',
        },
        {
          tenders: [
            { type: 'CASH', count: 1, amountMinor: 200 },
            { type: 'CARD', count: 1, amountMinor: 900 },
          ],
          refunds: [{ type: 'CARD', count: 1, amountMinor: 100 }],
          varianceMinor: 0,
          openingDifferenceMinor: 20,
          status: 'CLOSED',
        },
      ],
      { tenders: [{ type: 'CASH', count: 1, amountMinor: 100 }], refunds: [], cashNetMinor: 100 }
    );
    expect(total.openShifts).toBe(0);
    expect(total.tenders).toEqual([
      { type: 'CARD', count: 1, amountMinor: 900 },
      { type: 'CASH', count: 3, amountMinor: 700 },
    ]);
    expect(total.refunds).toEqual([{ type: 'CARD', count: 1, amountMinor: 100 }]);
    // The drawer as the day close sees it: expected 1,000 float + 400 + 200 + 100 late = 1,700,
    // counted 1,570 on the last shift. Its variance, -130, is the shifts' -50, the handover's
    // +20, less the 100 of late cash no shift expected.
    expect(total.cashVarianceMinor).toBe(1_570 - 1_700);
  });

  it('counts an open shift as open and leaves its variance out', () => {
    const total = sumCashShifts(
      [
        {
          tenders: [],
          refunds: [],
          varianceMinor: null,
          openingDifferenceMinor: 30,
          status: 'OPEN',
        },
      ],
      { tenders: [], refunds: [], cashNetMinor: 0 }
    );
    expect(total).toMatchObject({ openShifts: 1, cashVarianceMinor: 0 });
  });
});
