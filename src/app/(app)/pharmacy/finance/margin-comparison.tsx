import { SHOP_SCREEN_COPY as screenCopy } from '@/lib/pharmacy/plain-language';
import { ReportDetails } from '@/components/pharmacy/report-details';
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
import {
  pharmacyBusinessDay,
  pharmacyBusinessDayOffset,
  pharmacyBusinessDayRange,
} from '@/lib/pharmacy/business-day';
import { formatWorkspaceDateTime, workspaceZoneLabel } from '@/lib/timezone';

type Comparison = Awaited<ReturnType<typeof grossMarginComparison>>;
const money = (minor: number) =>
  `${(minor / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (currency not confirmed)`;

export function MarginComparisonLedger({
  report,
  timeZone,
}: {
  report: Comparison;
  timeZone?: string | null;
}) {
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
      'Cost of goods (subtracted)',
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
      <ReportDetails>
        <p className="break-words text-sm text-text-muted">
          {screenCopy.marginComparison.previous}
          {formatWorkspaceDateTime(report.periods.previous.from, timeZone)}
          {screenCopy.marginComparison.to}{' '}
          {formatWorkspaceDateTime(report.periods.previous.to, timeZone)}
          {screenCopy.marginComparison.current}{' '}
          {formatWorkspaceDateTime(report.periods.current.from, timeZone)}
          {screenCopy.marginComparison.to}{' '}
          {formatWorkspaceDateTime(report.periods.current.to, timeZone)}
          {screenCopy.marginComparison.periodsAreStartInclusiveEndExclusiveSameBranch}
        </p>
      </ReportDetails>
      {!report.previous.hasEntries || !report.current.hasEntries ? (
        <p role="status" className="text-sm text-text-muted">
          {screenCopy.marginComparison.noMatchingPostedJournalGroupsIn}{' '}
          {!report.previous.hasEntries && !report.current.hasEntries
            ? 'either period'
            : !report.previous.hasEntries
              ? 'the previous period'
              : 'the current period'}
          {screenCopy.marginComparison.ledgerTotalsAreZeroForThatPeriodThis}
        </p>
      ) : null}
      <Table>
        <caption className="text-left text-sm text-text-muted">
          {
            screenCopy.marginComparison
              .accountingDecompositionCurrencyNotConfirmedPostedRevenueDiscounts
          }
        </caption>
        <TableHeader>
          <TableRow>
            <TableHead>{screenCopy.marginComparison.account}</TableHead>
            <TableHead className="text-right">{screenCopy.marginComparison.previous2}</TableHead>
            <TableHead className="text-right">{screenCopy.marginComparison.current2}</TableHead>
            <TableHead className="text-right">
              {screenCopy.marginComparison.effectOnGrossMargin}
            </TableHead>
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
        {screenCopy.marginComparison.revenueDelta}
        {money(report.revenueDeltaMinor)}
        {screenCopy.marginComparison.minusDiscountDelta} {money(report.discountDeltaMinor)}
        {screenCopy.marginComparison.minusCogsDelta}
        {money(report.cogsDeltaMinor)} = {money(report.reconciledMinor)}
        {screenCopy.marginComparison.grossMarginChange}
      </p>
      <ReportDetails>
        <p className="text-sm text-text-muted">
          {screenCopy.marginComparison.accountingDecompositionNotACausalPriceVolumeMix}
        </p>
      </ReportDetails>
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
  timeZone,
}: {
  caller: ReturnType<typeof pharmacyFinanceRouter.createCaller>;
  branch: { id: string; name: string; businessDayEndsAtHistory?: unknown };
  from?: string;
  to?: string;
  ledgerFrom?: string;
  ledgerTo?: string;
  ledgerAt?: string;
  ledgerBy?: string;
  profitBy?: string;
  /** Workspace IANA zone: picked dates start at its midnight (UTC when absent). */
  timeZone?: string | null;
}) {
  // DEV-958A: picked dates are the branch's business days, ending at its "day ends at" hour.
  const clock = { timeZone, dayEnd: branch.businessDayEndsAtHistory };
  const fromDate = from ?? pharmacyBusinessDayOffset(clock, -30);
  const toDate = to ?? pharmacyBusinessDay(clock);
  const zone = workspaceZoneLabel(timeZone);
  // A picked date starts when the branch's business day does (the workspace's midnight by
  // default), as the Reports page bounds its days.
  const dayStart = (day: string) =>
    pharmacyBusinessDayRange(day, day, clock).from.toISOString().replace('.000Z', 'Z');
  let report: Comparison | undefined;
  let denied = false;
  try {
    report = await caller.marginComparison({
      branchId: branch.id,
      from: dayStart(fromDate),
      to: dayStart(toDate),
    });
  } catch (error) {
    denied =
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED');
  }
  return (
    <SectionCard
      title={screenCopy.marginComparison.grossMarginComparison}
      titleLevel={2}
      eyebrow={screenCopy.marginComparison.marginChanges}
    >
      <p className="mb-4 text-sm text-text-muted">
        {screenCopy.marginComparison.branch}
        {branch.name}
        {screenCopy.marginComparison.compareUpTo92DaysWithTheImmediately}
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
          {screenCopy.marginComparison.fromMidnight}
          {zone}
          {screenCopy.marginComparison.closeZone}
          <Input
            className="mt-1 min-h-11"
            name="marginFrom"
            type="date"
            defaultValue={fromDate}
            required
          />
        </label>
        <label className="text-sm">
          {screenCopy.marginComparison.untilMidnight}
          {zone}
          {screenCopy.marginComparison.closeZoneNotIncluded}
          <Input
            className="mt-1 min-h-11"
            name="marginTo"
            type="date"
            defaultValue={toDate}
            required
          />
        </label>
        <Button type="submit" variant="secondary">
          {screenCopy.marginComparison.comparePeriods}
        </Button>
      </form>
      {report ? (
        <MarginComparisonLedger report={report} timeZone={timeZone} />
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
