/**
 * DEV-958B: the figures of one cash shift on a drawer, worked out from the tenders, refunds and
 * drawer movements the database put in it. Pure, so the server freezes exactly what the screen
 * shows. Expected cash is the database's own rule (`pharmacy_cash_shift_expected`): the counted
 * opening float, plus cash sales and paid-in, less cash refunds and paid-out, in the shift. The
 * first shift's opening float is the drawer's float movement, so that movement is not added twice.
 */

export type CashShiftMovementKind =
  | 'REJECTED_OFFLINE_CASH'
  | 'OPENING_FLOAT'
  | 'CASH_SALE'
  | 'CASH_REFUND'
  | 'PAID_IN'
  | 'PAID_OUT'
  | 'CLOSING_COUNT';

export type CashShiftSource = {
  openingFloatMinor: number;
  tenders: readonly { type: string; amountMinor: number; saleId: string }[];
  refunds: readonly { type: string; amountMinor: number }[];
  movements: readonly { kind: CashShiftMovementKind | string; amountMinor: number }[];
  /** DEV-977B: the VOIDED payloads of bill lines changed or removed in the shift. */
  lineVoids?: readonly unknown[];
};

/**
 * DEV-977B: the value a line change or removal took off an open bill, as its VOIDED event records
 * it (`voidedMinor`), or null for any other void. The day's void evidence and the shift report
 * both count a line-change void by this one rule.
 */
export function lineChangeVoidMinor(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { cause, voidedMinor } = payload as { cause?: unknown; voidedMinor?: unknown };
  if (
    (cause === 'LINE_CHANGED' || cause === 'LINE_REMOVED') &&
    typeof voidedMinor === 'number' &&
    Number.isSafeInteger(voidedMinor) &&
    voidedMinor >= 0
  )
    return voidedMinor;
  return null;
}

/** DEV-977B: bill lines changed to fewer units or removed in a shift, and the value they took off. */
export type CashShiftLineVoids = { count: number; valueMinor: number };

export type CashShiftTypeTotal = { type: string; count: number; amountMinor: number };

export type CashShiftFigures = {
  tenders: CashShiftTypeTotal[];
  refunds: CashShiftTypeTotal[];
  salesCount: number;
  tenderTotalMinor: number;
  refundTotalMinor: number;
  netTakenMinor: number;
  /** Absent on a report frozen before line changes were counted. */
  lineVoids?: CashShiftLineVoids;
  cash: {
    openingFloatMinor: number;
    cashSalesMinor: number;
    cashRefundsMinor: number;
    rejectedOfflineCashMinor?: number;
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
  const rejectedOfflineCashMinor = sum(kind('REJECTED_OFFLINE_CASH'));
  const paidInMinor = sum(kind('PAID_IN'));
  const paidOutMinor = sum(kind('PAID_OUT'));
  const tenderTotalMinor = sum(source.tenders);
  const refundTotalMinor = sum(source.refunds);
  const lineVoidValues = (source.lineVoids ?? [])
    .map(lineChangeVoidMinor)
    .filter((value): value is number => value !== null);
  return {
    tenders: byType(source.tenders),
    refunds: byType(source.refunds),
    salesCount: new Set(source.tenders.map((t) => t.saleId)).size,
    tenderTotalMinor,
    refundTotalMinor,
    netTakenMinor: tenderTotalMinor - refundTotalMinor,
    lineVoids: {
      count: lineVoidValues.length,
      valueMinor: lineVoidValues.reduce((total, value) => total + value, 0),
    },
    cash: {
      openingFloatMinor: source.openingFloatMinor,
      cashSalesMinor,
      cashRefundsMinor,
      ...(rejectedOfflineCashMinor ? { rejectedOfflineCashMinor } : {}),
      paidInMinor,
      paidOutMinor,
      expectedMinor:
        source.openingFloatMinor +
        cashSalesMinor +
        rejectedOfflineCashMinor +
        paidInMinor -
        cashRefundsMinor -
        paidOutMinor,
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
    lineVoids?: CashShiftLineVoids;
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
    // DEV-977B: each line-change void is in the one shift it happened in, so this counts it once.
    lineVoids: shifts.reduce<CashShiftLineVoids>(
      (total, s) => ({
        count: total.count + (s.lineVoids?.count ?? 0),
        valueMinor: total.valueMinor + (s.lineVoids?.valueMinor ?? 0),
      }),
      { count: 0, valueMinor: 0 }
    ),
    cashVarianceMinor:
      closed.reduce((total, s) => total + (s.varianceMinor ?? 0) + s.openingDifferenceMinor, 0) -
      late.cashNetMinor,
  };
}
