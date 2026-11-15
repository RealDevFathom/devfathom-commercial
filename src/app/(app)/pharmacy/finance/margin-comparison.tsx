import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { grossMarginComparison } from '@/lib/pharmacy/finance-reports';
import type { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { formatUtcInstant } from '@/lib/utc-instant';

type Comparison = Awaited<ReturnType<typeof grossMarginComparison>>;
const money = (minor: number) =>
  `${(minor / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (currency unknown)`;

export function MarginComparisonLedger({ report }: { report: Comparison }) {
  const rows = [
    [
      'Revenue',
      report.previous.revenueMinor,
      report.current.revenueMinor,
      report.revenueDeltaMinor,
    ],
    [
      'Discounts (subtracted)',
      report.previous.discountMinor,
      report.current.discountMinor,
      -report.discountDeltaMinor,
    ],
    [
      'COGS (subtracted)',
      report.previous.cogsMinor,
      report.current.cogsMinor,
      -report.cogsDeltaMinor,
    ],
    [
      'Gross margin',
      report.previous.grossMarginMinor,
      report.current.grossMarginMinor,
      report.differenceMinor,
    ],
  ] as const;
  return (
    <div className="min-w-0 space-y-3">
      <p className="break-words text-sm text-text-muted">
        Previous: {formatUtcInstant(report.periods.previous.from)} to{' '}
        {formatUtcInstant(report.periods.previous.to)}. Current:{' '}
        {formatUtcInstant(report.periods.current.from)} to{' '}
        {formatUtcInstant(report.periods.current.to)}. Periods are start inclusive, end exclusive.
        Same branch, equal elapsed duration.
      </p>
      {!report.previous.hasEntries || !report.current.hasEntries ? (
        <p role="status" className="text-sm text-text-muted">
          No matching posted journal groups in{' '}
          {!report.previous.hasEntries && !report.current.hasEntries
            ? 'either period'
            : !report.previous.hasEntries
              ? 'the previous period'
              : 'the current period'}
          . Ledger totals are zero for that period; this does not prove complete source data.
        </p>
      ) : null}
      <Table>
        <caption className="text-left text-sm text-text-muted">
          Accounting decomposition · currency unknown · posted revenue, discounts and COGS,
          including reversals and returns recorded in the journal.
        </caption>
        <TableHeader>
          <TableRow>
            <TableHead>Ledger account</TableHead>
            <TableHead className="text-right">Previous</TableHead>
            <TableHead className="text-right">Current</TableHead>
            <TableHead className="text-right">Effect on gross margin</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([label, previous, current, effect]) => (
            <TableRow key={label}>
              <TableCell>{label}</TableCell>
              {[previous, current, effect].map((value, index) => (
                <TableCell key={index} className="text-right whitespace-nowrap tabular-nums">
                  {money(value)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-sm text-text-body">
        Revenue delta {money(report.revenueDeltaMinor)} minus discount delta{' '}
        {money(report.discountDeltaMinor)} minus COGS delta {money(report.cogsDeltaMinor)} ={' '}
        {money(report.reconciledMinor)} gross-margin change.
      </p>
      <p className="text-sm text-text-muted">
        Accounting decomposition, not a causal price/volume/mix explanation. Quantity, unit-price,
        unit-cost and expense evidence is not provided here; missing evidence is not zero. Gross
        margin is not net profit or contribution. Percentage change is omitted, including when the
        previous margin is zero or negative.
      </p>
    </div>
  );
}

export async function MarginComparisonSection({
  caller,
  branch,
  from,
  to,
  ledgerFrom,
  ledgerTo,
  ledgerAt,
  ledgerBy,
  profitBy,
}: {
  caller: ReturnType<typeof pharmacyFinanceRouter.createCaller>;
  branch: { id: string; name: string };
  from?: string;
  to?: string;
  ledgerFrom?: string;
  ledgerTo?: string;
  ledgerAt?: string;
  ledgerBy?: string;
  profitBy?: string;
}) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 30 * 86_400_000);
  const fromDate = from ?? start.toISOString().slice(0, 10);
  const toDate = to ?? end.toISOString().slice(0, 10);
  let report: Comparison | undefined;
  let denied = false;
  try {
    report = await caller.marginComparison({
      branchId: branch.id,
      from: `${fromDate}T00:00:00Z`,
      to: `${toDate}T00:00:00Z`,
    });
  } catch (error) {
    denied =
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED');
  }
  return (
    <SectionCard title="Gross-margin comparison" titleLevel={2} eyebrow="Accounting drivers">
      <p className="mb-4 text-sm text-text-muted">
        Branch: {branch.name}. Compare up to 92 days with the immediately preceding equal-length
        period.
      </p>
      <form action="/pharmacy/finance" method="get" className="mb-5 flex flex-wrap items-end gap-3">
        <input type="hidden" name="branch" value={branch.id} />
        {/* LedgerReportsSection owns defaults and validation, including invalid submissions. */}
        {Object.entries({ ledgerFrom, ledgerTo, ledgerAt, ledgerBy, profitBy }).map(
          ([name, value]) =>
            value !== undefined ? (
              <input key={name} type="hidden" name={name} value={value} />
            ) : null
        )}
        <label className="text-sm">
          Current start (UTC)
          <Input
            className="mt-1 min-h-11"
            name="marginFrom"
            type="date"
            defaultValue={fromDate}
            required
          />
        </label>
        <label className="text-sm">
          Current end (UTC, exclusive)
          <Input
            className="mt-1 min-h-11"
            name="marginTo"
            type="date"
            defaultValue={toDate}
            required
          />
        </label>
        <Button type="submit" variant="secondary">
          Compare periods
        </Button>
      </form>
      {report ? (
        <MarginComparisonLedger report={report} />
      ) : (
        <p role="alert" className="text-sm text-text-muted">
          {denied
            ? 'Permission required: owner financial-report access and the Pharmacy reports module.'
            : 'Comparison unavailable. Check the date range (1–92 days) and retry. Ledger totals could not be loaded; no zero totals have been substituted.'}
        </p>
      )}
    </SectionCard>
  );
}
