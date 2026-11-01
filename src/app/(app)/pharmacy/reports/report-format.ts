import { workspaceTimezone } from '@/lib/timezone';

const DAY_MS = 86_400_000;

function toDate(value: string | Date | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

const isUtcMidnight = (date: Date) =>
  date.getUTCHours() === 0 &&
  date.getUTCMinutes() === 0 &&
  date.getUTCSeconds() === 0 &&
  date.getUTCMilliseconds() === 0;

/** A stored instant as a readable date and time in the workspace's time zone. */
export function formatReportDateTime(
  value: string | Date | null | undefined,
  timeZone?: string | null
): string {
  const date = toDate(value);
  if (!date) return 'Not available';
  return new Intl.DateTimeFormat('en-PK', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: workspaceTimezone(timeZone),
  }).format(date);
}

/** A business date (`YYYY-MM-DD`) or a UTC-midnight instant as a readable calendar date. */
export function formatReportDate(value: string | Date | null | undefined): string {
  const date =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? toDate(`${value}T00:00:00.000Z`)
      : toDate(value);
  if (!date) return 'Not available';
  return new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

/** An inclusive date range, e.g. "26-Oct-2026 to 01-Nov-2026". */
export function formatReportPeriod(from: string, to: string): string {
  return from === to
    ? formatReportDate(from)
    : `${formatReportDate(from)} to ${formatReportDate(to)}`;
}

/**
 * A source window whose end is exclusive. Whole-day windows read as inclusive
 * calendar dates; any other window reads as date-and-time instants.
 */
export function formatReportWindow(
  from: string | Date,
  toExclusive: string | Date,
  timeZone?: string | null
): string {
  const start = toDate(from);
  const end = toDate(toExclusive);
  if (!start || !end) return 'Not available';
  if (isUtcMidnight(start) && isUtcMidnight(end) && end.getTime() > start.getTime()) {
    const last = new Date(end.getTime() - DAY_MS);
    return last.getTime() === start.getTime()
      ? formatReportDate(start)
      : `${formatReportDate(start)} to ${formatReportDate(last)}`;
  }
  return `${formatReportDateTime(start, timeZone)} to ${formatReportDateTime(end, timeZone)}`;
}

/** A data age in seconds as minutes, hours or days, e.g. "45 min", "3 h", "2 days". */
export function formatReportAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** Plain wording for how complete a report section is known to be. */
export function coverageLabel(status: 'partial' | 'unknown' | string): string {
  if (status === 'partial') return 'Some data missing';
  if (status === 'unknown') return 'May be incomplete';
  return status;
}

/** Plain wording for the "scope" a metric is read in. */
export function reportScopeLabel(scope: string): string {
  const labels: Record<string, string> = {
    'selected branches and business dates': 'Selected branches and dates',
    'selected branches and UTC posting dates': 'Selected branches and posting dates',
    'selected branches at read time': 'Selected branches, as of now',
    'selected branches and event creation dates': 'Selected branches and dates',
    organization: 'Whole business',
    'not asserted': 'Not shown in this report',
  };
  return labels[scope] ?? scope.charAt(0).toUpperCase() + scope.slice(1);
}

/** Owner-facing descriptions for report catalog metrics. Falls back to the stored definition. */
const METRIC_DESCRIPTIONS: Record<string, string> = {
  salesMinor: 'Completed sales, after line discounts.',
  marginMinor:
    'Sales after discounts, minus the cost of the stock sold. Includes returns and reversals.',
  cashMinor: 'Cash taken, minus change given.',
  cashVarianceMinor: 'Cash counted at day close, compared with the cash expected.',
  refundsMinor: 'Refunds paid out in the selected period.',
  openStockSignals: 'Open low-stock, out-of-stock, expiry, recall and quarantine alerts.',
  recommendedOrders: 'Stock alerts that already have a purchase request linked.',
  expiryValueMinor30: 'Cost value of sellable stock that expires in the next 30 days.',
  expiryValueMinor60: 'Cost value of sellable stock that expires in the next 60 days.',
  expiryValueMinor90: 'Cost value of sellable stock that expires in the next 90 days.',
  expiryValueMinor180: 'Cost value of sellable stock that expires in the next 180 days.',
  openRecalls: 'Recall notices that are still open.',
  quarantineUnits: 'Units on hand that are quarantined or in blocked batches.',
  openClaims: 'Supplier claims that have not been submitted or released yet.',
  openReceivingExceptions:
    'Deliveries that did not match the order or invoice and are not resolved.',
  pharmacistCoverage: 'Branches with a current pharmacist on record.',
  safetyQueue: 'Pharmacist reviews waiting for sign-off, plus open controlled-drug incidents.',
};

export function metricDescription(key: string, fallback: string): string {
  return METRIC_DESCRIPTIONS[key] ?? fallback;
}
