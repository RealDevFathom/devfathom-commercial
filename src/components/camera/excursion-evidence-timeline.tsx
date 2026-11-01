import { StatusPill } from '@/components/ui/status-pill';
import type { ExcursionEvidenceView } from '@/lib/cameras/excursion-evidence';

const when = (value: string) =>
  new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );

const STATE: Record<ExcursionEvidenceView['status'], string> = {
  PENDING: 'Still requested; the camera job has not captured it yet.',
  CAPTURED: 'Still captured.',
  FAILED: 'No still was captured.',
  PURGED: 'Still cleared by the retention policy; the record is kept.',
};

/** CAM-3: the camera stills bound to temperature excursions, newest first. */
export function ExcursionEvidenceTimeline({
  entries,
  zoneNames,
}: {
  entries: ExcursionEvidenceView[];
  zoneNames: ReadonlyMap<string, string>;
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-text-muted">No out-of-range temperature readings with camera snapshots yet.</p>;
  }
  return (
    <ol aria-label="Excursion evidence" className="space-y-3">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="flex flex-wrap gap-3 rounded-[var(--radius-sm)] bg-surface-sunken p-3 text-sm"
        >
          {entry.image ? (
            // A private data: URL from the branch-scoped read; nothing to optimise.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt={`Camera still for the ${zoneNames.get(entry.temperatureZoneId) ?? 'zone'} excursion at ${when(entry.readingRecordedAt)}`}
              className="h-24 w-40 rounded-sm object-cover"
              src={entry.image}
            />
          ) : null}
          <div className="min-w-0 space-y-1">
            <p className="font-medium text-text-strong">
              {zoneNames.get(entry.temperatureZoneId) ?? 'Unknown zone'} ·{' '}
              {entry.readingTemperatureC} °C · {when(entry.readingRecordedAt)}
            </p>
            <StatusPill
              status={entry.status}
              tone={
                entry.status === 'CAPTURED'
                  ? 'success'
                  : entry.status === 'FAILED'
                    ? 'danger'
                    : 'neutral'
              }
            />
            <p className="text-text-muted">
              {STATE[entry.status]}
              {entry.failureReason ? ` (${entry.failureReason})` : ''}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
