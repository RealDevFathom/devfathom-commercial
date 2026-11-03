import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import type { demandAggregate } from '@/lib/pharmacy/sales';
import { formatReportWindow } from './report-format';

type Demand = Awaited<ReturnType<typeof demandAggregate>>;
const reasonLabel = (reason: string) => {
  const words = reason.replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

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
  return (
    <SectionCard title="Unmet customer requests" titleLevel={2}>
      {!report ? (
        <p className="text-sm text-text-muted" role={failed ? 'alert' : 'status'}>
          {failed
            ? 'Customer requests could not load. Check the branch and dates, then try again.'
            : selected
              ? 'Customer requests are not available for this branch or date range.'
              : 'Choose a branch to see unmet customer requests.'}
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-text-muted">
            Requests staff recorded at the counter,{' '}
            {formatReportWindow(report.window.from, report.window.to)}. These are requests, not
            unique customers or total market demand, and some may have been filled later.
            Supplier, ingredient and batch filters do not apply.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Stat label="Recorded demand events" value={events} />
            <Stat
              label="Stockout events"
              value={stockouts.reduce((n, row) => n + row._count._all, 0)}
            />
          </div>
          {!events ? (
            <p className="mt-3 text-sm text-text-muted">
              No requests recorded. Customers may still have asked for items that were not logged.
            </p>
          ) : null}
          <ul className="mt-4 space-y-2 text-sm text-text-body">
            {report.rows.slice(0, 10).map((row, index) => (
              <li key={index}>
                {row.requestedMedicineId ?? 'Item not matched'} · {reasonLabel(row.reason)} ·{' '}
                {row._count._all} events · {row._sum.quantity ?? 'Unknown'} requested units
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
            Showing up to 10 item and reason groups; event counts include all of them. Quantities
            are as requested and are not added across items. Estimated values only add up requests
            that had a value, so coverage is unknown; they are not sales or losses. Not
            included: {report.exclusions.join(', ')}.
          </p>
        </>
      )}
    </SectionCard>
  );
}
