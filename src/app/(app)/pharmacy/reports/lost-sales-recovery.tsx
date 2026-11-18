import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import type { readLostSalesRecovery } from '@/lib/pharmacy/lost-sales-recovery-report';
import { formatShopPeriod } from '@/lib/pharmacy/plain-language';

type Report = Awaited<ReturnType<typeof readLostSalesRecovery>>;
type Group = Report['byBranch'][number];

const ROW_LIMIT = 10;

function GroupTable({
  caption,
  heading,
  rows,
  money,
}: {
  caption: string;
  heading: string;
  rows: readonly Group[];
  money: (minor: number | null) => string;
}) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-text-strong">{caption}</h3>
      {!rows.length ? (
        <p className="mt-2 text-sm text-text-muted">No recorded demand in this scope.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Lost and recovered value by {heading.toLowerCase()}
            </caption>
            <thead className="font-mono text-xs uppercase text-text-muted">
              <tr>
                <th scope="col" className="p-2 text-left">
                  {heading}
                </th>
                {['Events', 'Est. lost', 'Recovered', 'Net'].map((label) => (
                  <th key={label} scope="col" className="p-2 text-right">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, ROW_LIMIT).map((row) => (
                <tr key={row.key} className="border-t border-border-subtle hover:bg-surface-sunken">
                  <th scope="row" className="p-2 text-left font-normal text-text-body">
                    {row.label}
                  </th>
                  <td className="p-2 text-right font-mono tabular-nums">{row.events}</td>
                  <td className="p-2 text-right font-mono tabular-nums">
                    {money(row.estimatedLostMinor)}
                  </td>
                  <td className="p-2 text-right font-mono tabular-nums">
                    {money(row.recoveredMinor)}
                  </td>
                  <td className="p-2 text-right font-mono tabular-nums">{money(row.netMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** DEV-79 owner view: estimated lost demand, recovered sales and the net still lost. */
export function LostSalesRecovery({
  report,
  money,
  financial,
}: {
  report: Report | null;
  money: (minor: number | null) => string;
  financial: boolean;
}) {
  return (
    <SectionCard title="Lost sales and recovery" titleLevel={2}>
      {!financial ? (
        <p className="text-sm text-text-muted">
          Financial report permission is required to view lost and recovered value.
        </p>
      ) : !report ? (
        <p className="text-sm text-text-muted" role="status">
          Lost-sales recovery unavailable for this date, branch or permission scope. No zero totals
          inferred.
        </p>
      ) : (
        <div className="space-y-5 text-sm">
          <p className="text-text-muted">
            Estimates for {formatShopPeriod(report.period.from, report.period.to)}. Recovery counts
            a receipted sale of the requested item at the branch within{' '}
            {report.policy.recoveryWindowDays} days of the back-in-stock notice; waiting requests
            expire after {report.policy.requestExpiryDays} days. Supplier, ingredient and batch
            filters do not apply.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Estimated lost" value={money(report.totals.estimatedLostMinor)} />
            <Stat label="Recovered" value={money(report.totals.recoveredMinor)} />
            <Stat label="Net still lost" value={money(report.totals.netMinor)} />
          </div>
          <p className="text-text-muted">
            {report.totals.events} recorded demand events; {report.totals.recoveredEvents}{' '}
            recovered; {report.missingEstimates} without an estimate.
            {report.truncated ? ' Scope exceeded the event limit; totals are partial.' : ''}
          </p>
          <div className="grid gap-6 lg:grid-cols-3">
            <GroupTable caption="By branch" heading="Branch" rows={report.byBranch} money={money} />
            <GroupTable caption="By salt" heading="Salt" rows={report.bySalt} money={money} />
            <GroupTable
              caption="By distributor"
              heading="Distributor"
              rows={report.byDistributor}
              money={money}
            />
          </div>
          <p className="text-text-muted">
            Showing up to {ROW_LIMIT} rows per view, ranked by net still lost.{' '}
            {report.definitions.salt} {report.definitions.distributor} {report.definitions.net}
          </p>
        </div>
      )}
    </SectionCard>
  );
}
