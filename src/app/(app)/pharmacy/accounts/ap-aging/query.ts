/** DEV-103: the aging page's query contract (branch + inclusive as-of day on the organization's clock). */
import { amountInputError, amountInputToMinor } from '@/lib/money-input';
import {
  AP_INVOICE_MAX_MINOR,
  apReversalCursorSchema,
  type ApReversalCursor,
} from '@/lib/pharmacy/accounts/ap-invoices-schema';
import { pharmacyCalendarDay } from '@/lib/pharmacy/business-day';

export type AgingQuery = {
  branch?: string | string[];
  asOf?: string | string[];
  /** DEV-694: optional payment-draft request. */
  payee?: string | string[];
  currency?: string | string[];
  budget?: string | string[];
  /** DEV-694: narrow the view to one payee. */
  payeeFilter?: string | string[];
  /** DEV-103: the reversal search (see `parseReversalSearch`). */
  rvPayee?: string | string[];
  rvRef?: string | string[];
  rvAmount?: string | string[];
  rvFrom?: string | string[];
  rvTo?: string | string[];
  /** DEV-967: the page of rows older, or newer, than one row (see `reversalCursorParam`). */
  rvOlder?: string | string[];
  rvNewer?: string | string[];
};

export function parseAgingQuery(
  query: AgingQuery,
  now: Date,
  timeZone?: string | null
): { branchId?: string; asOf: string; invalid?: boolean } {
  const asOfRaw = query.asOf;
  const asOf = asOfRaw === undefined ? pharmacyCalendarDay(timeZone, now) : typeof asOfRaw === 'string' ? asOfRaw : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf > pharmacyCalendarDay(timeZone, now) || asOf < '2000-01-01') {
    return { asOf: pharmacyCalendarDay(timeZone, now), invalid: true };
  }
  if (query.branch === undefined) return { asOf };
  if (typeof query.branch !== 'string') return { asOf, invalid: true };
  const branchId = query.branch.trim();
  if (!branchId || branchId.length > 128) return { asOf, invalid: true };
  return { branchId, asOf };
}

export type ReversalSearchField = 'payee' | 'reference' | 'amount' | 'from' | 'to';

/** DEV-967: the page turned to, if any: the rows older or newer than one row. */
export type ReversalPageCursor = { direction: 'older' | 'newer'; at: ApReversalCursor };

export type ReversalSearchQuery = {
  /** What the person typed, kept for the form after a refusal. */
  values: Record<ReversalSearchField, string>;
  errors: Partial<Record<ReversalSearchField, string>>;
  /** Absent on the newest page. */
  cursor?: ReversalPageCursor;
  /** The filters to send, only when every typed value is valid. */
  search?: {
    payee?: string;
    reference?: string;
    amountMinor?: number;
    from?: string;
    to?: string;
    older?: ApReversalCursor;
    newer?: ApReversalCursor;
  };
};

/** DEV-967: a cursor in a page link, `<invoice date instant>~<id>`. */
export function reversalCursorParam(cursor: ApReversalCursor) {
  return `${cursor.invoiceDate}~${cursor.id}`;
}

function parseReversalCursor(raw: string | string[] | undefined): ApReversalCursor | undefined {
  if (typeof raw !== 'string') return undefined;
  const split = raw.indexOf('~');
  if (split < 0) return undefined;
  const parsed = apReversalCursorSchema.safeParse({
    invoiceDate: raw.slice(0, split),
    id: raw.slice(split + 1),
  });
  return parsed.success && parsed.data.id === raw.slice(split + 1) ? parsed.data : undefined;
}

/** DEV-967: a malformed cursor, or one each way, starts again from the newest page. */
function parseReversalPage(query: AgingQuery): ReversalPageCursor | undefined {
  const older = parseReversalCursor(query.rvOlder);
  const newer = parseReversalCursor(query.rvNewer);
  if (query.rvOlder !== undefined && query.rvNewer !== undefined) return undefined;
  if (older) return { direction: 'older', at: older };
  if (newer) return { direction: 'newer', at: newer };
  return undefined;
}

const AMOUNT_RANGE = 'Enter an amount above 0 and at most 9,999,999.99.';

/**
 * DEV-103: the reversal search on the aging page. Text filters are trimmed and bounded; a typed
 * amount is read by `amountInputToMinor` (never through a float) and must be a positive invoice or
 * payment amount; days are calendar days on the shop's clock. Anything invalid is named on its
 * field and nothing is searched. The router validates every filter again.
 */
export function parseReversalSearch(query: AgingQuery): ReversalSearchQuery {
  const one = (value: string | string[] | undefined) =>
    typeof value === 'string' ? value.trim() : '';
  const values = {
    payee: one(query.rvPayee),
    reference: one(query.rvRef),
    amount: one(query.rvAmount),
    from: one(query.rvFrom),
    to: one(query.rvTo),
  };
  const errors: ReversalSearchQuery['errors'] = {};
  for (const [field, raw] of [
    ['payee', query.rvPayee],
    ['reference', query.rvRef],
    ['amount', query.rvAmount],
    ['from', query.rvFrom],
    ['to', query.rvTo],
  ] as const) {
    if (Array.isArray(raw)) errors[field] = 'Enter this only once.';
  }
  if (values.payee.length > 160) errors.payee = 'Use at most 160 characters.';
  if (values.reference.length > 80) errors.reference = 'Use at most 80 characters.';
  let amountMinor: number | undefined;
  const amount = amountInputToMinor(values.amount);
  if (amount.status === 'INVALID') errors.amount = amountInputError(amount.reason);
  else if (amount.status === 'OK') {
    if (amount.minor <= 0 || amount.minor > AP_INVOICE_MAX_MINOR) errors.amount = AMOUNT_RANGE;
    else amountMinor = amount.minor;
  }
  const day = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (values.from && !day(values.from)) errors.from = 'Choose a date.';
  if (values.to && !day(values.to)) errors.to = 'Choose a date.';
  if (!errors.from && !errors.to && values.from && values.to && values.from > values.to)
    errors.to = 'Choose a day on or after the from day.';
  const cursor = parseReversalPage(query);
  if (Object.keys(errors).length) return { values, errors, ...(cursor ? { cursor } : {}) };
  return {
    values,
    errors,
    ...(cursor ? { cursor } : {}),
    search: {
      ...(values.payee ? { payee: values.payee } : {}),
      ...(values.reference ? { reference: values.reference } : {}),
      ...(amountMinor !== undefined ? { amountMinor } : {}),
      ...(values.from ? { from: values.from } : {}),
      ...(values.to ? { to: values.to } : {}),
      ...(cursor?.direction === 'older' ? { older: cursor.at } : {}),
      ...(cursor?.direction === 'newer' ? { newer: cursor.at } : {}),
    },
  };
}
