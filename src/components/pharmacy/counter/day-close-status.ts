/**
 * Plain-language state for the day-close screen.
 *
 * The screen talks about two different things that both "open" and "close": a
 * cash drawer (a counter's till session, closed when its cash is counted) and
 * the business day (locked once by "Close and lock day"). They are worded
 * differently on purpose, so a counted drawer never reads "Closed" beside an
 * "Open day" badge as if the two disagreed.
 */

export type DayCloseDrawerState = {
  status: string;
  expectedMinor: number;
  countedMinor: number | null;
};

export type StatusTone = 'success' | 'warning' | 'neutral';

/** The badge for the business day: whether it has been locked yet. */
export function dayLockStatus(locked: boolean): { label: string; tone: StatusTone } {
  return locked
    ? { label: 'Day locked', tone: 'success' }
    : { label: 'Day not locked yet', tone: 'neutral' };
}

/** A drawer's state in words that cannot be confused with the day's lock. */
export function drawerStateLabel(status: string): string {
  return status === 'OPEN'
    ? 'Drawer still open: count its cash below'
    : 'Drawer already counted and closed at the counter';
}

/**
 * Whether any drawer's counted cash differs from its expected cash. A drawer
 * still waiting for a count is not a variance yet; a closed drawer without a
 * stored count reads as 0, as the server reads it.
 */
export function hasCashVariance(
  drawers: readonly DayCloseDrawerState[],
  countFor: (index: number) => number | null
): boolean {
  return drawers.some((d, i) => {
    const counted = d.status === 'OPEN' ? countFor(i) : (d.countedMinor ?? 0);
    return counted !== null && counted !== d.expectedMinor;
  });
}

/**
 * Every reason "Close and lock day" cannot be pressed yet, in the order the
 * operator meets them on the form. Empty means the day can be closed.
 */
export function closeBlockingReasons(input: {
  drawers: readonly DayCloseDrawerState[];
  /** The parsed count typed for the drawer at this position, or null. */
  countFor: (index: number) => number | null;
  note: string;
  confirmed: boolean;
}): string[] {
  const reasons: string[] = [];
  const uncounted = input.drawers
    .map((d, i) => (d.status === 'OPEN' && input.countFor(i) === null ? i + 1 : null))
    .filter((n): n is number => n !== null);
  if (uncounted.length === 1)
    reasons.push(`Drawer ${uncounted[0]} is still open: enter its counted cash.`);
  else if (uncounted.length > 1)
    reasons.push(
      `Drawers ${uncounted.join(', ')} are still open: enter the counted cash for each.`
    );
  if (hasCashVariance(input.drawers, input.countFor) && !input.note.trim())
    reasons.push('Counted cash differs from expected cash: write a variance note.');
  if (!input.confirmed) reasons.push('Tick the box confirming you have counted every drawer.');
  return reasons;
}

export type TenderTotalRow = {
  type: string;
  amountMinor: number;
  refundMinor: number;
  netMinor: number;
};

const PAYMENT_TYPE_LABELS: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  WALLET: 'Wallet',
  CREDIT: 'Credit (khata)',
  LOYALTY: 'Loyalty points',
  RAAST: 'Raast',
  JAZZCASH: 'JazzCash',
  EASYPAISA: 'Easypaisa',
};

export function paymentTypeLabel(type: string): string {
  return PAYMENT_TYPE_LABELS[type] ?? type;
}

/**
 * The headline summary beside cash: card, credit and returns are always shown,
 * so a zero is a visible zero rather than a missing line.
 */
export function paymentSummary(
  tenderTotals: readonly TenderTotalRow[],
  returnsMinor: number
): { label: string; amountMinor: number }[] {
  const received = (type: string) =>
    tenderTotals.find((row) => row.type === type)?.amountMinor ?? 0;
  return [
    { label: 'Cash received', amountMinor: received('CASH') },
    { label: 'Card received', amountMinor: received('CARD') },
    { label: 'Credit (khata) given', amountMinor: received('CREDIT') },
    { label: 'Returns refunded', amountMinor: returnsMinor },
  ];
}

/** True when nothing has been taken or moved on this business day yet. */
export function isQuietDay(input: {
  grossSalesMinor: number;
  refundTotalMinor: number;
  cashExpectedMinor: number;
  tenderTotals: readonly TenderTotalRow[];
}): boolean {
  return (
    input.grossSalesMinor === 0 &&
    input.refundTotalMinor === 0 &&
    input.cashExpectedMinor === 0 &&
    input.tenderTotals.every((row) => row.amountMinor === 0 && row.refundMinor === 0)
  );
}
