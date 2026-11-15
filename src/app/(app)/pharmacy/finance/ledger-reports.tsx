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
import type { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';

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
const groupLabels: Record<Group, string> = {
  line: 'Sale line',
  batch: 'Batch',
  product: 'Product',
  branch: 'Branch',
  productClass: 'Medicine vs non-drug',
};
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

function Metadata({ report }: { report: Report }) {
  return (
    <div className="space-y-2 break-words text-sm text-text-muted">
      <p>
        {'at' in report.period
          ? `Through ${report.period.at.toISOString()} (inclusive).`
          : `${report.period.from.toISOString()} to ${report.period.to.toISOString()} (start inclusive, end exclusive).`}{' '}
        Timezone: {report.timezone}. Branch: {report.scope.branchId}.
      </p>
      <p>
        Currency: {report.currency ?? 'unknown — not recorded by the ledger reader'}. Integer minor
        units displayed with two decimals.
      </p>
      <p>{report.definition}</p>
      <p>
        Source: {report.source}. Coverage: posted entries only; completeness{' '}
        {report.coverage.completeness}. Refunds included only when posted as reversals.
      </p>
      <p>
        Retrieved: {report.freshness.retrievedAt.toISOString()}. Latest posting:{' '}
        {report.freshness.latestPostingAt ?? 'unknown'}.
      </p>
      <StatusPill status="warning" label={`Cost coverage: ${report.coverage.costCoverage}`} />
      <p>
        Missing costs are unknown, not zero. These values do not establish complete business
        activity.
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

export function ValuationLedger({ report }: { report: Valuation }) {
  return (
    <div className="min-w-0 space-y-4">
      <Metadata report={report} />
      {report.rows.length > 0 && (
        <Stat
          label="Posted inventory value"
          value={money(total(report.rows.map((row) => row.valueMinor)), report.currency)}
          valueClassName="break-words text-xl"
          sub="Net inventory plus inventory in transit through the selected instant."
        />
      )}
      <p className="text-sm text-text-body">
        Disposition and usable quantity are not supplied by this reader. Valued stock must not be
        treated as usable or available to dispense; quarantine and transit availability are
        unverified. Lot unit cost is current metadata, not a historical cost reconstruction.
      </p>
      <LedgerTable
        caption="Perpetual valuation by lot and location"
        columns={[
          { label: 'Branch' },
          { label: 'Lot' },
          { label: 'Batch' },
          { label: 'Medicine' },
          { label: 'Location' },
          { label: 'Lot unit cost', numeric: true },
          { label: 'Ledger value', numeric: true },
        ]}
        rows={report.rows.map((row) => [
          row.branchId ?? unknown,
          row.lotId,
          row.manufacturingBatchId ?? unknown,
          row.medicineId ?? unknown,
          row.locationId ?? unknown,
          money(row.unitCostMinor, report.currency),
          money(row.valueMinor, report.currency),
        ])}
      />
    </div>
  );
}

export function MarginLedger({ report }: { report: Margin }) {
  const revenue = total(report.rows.flatMap((row) => [row.revenueMinor, -row.discountMinor]));
  return (
    <div className="min-w-0 space-y-4">
      <Metadata report={report} />
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
        Cost coverage cannot be quantified by this reader. Missing or unposted costs may overstate
        margin. Current purchase costs are not substituted for historical COGS.
      </p>
      <LedgerTable
        caption={`Gross margin grouped by ${groupLabels[report.by]}`}
        columns={[
          { label: groupLabels[report.by] },
          { label: 'Gross revenue', numeric: true },
          { label: 'Discounts', numeric: true },
          { label: 'Net revenue', numeric: true },
          { label: 'Posted COGS', numeric: true },
          { label: 'Gross margin', numeric: true },
        ]}
        rows={report.rows.map((row) => [
          row.key === null
            ? unknown
            : report.by === 'productClass'
              ? (classLabels[row.key] ?? row.key)
              : row.key,
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

export function LeakageLedger({ report }: { report: Leakage }) {
  return (
    <div className="min-w-0 space-y-4">
      <Metadata report={report} />
      <p className="text-sm text-text-body">
        Recorded categories only: discounts, write-offs and signed shrinkage. Stock found offsets
        stock lost. Discounts are commercial decisions; these totals are not all realized loss.
        Expiry exposure and reasons for changes are not inferred.
      </p>
      <LedgerTable
        caption="Recorded leakage by branch and product"
        columns={[
          { label: 'Branch' },
          { label: 'Product' },
          { label: 'Discounts', numeric: true },
          { label: 'Write-offs', numeric: true },
          { label: 'Signed shrinkage', numeric: true },
          { label: 'Recorded total', numeric: true },
        ]}
        rows={report.rows.map((row) => [
          row.branchId ?? unknown,
          row.medicineId ?? unknown,
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
}: {
  caller: Caller;
  branch: { id: string; name: string };
  from?: string;
  to?: string;
  at?: string;
  by?: string;
  marginFrom?: string;
  marginTo?: string;
  profitBy?: string;
}) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const end = to ?? today;
  const start =
    from ??
    new Date(new Date(`${today}T00:00:00Z`).getTime() - 30 * day).toISOString().slice(0, 10);
  const cutoff = at ?? today;
  const group = by ?? 'batch';
  const fromDate = dateOnly(start),
    toDate = dateOnly(end),
    atDate = dateOnly(cutoff);
  const periodValid =
    !!fromDate &&
    !!toDate &&
    toDate.getTime() > fromDate.getTime() &&
    toDate.getTime() - fromDate.getTime() <= 92 * day;
  const atValid = !!atDate && atDate.getTime() <= now.getTime();
  const groupValid = groups.includes(group as Group);
  let results:
    | [PromiseSettledResult<Valuation>, PromiseSettledResult<Margin>, PromiseSettledResult<Leakage>]
    | undefined;
  if (periodValid && atValid && groupValid) {
    const period = { branchId: branch.id, from: fromDate.toISOString(), to: toDate.toISOString() };
    results = await Promise.allSettled([
      caller.perpetualValuation({ branchId: branch.id, at: atDate.toISOString() }),
      caller.grossMargin({ ...period, by: group as Group }),
      caller.leakageReport(period),
    ]);
  }
  const invalid = !periodValid || !atValid || !groupValid;
  return (
    <section aria-label="Pharmacy ledger reports" className="min-w-0 space-y-6">
      <SectionCard title="Ledger reports" titleLevel={2} eyebrow="Valuation · margin · leakage">
        <p className="mb-4 break-words text-sm text-text-muted">
          Branch: {branch.name}. Reporting period uses UTC midnight, start inclusive and end
          exclusive, up to 92 days. Valuation uses its separate inclusive cutoff at UTC midnight.
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
              label: 'Period start (UTC)',
              value: start,
              invalid: !periodValid,
            },
            {
              name: 'ledgerTo',
              label: 'Period end (UTC, exclusive)',
              value: end,
              invalid: !periodValid,
            },
            {
              name: 'ledgerAt',
              label: 'Valuation cutoff (00:00 UTC)',
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
            <select
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
            </select>
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
              <ValuationLedger report={results[0].value} />
            ) : (
              <Failure error={results[0].reason} />
            )}
          </SectionCard>
          <SectionCard title="Ledger gross margin" titleLevel={2}>
            {results[1].status === 'fulfilled' ? (
              <MarginLedger report={results[1].value} />
            ) : (
              <Failure error={results[1].reason} />
            )}
          </SectionCard>
          <SectionCard title="Recorded leakage" titleLevel={2}>
            {results[2].status === 'fulfilled' ? (
              <LeakageLedger report={results[2].value} />
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

export function TrueProfitLedger({ report }: { report: TrueProfit }) {
  const label = profitGroupLabels[report.by];
  return (
    <div className="min-w-0 space-y-4">
      <Metadata report={report} />
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
}: {
  caller: TrueProfitCaller;
  branch: { id: string; name: string };
  from?: string;
  to?: string;
  by?: string;
  /** Other report filters on the page, carried through this form unchanged. */
  preserved?: Record<string, string | undefined>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const end = to ?? today;
  const start =
    from ??
    new Date(new Date(`${today}T00:00:00Z`).getTime() - 30 * day).toISOString().slice(0, 10);
  const group = by ?? 'item';
  const fromDate = dateOnly(start),
    toDate = dateOnly(end);
  const periodValid =
    !!fromDate &&
    !!toDate &&
    toDate.getTime() > fromDate.getTime() &&
    toDate.getTime() - fromDate.getTime() <= 92 * day;
  const groupValid = profitGroups.includes(group as ProfitGroup);
  let result: PromiseSettledResult<TrueProfit> | undefined;
  if (periodValid && groupValid) {
    [result] = await Promise.allSettled([
      caller.trueProfit({
        branchId: branch.id,
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
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
        Branch: {branch.name}. Uses the ledger reporting period above ({start} to {end}, UTC, end
        exclusive). Cost is each lot&apos;s landed cost: invoice net plus non-creditable tax and
        freight, spread over paid and bonus units.
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
          <select
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
          </select>
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
          <TrueProfitLedger report={result.value} />
        ) : (
          <Failure error={result.reason} />
        ))}
    </SectionCard>
  );
}
