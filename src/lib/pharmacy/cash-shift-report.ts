/**
 * DEV-958B: the figures of one cash shift on a drawer, worked out from the tenders, refunds and
 * drawer movements the database put in it. Pure, so the server freezes exactly what the screen
 * shows. Expected cash is the database's own rule (`pharmacy_cash_shift_expected`): the counted
 * opening float, plus cash sales and paid-in, less cash refunds and paid-out, in the shift. The
 * first shift's opening float is the drawer's float movement, so that movement is not added twice.
 */

export type CashShiftMovementKind =
  'OPENING_FLOAT' | 'CASH_SALE' | 'CASH_REFUND' | 'PAID_IN' | 'PAID_OUT' | 'CLOSING_COUNT';

export type CashShiftSource = {
  openingFloatMinor: number;
  tenders: readonly { type: string; amountMinor: number; saleId: string }[];
  refunds: readonly { type: string; amountMinor: number }[];
  movements: readonly { kind: CashShiftMovementKind | string; amountMinor: number }[];
};

export type CashShiftTypeTotal = { type: string; count: number; amountMinor: number };

export type CashShiftFigures = {
  tenders: CashShiftTypeTotal[];
  refunds: CashShiftTypeTotal[];
  salesCount: number;
  tenderTotalMinor: number;
  refundTotalMinor: number;
  netTakenMinor: number;
  cash: {
    openingFloatMinor: number;
    cashSalesMinor: number;
    cashRefundsMinor: number;
    paidInMinor: number;
    paidOutMinor: number;
    expectedMinor: number;
  };
};

function byType(rows: readonly { type: string; amountMinor: number }[]): CashShiftTypeTotal[] {
  const totals = new Map<string, CashShiftTypeTotal>();
  for (const row of rows) {
    const total = totals.get(row.type) ?? { type: row.type, count: 0, amountMinor: 0 };
    total.count += 1;
    total.amountMinor += row.amountMinor;
    totals.set(row.type, total);
  }
  return [...totals.values()].sort((a, b) => a.type.localeCompare(b.type));
}

function sum(rows: readonly { amountMinor: number }[]) {
  return rows.reduce((total, row) => total + row.amountMinor, 0);
}

function assertMinor(value: number) {
  if (!Number.isSafeInteger(value)) throw new Error('A shift figure is not a whole amount.');
}

export function computeCashShiftFigures(source: CashShiftSource): CashShiftFigures {
  assertMinor(source.openingFloatMinor);
  for (const row of [...source.tenders, ...source.refunds, ...source.movements])
    assertMinor(row.amountMinor);
  const kind = (k: string) => source.movements.filter((m) => m.kind === k);
  const cashSalesMinor = sum(kind('CASH_SALE'));
  const cashRefundsMinor = sum(kind('CASH_REFUND'));
  const paidInMinor = sum(kind('PAID_IN'));
  const paidOutMinor = sum(kind('PAID_OUT'));
  const tenderTotalMinor = sum(source.tenders);
  const refundTotalMinor = sum(source.refunds);
  return {
    tenders: byType(source.tenders),
    refunds: byType(source.refunds),
    salesCount: new Set(source.tenders.map((t) => t.saleId)).size,
    tenderTotalMinor,
    refundTotalMinor,
    netTakenMinor: tenderTotalMinor - refundTotalMinor,
    cash: {
      openingFloatMinor: source.openingFloatMinor,
      cashSalesMinor,
      cashRefundsMinor,
      paidInMinor,
      paidOutMinor,
      expectedMinor:
        source.openingFloatMinor + cashSalesMinor + paidInMinor - cashRefundsMinor - paidOutMinor,
    },
  };
}

/** The shift report frozen on the shift row at its close, and shown again from there. */
export type CashShiftReport = CashShiftFigures & {
  shiftId: string;
  sequence: number;
  drawerSessionId: string;
  deviceId: string;
  businessDate: string;
  cashier: { id: string; name: string | null };
  openedBy: { id: string; name: string | null };
  openedAt: string;
  openingDifferenceMinor: number;
  openingNote: string | null;
  closedBy: { id: string; name: string | null } | null;
  closedAt: string | null;
  countedMinor: number | null;
  varianceMinor: number | null;
  varianceNote: string | null;
  varianceApprovedBy: { id: string; name: string | null } | null;
  varianceApprovalPolicy: string | null;
  toleranceMinor: number;
};

/** Whether a shift's over or short needs a manager's approval at the close. */
export function cashShiftNeedsApproval(varianceMinor: number, toleranceMinor: number) {
  return Math.abs(varianceMinor) > Math.max(0, toleranceMinor);
}

/**
 * The day's figures from its shifts. On a drawer that runs shifts the day's tender totals are the
 * sum of its shifts' and of the late arrivals (offline sales replayed after their shift closed),
 * and its cash variance is the sum of the shift variances and handover differences, less the late
 * arrivals' cash, which the closed shift counted but never expected. Used by the close screen and
 * tested against the day close on a real database.
 */
export function sumCashShifts(
  shifts: readonly {
    tenders: readonly CashShiftTypeTotal[];
    refunds: readonly CashShiftTypeTotal[];
    varianceMinor: number | null;
    openingDifferenceMinor: number;
    status: 'OPEN' | 'CLOSED';
  }[],
  late: {
    tenders: readonly CashShiftTypeTotal[];
    refunds: readonly CashShiftTypeTotal[];
    cashNetMinor: number;
  }
) {
  const add = (lists: readonly (readonly CashShiftTypeTotal[])[]) => {
    const totals = new Map<string, CashShiftTypeTotal>();
    for (const list of lists)
      for (const row of list) {
        const total = totals.get(row.type) ?? { type: row.type, count: 0, amountMinor: 0 };
        total.count += row.count;
        total.amountMinor += row.amountMinor;
        totals.set(row.type, total);
      }
    return [...totals.values()].sort((a, b) => a.type.localeCompare(b.type));
  };
  const closed = shifts.filter((s) => s.status === 'CLOSED');
  return {
    openShifts: shifts.length - closed.length,
    tenders: add([...shifts.map((s) => s.tenders), late.tenders]),
    refunds: add([...shifts.map((s) => s.refunds), late.refunds]),
    cashVarianceMinor:
      closed.reduce((total, s) => total + (s.varianceMinor ?? 0) + s.openingDifferenceMinor, 0) -
      late.cashNetMinor,
  };
}
