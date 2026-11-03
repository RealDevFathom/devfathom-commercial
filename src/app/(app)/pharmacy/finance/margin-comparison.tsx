import { reportMoney, reportDate, reportDayStart } from '@/lib/pharmacy/report-presentation';
import { workspaceToday } from '@/lib/timezone';
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
import type { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';

type Comparison = Awaited<ReturnType<ReturnType<typeof pharmacyFinanceRouter.createCaller>['marginComparison']>>;

export function MarginComparisonLedger({ report }: { report: Comparison }) {
  const money = (minor: number) => reportMoney(minor, report.currency);
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
      'Medicine costs (subtracted)',
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
        Previous: {reportDate(report.periods.previous.from, report.timezone)} to{' '}
        {reportDate(report.periods.previous.to, report.timezone)}. Current:{' '}
        {reportDate(report.periods.current.from, report.timezone)} to {reportDate(report.periods.current.to, report.timezone)}.{' '}
        {report.timezone}; start included, end excluded. Same branch, equal elapsed duration.
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
          Margin changes · {report.currency} · recorded revenue, discounts and medicine costs,
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
        Revenue change {money(report.revenueDeltaMinor)} minus discount change{' '}
        {money(report.discountDeltaMinor)} minus medicine cost change {money(report.cogsDeltaMinor)} ={' '}
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
  timezone = 'UTC',
}: {
  caller: ReturnType<typeof pharmacyFinanceRouter.createCaller>;
  branch: { id: string; name: string };
  from?: string;
  to?: string;
  ledgerFrom?: string;
  ledgerTo?: string;
  ledgerAt?: string;
  ledgerBy?: string;
  timezone?: string;
}) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 30 * 86_400_000);
  const fromDate = from ?? start.toISOString().slice(0, 10);
  const toDate = to ?? workspaceToday(timezone);
  let report: Comparison | undefined;
  let denied = false;
  try {
    report = await caller.marginComparison({
      branchId: branch.id,
      from: reportDayStart(fromDate, timezone).toISOString(),
      to: reportDayStart(toDate, timezone).toISOString(),
    });
  } catch (error) {
    denied =
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED');
  }
  return (
    <SectionCard title="Gross-margin comparison" titleLevel={2} eyebrow="Revenue · discounts · medicine costs">
      <p className="mb-4 text-sm text-text-muted">
        Branch: {branch.name}. Compare up to 92 days with the immediately preceding equal-length
        period.
      </p>
      <form action="/pharmacy/finance" method="get" className="mb-5 flex flex-wrap items-end gap-3">
        <input type="hidden" name="branch" value={branch.id} />
        {/* LedgerReportsSection owns defaults and validation, including invalid submissions. */}
        {Object.entries({ ledgerFrom, ledgerTo, ledgerAt, ledgerBy }).map(([name, value]) =>
          value !== undefined ? <input key={name} type="hidden" name={name} value={value} /> : null
        )}
        <label className="text-sm">
          Current start ({timezone})
          <Input
            className="mt-1 min-h-11"
            name="marginFrom"
            type="date"
            defaultValue={fromDate}
            required
          />
        </label>
        <label className="text-sm">
          Current end ({timezone}, excluded)
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
