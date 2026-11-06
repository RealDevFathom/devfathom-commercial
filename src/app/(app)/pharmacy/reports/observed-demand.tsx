import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import type { demandAggregate } from '@/lib/pharmacy/sales';
import type { loadLostDemandScopeAlerts } from '@/lib/pharmacy/lost-demand-procurement';
import Link from 'next/link';

type Demand = Awaited<ReturnType<typeof demandAggregate>>;
type Alerts = Awaited<ReturnType<typeof loadLostDemandScopeAlerts>>;

const triggerCopy = {
  REQUESTS: 'requests',
  ESTIMATED_LOSS: 'estimated loss',
  WALK_OUT_RATE: 'walk-out rate',
} as const;

export function ObservedDemand({
  report,
  alerts = null,
  failed,
  selected,
  financial,
}: {
  report: Demand | null;
  alerts?: Alerts | null;
  failed: boolean;
  selected: boolean;
  financial: boolean;
}) {
  const events = report?.rows.reduce((total, row) => total + row._count._all, 0) ?? 0;
  const stockouts = report?.rows.filter((row) => row.reason === 'STOCKOUT') ?? [];
  return (
    <SectionCard title="Observed unmet demand" titleLevel={2}>
      {!report ? (
        <p className="text-sm text-text-muted" role={failed ? 'alert' : 'status'}>
          {failed
            ? 'Demand unavailable. Access or the selected period could not be verified; retry.'
            : selected
              ? 'Demand unavailable for this branch or date range.'
              : 'Choose one authorized branch to view recorded customer requests.'}
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-text-muted">
            Explicit recorded requests, not unique customers or total market demand. Selected
            branch; UTC event dates {report.window.from.toISOString().slice(0, 10)} to{' '}
            {report.window.to.toISOString().slice(0, 10)} (end exclusive). Supplier, ingredient and
            batch filters do not apply. Events may subsequently be recovered; this is not an open
            backlog.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Stat label="Recorded demand events" value={events} />
            <Stat
              label="Stockout events"
              value={stockouts.reduce((n, row) => n + row._count._all, 0)}
            />
          </div>
          {alerts && alerts.alerts.length > 0 ? (
            <div className="mt-4 rounded-lg border border-border bg-surface-subtle p-4 text-sm">
              <p className="font-medium text-text-strong">Procurement review recommended</p>
              <p className="mt-1 text-text-muted">
                Trailing windows ending {alerts.at.toISOString().slice(0, 10)} UTC, independent of
                the selected period: requests over {alerts.config.requestWindowDays} days
                {financial ? `, estimated loss over ${alerts.config.lossWindowDays} days` : ''}.
                {alerts.walkOutRateEvaluated
                  ? ` Walk-out rate uses ${alerts.visits} explicitly recorded branch visits in the request window. Coverage depends on consistent counter capture.`
                  : ' Walk-out rate unavailable: no visits recorded in the request window.'}
              </p>
              <ul className="mt-2 space-y-1 text-text-body">
                {alerts.alerts.slice(0, 10).map((alert) => (
                  <li key={`${alert.scope}:${alert.key}`}>
                    {alert.scope === 'SKU'
                      ? alert.key
                      : `Same salt/strength (${alert.medicineIds.join(', ')})`}{' '}
                    · {alert.requests} requests
                    {financial && alert.estimatedLossMinor !== undefined
                      ? ` · estimated value ${(alert.estimatedLossMinor / 100).toFixed(2)} (currency unknown)`
                      : ''}{' '}
                    {alert.visits
                      ? ` · ${alert.walkOuts ?? 0}/${alert.visits} recorded visits walked out`
                      : ''}
                    · crossed{' '}
                    {alert.fired
                      .filter((trigger) => financial || trigger !== 'ESTIMATED_LOSS')
                      .map((trigger) => triggerCopy[trigger])
                      .join(', ')}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-text-muted">
                Review quantities, supplier terms, alternatives and surplus in Lost-demand
                procurement below. Actions require permission and a fresh PIN; drafts and decisions
                are audited.
              </p>
              <Link
                className="mt-3 inline-flex min-h-11 items-center font-medium text-primary hover:underline"
                href="/pharmacy/purchasing"
              >
                Review purchasing drafts
              </Link>
            </div>
          ) : null}
          {!events ? (
            <p className="mt-3 text-sm text-text-muted">
              No recorded events. This does not prove no unmet demand.
            </p>
          ) : null}
          <ul className="mt-4 space-y-2 text-sm text-text-body">
            {report.rows.slice(0, 10).map((row, index) => (
              <li key={index}>
                {row.requestedMedicineId ?? 'Unresolved item'} · {row.reason} · {row._count._all}{' '}
                events · {row._sum.quantity ?? 'Unknown'} requested units
                {financial ? (
                  <>
                    {' '}
                    · estimated value{' '}
                    {row._sum.estimatedValueMinor == null
                      ? 'unavailable'
                      : `${(row._sum.estimatedValueMinor / 100).toFixed(2)} (currency unknown)`}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-text-muted">
            Showing up to 10 item/reason groups; event counts include all groups. Units are recorded
            request quantities; no canonical pack conversion is evidenced, so quantities are not
            added across items. Estimate method: {report.method}. Estimates sum recorded non-null
            values; missing estimates are excluded, coverage is unknown. They are neither sales nor
            realized losses. Excludes {report.exclusions.join(', ')}. Confidence:{' '}
            {report.confidence}.
          </p>
        </>
      )}
    </SectionCard>
  );
}
