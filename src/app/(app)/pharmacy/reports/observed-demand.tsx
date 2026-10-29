import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import type { demandAggregate } from '@/lib/pharmacy/sales';

type Demand = Awaited<ReturnType<typeof demandAggregate>>;

export function ObservedDemand({
  report,
  failed,
  selected,
  financial,
}: {
  report: Demand | null;
  failed: boolean;
  selected: boolean;
  financial: boolean;
}) {
  const events = report?.rows.reduce((total, row) => total + row._count._all, 0) ?? 0;
  const stockouts = report?.rows.filter((row) => row.reason === 'STOCKOUT') ?? [];
  const estimatedLossPkr =
    report?.rows.reduce((total, row) => total + Number(row._sum.estLossPkr ?? 0), 0) ?? 0;
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
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Recorded demand events" value={events} />
            <Stat
              label="Stockout events"
              value={stockouts.reduce((n, row) => n + row._count._all, 0)}
            />
            {financial ? (
              <Stat label="Estimated lost sales (PKR)" value={estimatedLossPkr.toFixed(2)} />
            ) : null}
          </div>
          {!events ? (
            <p className="mt-3 text-sm text-text-muted">
              No recorded events. This does not prove no unmet demand.
            </p>
          ) : null}
          <ul className="mt-4 space-y-2 text-sm text-text-body">
            {report.rows.slice(0, 10).map((row, index) => (
              <li key={index}>
                {row.requestedMedicineId ?? 'Unresolved item'} · {row.reason} · {row._count._all}{' '}
                events · {row._sum.quantity ?? 'Unknown'} requested units ·{' '}
                {row.visitType ?? 'Legacy'}
                {' / '}
                {row.outcome}
                {financial ? (
                  <>
                    {' '}
                    · estimated value{' '}
                    {row._sum.estimatedValueMinor == null
                      ? 'unavailable'
                      : `${(row._sum.estimatedValueMinor / 100).toFixed(2)} (currency unknown)`}
                    {' · estimated loss PKR '}
                    {Number(row._sum.estLossPkr ?? 0).toFixed(2)}
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
