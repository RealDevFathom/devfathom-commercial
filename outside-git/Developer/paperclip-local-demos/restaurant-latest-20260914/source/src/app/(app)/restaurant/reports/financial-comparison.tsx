import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { money } from '@/lib/restaurant/money';
import type {
  RestaurantFinancialComparison,
  RestaurantFinancialDriver,
} from '@/lib/restaurant/financial-comparison';

const labels: Record<RestaurantFinancialDriver, string> = {
  netSales: 'Settled net sales',
  grossSales: 'Gross sales',
  refundTotal: 'Refunds',
  discountTotal: 'Discounts',
  compTotal: 'Comps',
  cashVariance: 'Cash variance',
  cashExpected: 'Expected cash',
  cashCounted: 'Counted cash',
  taxTotal: 'Tax',
  serviceChargeTotal: 'Service charges',
  tipTotal: 'Tips',
  deliveryFeeSales: 'Delivery fees',
  deliveryFeeRefunds: 'Delivery fee refunds',
  voidTotal: 'Voids',
};

function amount(value: string | null, currency: string | null) {
  return value === null
    ? 'Unavailable'
    : `${currency ?? 'Currency unknown'} ${money(value).toFixed(2)}`;
}

export function FinancialComparison({
  report,
  canFinancial,
  posEnabled,
  failed,
  from,
  to,
  branchLabel,
  validationError,
}: {
  report: RestaurantFinancialComparison | null;
  canFinancial: boolean;
  posEnabled: boolean;
  failed: boolean;
  from: string;
  to: string;
  branchLabel: string;
  validationError?: string;
}) {
  const notice = !canFinancial
    ? 'Permission required: reports:financial is required.'
    : !posEnabled
      ? 'Restaurant POS is not included in this organization’s current package.'
      : validationError
        ? validationError
        : failed
          ? 'Financial data could not load. Apply the filters again to retry.'
          : !report
            ? 'No financial comparison is available for these filters.'
            : null;
  return (
    <SectionCard
      eyebrow="Closed-day finance · Maximum 45 days per period"
      title="Financial comparison"
      titleLevel={2}
    >
      <div className="space-y-4">
        <p className="break-words text-sm text-text-muted">
          Current period: {from} to {to} · Scope: {branchLabel}
        </p>
        {notice ? (
          <p
            className="rounded-md border border-dashed border-border-default px-5 py-8 text-sm text-text-muted"
            role={canFinancial && posEnabled && (failed || validationError) ? 'alert' : 'status'}
          >
            {notice}
          </p>
        ) : report ? (
          <>
            <p className="text-sm text-text-muted">
              Previous period: {report.periods.previous.from} to {report.periods.previous.to} ·{' '}
              {report.periods.daysPerPeriod} business days per period · Currency:{' '}
              {report.currency ?? 'Unknown'}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {(['current', 'previous'] as const).map((period) => (
                <div
                  key={period}
                  className="space-y-2 rounded-sm border border-border-subtle p-4 text-sm text-text-muted"
                >
                  <h3 className="font-medium capitalize text-text-strong">{period} coverage</h3>
                  <StatusPill
                    status={report.coverage[period].status.replaceAll('_', ' ')}
                    tone={report.coverage[period].status === 'CURRENT' ? 'success' : 'warning'}
                  />
                  <p>
                    {report.coverage[period].closedDayCount}/
                    {report.coverage[period].expectedDayCount} branch-days closed
                  </p>
                  <p>
                    {report.coverage[period].missingClosedDayCount} missing ·{' '}
                    {report.coverage[period].staleDayCount} stale ·{' '}
                    {report.coverage[period].unprojectedDayCount} unprojected ·{' '}
                    {report.coverage[period].correctedDayCount} corrected
                  </p>
                  <h4 className="font-medium text-text-strong">Cash-count coverage</h4>
                  <StatusPill
                    status={report.cashCountCoverage[period].status.replaceAll('_', ' ')}
                    tone={
                      report.cashCountCoverage[period].status === 'COMPLETE' ? 'success' : 'warning'
                    }
                  />
                  <p>
                    {report.cashCountCoverage[period].drawerSessionCount} drawer sessions ·{' '}
                    {report.cashCountCoverage[period].missingCountSessionCount} missing counts ·{' '}
                    {report.cashCountCoverage[period].unverifiedCloseSessionCount} unverified closes
                    {' · '}
                    {report.cashCountCoverage[period].mismatchedCloseDayCount} mismatched close days
                  </p>
                  <p>{report.cashCountCoverage[period].definition}</p>
                </div>
              ))}
            </div>
            {!report.coverage.current.closedDayCount || !report.coverage.previous.closedDayCount ? (
              <p role="status" className="text-sm text-text-muted">
                Insufficient data: one or both periods have no closed-day history. Missing history
                is not zero. Choose periods with closed days.
              </p>
            ) : null}
            <p className="text-sm text-text-muted">{report.coverageDefinition}</p>
            <div
              aria-label="Financial comparison drivers"
              className="max-w-full overflow-x-auto rounded-sm border border-border-subtle focus-visible:outline-2 focus-visible:outline-ring"
              role="region"
              tabIndex={0}
            >
              <table className="w-full min-w-[64rem] text-left text-sm">
                <caption className="sr-only">
                  Financial comparison for {branchLabel}: {report.periods.current.from} to{' '}
                  {report.periods.current.to} versus {report.periods.previous.from} to{' '}
                  {report.periods.previous.to}; {report.currency ?? 'currency unknown'}
                </caption>
                <thead className="bg-surface-sunken font-mono text-xs uppercase tracking-wider text-text-muted">
                  <tr>
                    <th scope="col" className="p-3">
                      Driver
                    </th>
                    <th scope="col" className="p-3 text-right">
                      Current
                    </th>
                    <th scope="col" className="p-3 text-right">
                      Previous
                    </th>
                    <th scope="col" className="p-3 text-right">
                      Absolute change
                    </th>
                    <th scope="col" className="p-3 text-right">
                      Change %
                    </th>
                    <th scope="col" className="p-3">
                      Definition
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(labels) as RestaurantFinancialDriver[]).map((key) => {
                    const driver = report.drivers[key];
                    return (
                      <tr
                        key={key}
                        className="border-t border-border-subtle hover:bg-surface-sunken"
                      >
                        <th scope="row" className="p-3 font-medium text-text-strong">
                          {labels[key]}
                        </th>
                        <td className="p-3 text-right tabular-nums">
                          {amount(driver.current, report.currency)}
                        </td>
                        <td className="p-3 text-right tabular-nums">
                          {amount(driver.previous, report.currency)}
                        </td>
                        <td className="p-3 text-right tabular-nums">
                          {amount(driver.absoluteChange, report.currency)}
                        </td>
                        <td className="p-3 text-right tabular-nums">
                          {driver.percentageChange === null
                            ? 'Unavailable — zero or missing baseline'
                            : `${driver.percentageChange}%`}
                        </td>
                        <td className="p-3 text-text-muted">{driver.definition}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-sm text-text-muted">{report.changeDefinition}</p>
            <div className="space-y-3 rounded-sm border border-border-subtle p-4">
              <h3 className="font-medium text-text-strong">Discount rate</h3>
              <dl className="grid gap-4 text-sm sm:grid-cols-3">
                {(['current', 'previous'] as const).map((period) => (
                  <div key={period}>
                    <dt className="capitalize text-text-muted">{period} discount rate</dt>
                    <dd className="tabular-nums text-text-strong">
                      {report.discountRate[period] === null
                        ? 'Unavailable'
                        : `${report.discountRate[period]}%`}
                    </dd>
                    {report.discountRate.unavailableReason[period] ? (
                      <dd className="text-text-muted">
                        {report.discountRate.unavailableReason[period]}
                      </dd>
                    ) : null}
                  </div>
                ))}
                <div>
                  <dt className="text-text-muted">Change in percentage points</dt>
                  <dd className="tabular-nums text-text-strong">
                    {report.discountRate.percentagePointChange === null
                      ? 'Unavailable'
                      : `${report.discountRate.percentagePointChange} percentage points`}
                  </dd>
                </div>
              </dl>
              <p className="text-sm text-text-muted">{report.discountRate.definition}</p>
              <p className="text-sm text-text-muted">{report.discountRate.changeDefinition}</p>
            </div>
            <p className="text-sm text-text-muted">
              These figures are not net profit. Paid-in cash is not sales. Missing cost coverage is
              not zero cost. Drivers describe recorded amounts, not causes.
            </p>
            <p className="text-sm text-text-muted">
              Refund-adjusted net sales unavailable:{' '}
              {report.refundAdjustedNetSalesUnavailableReason}
            </p>
            <div className="space-y-2 border-t border-border-subtle pt-4 text-sm text-text-muted">
              <p>Source: {report.source} · Decimal major currency units · Business-date periods</p>
              <p className="break-words">
                As of: {report.asOf} · Observed through: {report.observedThrough}
              </p>
              <p>{report.currencyBasis}</p>
              <p>{report.consistency.limitation}</p>
            </div>
          </>
        ) : null}
      </div>
    </SectionCard>
  );
}
