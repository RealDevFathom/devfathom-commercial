import { SelectField as StudioSelect } from '@/components/ui/select-field';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { EMPTY_LEDGER_LABELS, type LedgerLabels } from '@/lib/pharmacy/finance-labels';
import type { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { plainReportSource } from '@/lib/pharmacy/report-labels';
import {
  pharmacyBusinessDay,
  pharmacyBusinessDayOffset,
  pharmacyBusinessDayRange,
  type PharmacyDayEnd,
} from '@/lib/pharmacy/business-day';
import { formatWorkspaceDateTime, workspaceZoneLabel } from '@/lib/timezone';

type Caller = Pick<
  ReturnType<typeof pharmacyFinanceRouter.createCaller>,
  'perpetualValuation' | 'grossMargin' | 'leakageReport'
>;
type Valuation = Awaited<ReturnType<Caller['perpetualValuation']>>;
type Margin = Awaited<ReturnType<Caller['grossMargin']>>;
type Leakage = Awaited<ReturnType<Caller['leakageReport']>>;
type TrueProfitCaller = Pick<ReturnType<typeof pharmacyFinanceRouter.createCaller>, 'trueProfit'>;
type TrueProfit = Awaited<ReturnType<TrueProfitCaller['trueProfit']>>;
type Report = Valuation | Margin | Leakage | TrueProfit;
type Group = Margin['by'];
const day = 86_400_000;
const groups: Group[] = ['line', 'batch', 'product', 'branch', 'productClass'];
const classLabels: Record<string, string> = {
  MEDICINE: 'Medicine',
  NON_DRUG_RETAIL: 'Non-drug retail',
};
type ProfitGroup = TrueProfit['by'];
const profitGroups: ProfitGroup[] = ['item', 'category', 'hour', 'staff'];
const profitGroupLabels: Record<ProfitGroup, string> = {
  item: 'Item',
  category: 'Category',
  hour: 'Sale hour',
  staff: 'Staff',
};
const unknown = 'Not recorded';
const groupLabels: Record<Group, string> = {
  line: 'Sale line',
  batch: 'Batch',
  product: 'Medicine',
  branch: 'Branch',
  productClass: 'Medicine vs non-drug',
};

/** Name for a ledger dimension id; raw ids are never the primary label. */
function named(map: Record<string, string> | undefined, id: string | null | undefined) {
  if (!id) return unknown;
  return map?.[id] ?? `Name not found (ref ${id})`;
}

function labelsOf(report: { labels?: LedgerLabels }): LedgerLabels {
  return report.labels ?? EMPTY_LEDGER_LABELS;
}

/** Workspace IANA zone (UTC when absent): picked days start at its midnight, times show on it. */
type Zone = string | null | undefined;

/**
 * The instant a picked day starts on the organisation's clock, as the ISO string the ledger
 * readers take. For a UTC organisation this is `YYYY-MM-DDT00:00:00.000Z`, exactly as before.
 */
export function ledgerDayStart(day: string, timeZone: Zone, dayEnd?: PharmacyDayEnd): string {
  // DEV-958A: the branch's business day, which starts at its "day ends at" hour (midnight
  // by default, exactly as before).
  return pharmacyBusinessDayRange(day, day, { timeZone, dayEnd }).from.toISOString();
}

// Guard the receipt formatter's invalid-number fallback: missing/unsafe money is never zero.
function money(value: number | bigint | null, currency: string | null) {
  if (value === null) return 'Unknown';
  if (
    typeof value === 'bigint' &&
    (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
  )
    return 'Unavailable (amount exceeds safe bounds)';
  const minor = Number(value);
  if (!Number.isSafeInteger(minor)) return 'Unavailable (invalid minor amount)';
  return `${currency ?? 'Currency unknown'} ${formatMinor(minor)}`;
}

function total(values: number[]): bigint | null {
  if (!values.every(Number.isSafeInteger)) return null;
  return values.reduce((sum, value) => sum + BigInt(value), BigInt(0));
}

function net(row: Margin['rows'][number]) {
  return total([row.revenueMinor, -row.discountMinor]);
}

/** Leakage header: the organisation's clock and no source or coverage jargon. */
function LeakageMetadata({
  report,
  branchName,
  timeZone,
}: {
  report: Leakage;
  branchName: string;
  timeZone: Zone;
}) {
  const at = (value: Date) => formatWorkspaceDateTime(value, timeZone);
  return (
    <div className="space-y-2 break-words text-sm text-text-muted">
      <p>
        From {at(report.period.from)} up to (not including) {at(report.period.to)}. Branch:{' '}
        {branchName}.
      </p>
      <p>
        {report.currency
          ? `Amounts in ${report.currency}${report.currencyStatus === 'organization_setting' ? ", your organization's currency setting" : ', the currency these entries were posted in'}.`
          : report.currencyStatus === 'mixed_posted_currencies'
            ? 'Currency unknown: these entries were posted in more than one currency, so totals are not labelled with one.'
            : 'Currency unknown: your organization has no currency setting.'}
      </p>
      <p>
        Built only from entries posted to the books. Refunds count only once they are posted as
        reversals. Retrieved {at(report.freshness.retrievedAt)}.
      </p>
    </div>
  );
}

function Metadata({
  report,
  branchName,
  timeZone,
}: {
  report: Report;
  branchName: string;
  timeZone: Zone;
}) {
  const at = (value: Date) => formatWorkspaceDateTime(value, timeZone);
  return (
    <div className="space-y-2 break-words text-sm text-text-muted">
      <p>
        {'at' in report.period
          ? `Stock value at ${at(report.period.at)}.`
          : `From ${at(report.period.from)} up to (not including) ${at(report.period.to)}.`}{' '}
        Branch: {branchName}.
      </p>
      <p>
        {report.currency
          ? `Amounts in ${report.currency}${report.currencyStatus === 'organization_setting' ? ", your organization's currency setting" : ', the currency these entries were posted in'}.`
          : report.currencyStatus === 'mixed_posted_currencies'
            ? 'Currency unknown: these entries were posted in more than one currency, so totals are not labelled with one.'
            : 'Currency unknown: your organization has no currency setting.'}
      </p>
      <p>{report.definition}</p>
      <p>
        Built only from entries posted to the books (source:{' '}
        {plainReportSource(report.source) ?? 'posted accounts'}); completeness{' '}
        {report.coverage.completeness}. Refunds count only once they are posted as reversals.
      </p>
      <p>
        Retrieved: {at(report.freshness.retrievedAt)}. Latest posting:{' '}
        {report.freshness.latestPostingAt ? at(report.freshness.latestPostingAt) : 'unknown'}.
      </p>
      <StatusPill status="warning" label={`Cost coverage: ${report.coverage.costCoverage}`} />
      <p>
        A missing cost is unknown, not zero. These figures may not cover every sale or stock
        movement.
      </p>
    </div>
  );
}

function LedgerTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: { label: string; numeric?: boolean }[];
  rows: ReactNode[][];
}) {
  if (!rows.length)
    return (
      <p role="status" className="text-sm text-text-muted">
        No matching posted ledger rows. This is not proof of zero activity or complete cost
        coverage. Try another period or branch.
      </p>
    );
  return (
    <Table>
      <caption className="py-2 text-left text-sm text-text-muted">
        {caption} · all returned groups shown
      </caption>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead key={column.label} scope="col" numeric={column.numeric}>
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={index} className="motion-reduce:transition-none">
            {row.map((cell, index) => (
              <TableCell key={index} numeric={columns[index].numeric}>
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ValuationLedger({
  report,
  branchName,
  timeZone,
}: {
  report: Valuation;
  branchName: string;
  timeZone?: Zone;
}) {
  const labels = labelsOf(report);
  const unallocated = BigInt(report.unallocatedValueMinor ?? 0);
  const lotTotal = total(report.rows.map((row) => row.valueMinor));
  const rows: ReactNode[][] = report.rows.map((row) => [
    named(labels.branches, row.branchId),
    row.lotId ? named(labels.lots, row.lotId) : unknown,
    named(labels.locations, row.locationId),
    money(row.unitCostMinor, report.currency),
    money(row.valueMinor, report.currency),
  ]);
  if (unallocated !== BigInt(0))
    rows.push([
      branchName,
      'Opening stock entered as one branch total (not split by batch)',
      unknown,
      money(null, report.currency),
      money(unallocated, report.currency),
    ]);
  return (
    <div className="min-w-0 space-y-4">
      <Metadata report={report} branchName={branchName} timeZone={timeZone} />
      {rows.length > 0 && (
        <Stat
          label="Posted inventory value"
          value={money(lotTotal === null ? null : lotTotal + unallocated, report.currency)}
          valueClassName="break-words text-xl"
          sub="Stock on hand plus stock in transit, at cost, up to the selected date."
        />
      )}
      {unallocated !== BigInt(0) && (
        <p role="note" className="text-sm text-text-body">
          Opening stock was entered as one branch total rather than batch by batch. Sales from those
          batches are still costed batch by batch, so a batch can show a negative value here; the
          opening stock row balances it and is included in the total.
        </p>
      )}
      <p className="text-sm text-text-body">
        This shows value, not whether stock can be sold: quarantined or in-transit stock is included
        and has not been checked for availability. Unit cost is the batch&apos;s current recorded
        cost, not a rebuilt historical cost.
      </p>
      <LedgerTable
        caption="Stock value by batch and location"
        columns={[
          { label: 'Branch' },
          { label: 'Medicine and batch' },
          { label: 'Location' },
          { label: 'Unit cost', numeric: true },
          { label: 'Value', numeric: true },
        ]}
        rows={rows}
      />
    </div>
  );
}

function marginKeyLabel(report: Margin, key: string | null) {
  const labels = labelsOf(report);
  if (report.by === 'batch')
    return key ? named(labels.batches, key) : 'Refunds not yet matched to a batch';
  if (report.by === 'product') return named(labels.medicines, key);
  if (report.by === 'branch') return named(labels.branches, key);
  // #718: medicine vs non-drug retail margin.
  if (report.by === 'productClass') return key ? (classLabels[key] ?? key) : unknown;
  return key ? `Sale line ref ${key}` : unknown;
}

export function MarginLedger({
  report,
  branchName,
  timeZone,
}: {
  report: Margin;
  branchName: string;
  timeZone?: Zone;
}) {
  const revenue = total(report.rows.flatMap((row) => [row.revenueMinor, -row.discountMinor]));
  const unmatchedReturns = report.by === 'batch' && report.rows.some((row) => row.key === null);
  return (
    <div className="min-w-0 space-y-4">
      <Metadata report={report} branchName={branchName} timeZone={timeZone} />
      {report.rows.length > 0 && (
        <div className="grid min-w-0 gap-5 md:grid-cols-3">
          <Stat
            label="Net ledger revenue"
            value={money(revenue, report.currency)}
            valueClassName="break-words text-xl"
            sub="Posted sales revenue less posted discounts; tax excluded."
          />
          <Stat
            label="Posted COGS"
            value={money(total(report.rows.map((row) => row.cogsMinor)), report.currency)}
            valueClassName="break-words text-xl"
            sub="Posted lot costs; unposted costs remain unknown."
          />
          <Stat
            label="Ledger gross margin"
            value={money(total(report.rows.map((row) => row.grossMarginMinor)), report.currency)}
            valueClassName="break-words text-xl"
            sub="Net ledger revenue less posted COGS; not net profit or cash flow."
          />
        </div>
      )}
      <p role="status" className="text-sm text-text-body">
        We can&apos;t tell how much cost is missing. Missing or unposted costs make margin look
        higher than it is. Today&apos;s purchase prices are never used in place of the cost recorded
        at sale.
      </p>
      {unmatchedReturns && (
        <p role="note" className="text-sm text-text-body">
          Refunds not yet matched to a batch: returned packs whose batch was not identified. Their
          sale value is taken back, but their cost stays on the original batch until the pack is
          identified, so this row shows negative revenue with no cost.
        </p>
      )}
      <LedgerTable
        caption={`Gross margin by ${groupLabels[report.by].toLowerCase()}`}
        columns={[
          { label: groupLabels[report.by] },
          { label: 'Gross revenue', numeric: true },
          { label: 'Discounts', numeric: true },
          { label: 'Net revenue', numeric: true },
          { label: 'Posted COGS', numeric: true },
          { label: 'Gross margin', numeric: true },
        ]}
        rows={report.rows.map((row) => [
          marginKeyLabel(report, row.key),
          money(row.revenueMinor, report.currency),
          money(row.discountMinor, report.currency),
          money(net(row), report.currency),
          money(row.cogsMinor, report.currency),
          money(row.grossMarginMinor, report.currency),
        ])}
      />
    </div>
  );
}

export function LeakageLedger({
  report,
  branchName,
  timeZone,
}: {
  report: Leakage;
  branchName: string;
  timeZone?: Zone;
}) {
  const labels = labelsOf(report);
  return (
    <div className="min-w-0 space-y-4">
      <LeakageMetadata report={report} branchName={branchName} timeZone={timeZone} />
      <p className="text-sm text-text-body">
        Counts discounts given, stock written off, and stock lost or found. Stock found offsets
        stock lost. Discounts are business choices, so these totals are not all lost money. Expired
        stock and the reasons for changes are not worked out here.
      </p>
      <LedgerTable
        caption="Recorded leakage by branch and product"
        columns={[
          { label: 'Branch' },
          { label: 'Medicine' },
          { label: 'Discounts', numeric: true },
          { label: 'Write-offs', numeric: true },
          { label: 'Signed shrinkage', numeric: true },
          { label: 'Recorded total', numeric: true },
        ]}
        rows={report.rows.map((row) => [
          named(labels.branches, row.branchId),
          named(labels.medicines, row.medicineId),
          money(row.discountMinor, report.currency),
          money(row.writeOffMinor, report.currency),
          money(row.shrinkageMinor, report.currency),
          money(row.totalMinor, report.currency),
        ])}
      />
    </div>
  );
}

function Failure({ error }: { error: unknown }) {
  const denied =
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED');
  return (
    <p role="alert" className="text-sm text-text-body">
      {denied
        ? 'Permission required: administrator financial and operational report access, with the Pharmacy reports module. Ask your organization administrator to review access.'
        : 'Ledger report unavailable. Retry using Apply ledger filters. No totals have been substituted and no financial data was changed.'}
    </p>
  );
}

export function LedgerReportsLoading() {
  return (
    <SectionCard title="Ledger reports" titleLevel={2}>
      <p role="status" className="text-sm text-text-muted">
        Loading valuation, margin and recorded leakage… No financial data is being changed.
      </p>
      <Button variant="secondary" disabled className="mt-4">
        Loading ledger reports
      </Button>
    </SectionCard>
  );
}

function dateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

/**
 * The readers refuse a window longer than 92 × 24 hours. Across a daylight-saving change 92
 * calendar days on the organisation's clock can be an hour longer, so the converted instants are
 * checked too and the filter error is shown instead of a refused read.
 */
function withinReaderLimit(start: string, end: string, timeZone: Zone, dayEnd?: PharmacyDayEnd) {
  return (
    Date.parse(ledgerDayStart(end, timeZone, dayEnd)) -
      Date.parse(ledgerDayStart(start, timeZone, dayEnd)) <=
    92 * day
  );
}

export async function LedgerReportsSection({
  caller,
  branch,
  from,
  to,
  at,
  by,
  marginFrom,
  marginTo,
  profitBy,
  timeZone,
}: {
  caller: Caller;
  branch: { id: string; name: string; businessDayEndsAtHistory?: unknown };
  from?: string;
  to?: string;
  at?: string;
  by?: string;
  marginFrom?: string;
  marginTo?: string;
  profitBy?: string;
  /** Workspace IANA zone: picked days are the organisation's days (UTC when absent). */
  timeZone?: Zone;
}) {
  const now = new Date();
  // DEV-958A: picked days are the branch's business days, ending at its "day ends at" hour.
  const dayEnd = branch.businessDayEndsAtHistory;
  const today = pharmacyBusinessDay({ timeZone, dayEnd }, now);
  const end = to ?? today;
  const start = from ?? pharmacyBusinessDayOffset({ timeZone, dayEnd }, -30, now);
  const cutoff = at ?? today;
  const zone = workspaceZoneLabel(timeZone);
  const group = by ?? 'batch';
  const fromDate = dateOnly(start),
    toDate = dateOnly(end),
    atDate = dateOnly(cutoff);
  const periodValid =
    !!fromDate &&
    !!toDate &&
    toDate.getTime() > fromDate.getTime() &&
    toDate.getTime() - fromDate.getTime() <= 92 * day &&
    withinReaderLimit(start, end, timeZone, dayEnd);
  // The cutoff is the start of the picked day on the organisation's clock; it cannot be later
  // than now, so today is the latest day that can be picked.
  const atValid = !!atDate && Date.parse(ledgerDayStart(cutoff, timeZone, dayEnd)) <= now.getTime();
  const groupValid = groups.includes(group as Group);
  let results:
    | [PromiseSettledResult<Valuation>, PromiseSettledResult<Margin>, PromiseSettledResult<Leakage>]
    | undefined;
  if (periodValid && atValid && groupValid) {
    const period = {
      branchId: branch.id,
      from: ledgerDayStart(start, timeZone, dayEnd),
      to: ledgerDayStart(end, timeZone, dayEnd),
    };
    results = await Promise.allSettled([
      caller.perpetualValuation({
        branchId: branch.id,
        at: ledgerDayStart(cutoff, timeZone, dayEnd),
      }),
      caller.grossMargin({ ...period, by: group as Group }),
      caller.leakageReport(period),
    ]);
  }
  const invalid = !periodValid || !atValid || !groupValid;
  return (
    <section aria-label="Pharmacy ledger reports" className="min-w-0 space-y-6">
      <SectionCard title="Ledger reports" titleLevel={2} eyebrow="Valuation · margin · leakage">
        <p className="mb-4 break-words text-sm text-text-muted">
          Branch: {branch.name}. The period runs from midnight at the start of the first day up to
          midnight at the start of the end day, which is not included, for up to 92 days. Stock
          value is taken at midnight at the start of its own chosen day. Days and times are {zone}{' '}
          time.
        </p>
        <form
          action="/pharmacy/finance"
          method="get"
          className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-5"
        >
          <input type="hidden" name="branch" value={branch.id} />
          {marginFrom && <input type="hidden" name="marginFrom" value={marginFrom} />}
          {marginTo && <input type="hidden" name="marginTo" value={marginTo} />}
          {profitBy && <input type="hidden" name="profitBy" value={profitBy} />}
          {[
            {
              name: 'ledgerFrom',
              label: `Period start (midnight, ${zone})`,
              value: start,
              invalid: !periodValid,
            },
            {
              name: 'ledgerTo',
              label: `Period end (midnight, ${zone}, not included)`,
              value: end,
              invalid: !periodValid,
            },
            {
              name: 'ledgerAt',
              label: `Stock value at (midnight, ${zone})`,
              value: cutoff,
              invalid: !atValid,
            },
          ].map((field) => (
            <label key={field.name} className="min-w-0 text-sm text-text-body">
              {field.label}
              <Input
                className="mt-1 min-h-11"
                type="date"
                name={field.name}
                defaultValue={field.value}
                required
                max={field.name === 'ledgerAt' ? today : undefined}
                aria-invalid={field.invalid || undefined}
                aria-describedby={field.invalid ? 'ledger-filter-error' : undefined}
              />
            </label>
          ))}
          <label className="min-w-0 text-sm text-text-body">
            Margin grouping
            <StudioSelect
              name="ledgerBy"
              defaultValue={group}
              aria-invalid={!groupValid || undefined}
              aria-describedby={!groupValid ? 'ledger-filter-error' : undefined}
              className="mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {!groupValid && <option value={group}>Invalid grouping</option>}
              {groups.map((value) => (
                <option key={value} value={value}>
                  {groupLabels[value]}
                </option>
              ))}
            </StudioSelect>
          </label>
          <Button type="submit" variant="secondary" className="min-h-11 self-end">
            Apply ledger filters
          </Button>
        </form>
        {invalid && (
          <p id="ledger-filter-error" role="alert" className="mt-4 text-sm text-destructive">
            Choose real calendar dates with a period of 1–92 days, a valuation cutoff no later than
            today, and a listed margin grouping. No ledger queries ran. Submitted filters: {start}{' '}
            to {end}; cutoff {cutoff}; grouping {group}.
          </p>
        )}
      </SectionCard>
      {results && (
        <>
          <SectionCard title="Perpetual valuation" titleLevel={2}>
            {results[0].status === 'fulfilled' ? (
              <ValuationLedger
                timeZone={timeZone}
                report={results[0].value}
                branchName={branch.name}
              />
            ) : (
              <Failure error={results[0].reason} />
            )}
          </SectionCard>
          <SectionCard title="Ledger gross margin" titleLevel={2}>
            {results[1].status === 'fulfilled' ? (
              <MarginLedger
                timeZone={timeZone}
                report={results[1].value}
                branchName={branch.name}
              />
            ) : (
              <Failure error={results[1].reason} />
            )}
          </SectionCard>
          <SectionCard title="Recorded leakage" titleLevel={2}>
            {results[2].status === 'fulfilled' ? (
              <LeakageLedger
                timeZone={timeZone}
                report={results[2].value}
                branchName={branch.name}
              />
            ) : (
              <Failure error={results[2].reason} />
            )}
          </SectionCard>
        </>
      )}
    </section>
  );
}

function profitKey(row: TrueProfit['rows'][number], by: ProfitGroup) {
  if (row.key === null) return unknown;
  if (by === 'category')
    return row.key.charAt(0) + row.key.slice(1).toLowerCase().replace(/_/g, ' ');
  return row.label ? `${row.label} (${row.key})` : row.key;
}

export function TrueProfitLedger({
  report,
  branchName,
  timeZone,
}: {
  report: TrueProfit;
  branchName: string;
  timeZone?: Zone;
}) {
  const label = profitGroupLabels[report.by];
  return (
    <div className="min-w-0 space-y-4">
      <Metadata report={report} branchName={branchName} timeZone={timeZone} />
      {report.rows.length > 0 && (
        <div className="grid min-w-0 gap-5 md:grid-cols-3">
          <Stat
            label="Net ledger revenue"
            value={money(
              total(report.rows.flatMap((row) => [row.revenueMinor, -row.discountMinor])),
              report.currency
            )}
            valueClassName="break-words text-xl"
            sub="Posted sales revenue less posted discounts; tax excluded."
          />
          <Stat
            label="Landed COGS"
            value={money(total(report.rows.map((row) => row.cogsMinor)), report.currency)}
            valueClassName="break-words text-xl"
            sub="Lot cost with bonus units, freight and non-creditable tax spread in."
          />
          <Stat
            label="True profit"
            value={money(total(report.rows.map((row) => row.grossMarginMinor)), report.currency)}
            valueClassName="break-words text-xl"
            sub="Net ledger revenue less landed COGS; not net profit or cash flow."
          />
        </div>
      )}
      <p className="text-sm text-text-body">
        {report.by === 'hour' ? `Sale hours use ${report.hourTimezone} time. ` : ''}
        Returns stay with the hour and staff member of the original sale. Totals reconcile with the
        ledger gross margin for the same period.
      </p>
      <LedgerTable
        caption={`True profit grouped by ${label.toLowerCase()}`}
        columns={[
          { label },
          { label: 'Gross revenue', numeric: true },
          { label: 'Discounts', numeric: true },
          { label: 'Net revenue', numeric: true },
          { label: 'Landed COGS', numeric: true },
          { label: 'True profit', numeric: true },
        ]}
        rows={report.rows.map((row) => [
          profitKey(row, report.by),
          money(row.revenueMinor, report.currency),
          money(row.discountMinor, report.currency),
          money(net(row), report.currency),
          money(row.cogsMinor, report.currency),
          money(row.grossMarginMinor, report.currency),
        ])}
      />
    </div>
  );
}

export async function TrueProfitSection({
  caller,
  branch,
  from,
  to,
  by,
  preserved = {},
  timeZone,
}: {
  caller: TrueProfitCaller;
  branch: { id: string; name: string; businessDayEndsAtHistory?: unknown };
  from?: string;
  to?: string;
  by?: string;
  /** Other report filters on the page, carried through this form unchanged. */
  preserved?: Record<string, string | undefined>;
  /** Workspace IANA zone: picked days are the organisation's days (UTC when absent). */
  timeZone?: Zone;
}) {
  const now = new Date();
  // DEV-958A: picked days are the branch's business days, ending at its "day ends at" hour.
  const dayEnd = branch.businessDayEndsAtHistory;
  const end = to ?? pharmacyBusinessDay({ timeZone, dayEnd }, now);
  const start = from ?? pharmacyBusinessDayOffset({ timeZone, dayEnd }, -30, now);
  const group = by ?? 'item';
  const fromDate = dateOnly(start),
    toDate = dateOnly(end);
  const periodValid =
    !!fromDate &&
    !!toDate &&
    toDate.getTime() > fromDate.getTime() &&
    toDate.getTime() - fromDate.getTime() <= 92 * day &&
    withinReaderLimit(start, end, timeZone, dayEnd);
  const groupValid = profitGroups.includes(group as ProfitGroup);
  let result: PromiseSettledResult<TrueProfit> | undefined;
  if (periodValid && groupValid) {
    [result] = await Promise.allSettled([
      caller.trueProfit({
        branchId: branch.id,
        from: ledgerDayStart(start, timeZone, dayEnd),
        to: ledgerDayStart(end, timeZone, dayEnd),
        by: group as ProfitGroup,
      }),
    ]);
  }
  return (
    <SectionCard
      title="True profit"
      titleLevel={2}
      eyebrow="Landed cost · item · category · hour · staff"
    >
      <p className="mb-4 break-words text-sm text-text-muted">
        Branch: {branch.name}. Uses the ledger reporting period above, from {start} up to (not
        including) {end}, {workspaceZoneLabel(timeZone)} time. Cost is each lot&apos;s landed cost:
        invoice net plus non-creditable tax and freight, spread over paid and bonus units.
      </p>
      <form
        action="/pharmacy/finance"
        method="get"
        className="mb-4 grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <input type="hidden" name="branch" value={branch.id} />
        {Object.entries(preserved).map(([name, value]) =>
          value ? <input key={name} type="hidden" name={name} value={value} /> : null
        )}
        <label className="min-w-0 text-sm text-text-body">
          Profit grouping
          <StudioSelect
            name="profitBy"
            defaultValue={group}
            aria-invalid={!groupValid || undefined}
            aria-describedby={!groupValid ? 'profit-filter-error' : undefined}
            className="mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {!groupValid && <option value={group}>Invalid grouping</option>}
            {profitGroups.map((value) => (
              <option key={value} value={value}>
                {profitGroupLabels[value]}
              </option>
            ))}
          </StudioSelect>
        </label>
        <Button type="submit" variant="secondary" className="min-h-11 self-end">
          Apply profit grouping
        </Button>
      </form>
      {(!periodValid || !groupValid) && (
        <p id="profit-filter-error" role="alert" className="text-sm text-destructive">
          Choose a ledger period of 1–92 days and a listed profit grouping. No ledger query ran.
          Submitted: {start} to {end}; grouping {group}.
        </p>
      )}
      {result &&
        (result.status === 'fulfilled' ? (
          <TrueProfitLedger report={result.value} branchName={branch.name} timeZone={timeZone} />
        ) : (
          <Failure error={result.reason} />
        ))}
    </SectionCard>
  );
}
