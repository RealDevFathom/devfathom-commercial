/**
 * DEV-103: bounded, native-only accounts-payable aging.
 *
 * Only native AP invoices and their native settlements are read. A generic
 * bookkeeping transaction, a purchase invoice or a manual allocation is never
 * counted, so the view cannot be inflated or settled from outside the AP
 * commands.
 *
 * DEV-694: a manager-approved supplier credit-note set-off reduces the bill
 * from its approval instant until its reversal instant; a pending or rejected
 * request never does.
 *
 * Historical eligibility uses two business clocks and an inclusive as-of day:
 *   - the invoice clock: an invoice counts once its invoice date is on or
 *     before the as-of day, and stops counting once its reversal date is;
 *   - the payment clock: a settlement reduces the balance once its payment
 *     instant is on or before the as-of day, and stops once its reversal is.
 * Days past due are measured from the due date to the as-of day.
 *
 * DEV-694 owner decision: the read fetches every eligible invoice in pages of
 * AP_PAYABLES_PAGE_ROWS before any total is reported. It is bounded by a
 * ceiling, AP_AGING_MAX_INVOICES: a branch (or payee) above it is reported as
 * an incomplete view with NO rows and NO totals, never as a partial figure, and
 * the reader is asked to narrow the view by payee. The page, its CSV and the
 * payables drafts render the same view.
 */
import { pharmacyCalendarDay, pharmacyCalendarDayRange } from '@/lib/pharmacy/business-day';
import { formulaSafeCell } from '@/lib/pharmacy/reference-connectors';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { normalizePayeeKey, PharmacyApInvoiceError } from './ap-invoices';

/** Most invoices one view ages; above it the view is refused, never partial. */
export const AP_AGING_MAX_INVOICES = 10_000;
const DAY_MS = 86_400_000;
const EARLIEST = new Date('2000-01-01T00:00:00.000Z');

export const AP_AGING_BUCKETS = [
  'CURRENT',
  'DAYS_1_30',
  'DAYS_31_60',
  'DAYS_61_90',
  'DAYS_OVER_90',
] as const;
export type ApAgingBucket = (typeof AP_AGING_BUCKETS)[number];

export const AP_AGING_BUCKET_LABELS: Record<ApAgingBucket, string> = {
  CURRENT: 'Not yet due',
  DAYS_1_30: '1–30 days',
  DAYS_31_60: '31–60 days',
  DAYS_61_90: '61–90 days',
  DAYS_OVER_90: 'Over 90 days',
};

export function agingBucket(daysPastDue: number): ApAgingBucket {
  if (daysPastDue <= 0) return 'CURRENT';
  if (daysPastDue <= 30) return 'DAYS_1_30';
  if (daysPastDue <= 60) return 'DAYS_31_60';
  if (daysPastDue <= 90) return 'DAYS_61_90';
  return 'DAYS_OVER_90';
}

/**
 * The as-of calendar day (UTC midnight, for due-date arithmetic) and its exclusive
 * end instant: the start of the next day on the organization's clock.
 */
export function apAgingWindow(asOf: string, now: Date, timeZone?: string | null) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new PharmacyApInvoiceError('INVALID_DATE');
  const day = new Date(`${asOf}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== asOf) {
    throw new PharmacyApInvoiceError('INVALID_DATE');
  }
  const today = new Date(`${pharmacyCalendarDay(timeZone, now)}T00:00:00.000Z`);
  if (day < EARLIEST || day > today) throw new PharmacyApInvoiceError('INVALID_DATE');
  return { day, cutoff: pharmacyCalendarDayRange(asOf, asOf, timeZone).to };
}

export type ApAgingInvoiceInput = {
  id: string;
  reference: string;
  payeeName: string;
  supplierInvoiceRef: string;
  invoiceDate: Date;
  dueDate: Date;
  amountMinor: number;
  currency: string;
  status: string;
  reversedAt: Date | null;
  settlements: ReadonlyArray<{
    amountMinor: number;
    paidAt: Date;
    status: string;
    reversedAt: Date | null;
  }>;
  /** DEV-694: approved credit-note set-offs; each reduces the bill from its approval instant. */
  creditSetOffs?: ReadonlyArray<{
    amountMinor: number;
    decidedAt: Date | null;
    status?: string;
    reversedAt?: Date | null;
  }>;
};

export type ApAgingRow = {
  invoiceId: string;
  reference: string;
  payeeName: string;
  supplierInvoiceRef: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  amountMinor: number;
  paidMinor: number;
  /** DEV-694: approved supplier credit-note set-offs, never counted as payments. */
  setOffMinor: number;
  outstandingMinor: number;
  daysPastDue: number;
  bucket: ApAgingBucket;
};

export type ApAgingTotals = { currency: string } & Record<ApAgingBucket | 'TOTAL', number>;

export type ApAgingView = {
  asOf: string;
  complete: boolean;
  scannedInvoices: number;
  rows: ApAgingRow[];
  totals: ApAgingTotals[];
};

const before = (value: Date | null, cutoff: Date) => value !== null && value < cutoff;

/** Pure aging of already-read native invoices as of one inclusive day. */
export function computeApAging(
  invoices: readonly ApAgingInvoiceInput[],
  window: { day: Date; cutoff: Date },
  complete: boolean
): ApAgingView {
  const rows: ApAgingRow[] = [];
  for (const invoice of invoices) {
    if (invoice.invoiceDate > window.day) continue;
    if (invoice.status === 'REVERSED' && before(invoice.reversedAt, window.cutoff)) continue;
    const paidMinor = invoice.settlements
      .filter(
        (settlement) =>
          settlement.paidAt < window.cutoff &&
          !(settlement.status === 'REVERSED' && before(settlement.reversedAt, window.cutoff))
      )
      .reduce((sum, settlement) => sum + settlement.amountMinor, 0);
    const setOffMinor = (invoice.creditSetOffs ?? [])
      .filter(
        (setOff) =>
          before(setOff.decidedAt, window.cutoff) &&
          !(setOff.status === 'REVERSED' && before(setOff.reversedAt ?? null, window.cutoff))
      )
      .reduce((sum, setOff) => sum + setOff.amountMinor, 0);
    const outstandingMinor = invoice.amountMinor - paidMinor - setOffMinor;
    if (outstandingMinor <= 0) continue;
    const daysPastDue = Math.floor((window.day.getTime() - invoice.dueDate.getTime()) / DAY_MS);
    rows.push({
      invoiceId: invoice.id,
      reference: invoice.reference,
      payeeName: invoice.payeeName,
      supplierInvoiceRef: invoice.supplierInvoiceRef,
      invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
      dueDate: invoice.dueDate.toISOString().slice(0, 10),
      currency: invoice.currency,
      amountMinor: invoice.amountMinor,
      paidMinor,
      setOffMinor,
      outstandingMinor,
      daysPastDue,
      bucket: agingBucket(daysPastDue),
    });
  }
  rows.sort(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      a.reference.localeCompare(b.reference) ||
      a.invoiceId.localeCompare(b.invoiceId)
  );
  const totals = new Map<string, ApAgingTotals>();
  for (const row of rows) {
    const total =
      totals.get(row.currency) ??
      ({
        currency: row.currency,
        CURRENT: 0,
        DAYS_1_30: 0,
        DAYS_31_60: 0,
        DAYS_61_90: 0,
        DAYS_OVER_90: 0,
        TOTAL: 0,
      } satisfies ApAgingTotals);
    total[row.bucket] += row.outstandingMinor;
    total.TOTAL += row.outstandingMinor;
    totals.set(row.currency, total);
  }
  return {
    asOf: window.day.toISOString().slice(0, 10),
    complete,
    scannedInvoices: invoices.length,
    rows,
    totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

/** DEV-694 owner decision: 5,000 rows per page, every page before a total. */
export const AP_PAYABLES_PAGE_ROWS = 5_000;

/**
 * Reads every eligible native invoice, page by page, and ages them. Above
 * AP_AGING_MAX_INVOICES the view is incomplete and empty: no partial totals.
 * `payeeName` narrows the view to one payee (normalized name).
 */
export async function readApAging(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  asOf: string,
  now: Date = new Date(),
  timeZone?: string | null,
  options: { payeeName?: string } = {}
): Promise<ApAgingView> {
  const window = apAgingWindow(asOf, now, timeZone);
  const query = {
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      invoiceDate: { lt: new Date(window.day.getTime() + DAY_MS) },
      ...(options.payeeName ? { payeeKey: normalizePayeeKey(options.payeeName) } : {}),
      OR: [{ status: 'POSTED' as const }, { reversedAt: { gte: window.cutoff } }],
    },
    select: {
      id: true,
      reference: true,
      payeeName: true,
      supplierInvoiceRef: true,
      invoiceDate: true,
      dueDate: true,
      amountMinor: true,
      currency: true,
      status: true,
      reversedAt: true,
      settlements: {
        where: { paidAt: { lt: window.cutoff } },
        select: { amountMinor: true, paidAt: true, status: true, reversedAt: true },
      },
      creditSetOffs: {
        where: {
          status: { in: ['APPROVED' as const, 'REVERSED' as const] },
          decidedAt: { lt: window.cutoff },
        },
        select: { amountMinor: true, decidedAt: true, status: true, reversedAt: true },
      },
    },
    orderBy: [{ dueDate: 'asc' as const }, { id: 'asc' as const }],
  };
  const invoices = [];
  for (let cursor: string | undefined; ;) {
    const page = await db.pharmacyApInvoice.findMany({
      ...query,
      take: AP_PAYABLES_PAGE_ROWS,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    invoices.push(...page);
    if (invoices.length > AP_AGING_MAX_INVOICES) {
      // Refused, not truncated: an incomplete view carries no rows or totals.
      return {
        asOf: window.day.toISOString().slice(0, 10),
        complete: false,
        scannedInvoices: invoices.length,
        rows: [],
        totals: [],
      };
    }
    if (page.length < AP_PAYABLES_PAGE_ROWS) break;
    cursor = page[page.length - 1]!.id;
  }
  return computeApAging(invoices, window, true);
}

function csvCell(value: unknown) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trimStart();
  return `"${formulaSafeCell(normalized).replaceAll('"', '""')}"`;
}

/** The CSV of exactly the rows the page shows, with the view's completeness. */
export function apAgingCsv(view: ApAgingView, branchId: string) {
  const header = [
    'branch_id',
    'as_of_date',
    'view_complete',
    'reference',
    'payee',
    'supplier_invoice_ref',
    'invoice_date',
    'due_date',
    'days_past_due',
    'bucket',
    'currency',
    'invoice_amount_minor',
    'paid_minor',
    'outstanding_minor',
    'set_off_minor',
  ];
  return [
    header,
    ...view.rows.map((row) => [
      branchId,
      view.asOf,
      view.complete ? 'true' : 'false',
      row.reference,
      row.payeeName,
      row.supplierInvoiceRef,
      row.invoiceDate,
      row.dueDate,
      row.daysPastDue,
      row.bucket,
      row.currency,
      row.amountMinor,
      row.paidMinor,
      row.outstandingMinor,
      row.setOffMinor,
    ]),
  ]
    .map((line) => line.map(csvCell).join(','))
    .join('\r\n');
}
