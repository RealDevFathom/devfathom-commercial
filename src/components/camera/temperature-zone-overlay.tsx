import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import type { TemperatureZoneStatus } from '@/lib/pharmacy/temperature-log';

/** The slice of `temperatureZoneStatuses` the overlay needs, serialized. */
export type TemperatureZoneOverlayStatus = {
  status: TemperatureZoneStatus;
  minimumTemperatureC: number | null;
  maximumTemperatureC: number | null;
  latestRecordedAt: string | null;
  /** The newest reading, when the caller has it. */
  latestTemperatureC?: number | null;
};

const STATUS: Record<TemperatureZoneStatus, { label: string; tone: StatusTone }> = {
  IN_RANGE: { label: 'In range', tone: 'success' },
  OUT_OF_RANGE_PENDING: { label: 'Out of range', tone: 'warning' },
  EXCURSION: { label: 'Excursion', tone: 'danger' },
  UNMONITORED: { label: 'Unmonitored', tone: 'warning' },
  MONITORED: { label: 'Monitored', tone: 'neutral' },
};

const time = (value: string) =>
  new Intl.DateTimeFormat('en-PK', { timeStyle: 'short' }).format(new Date(value));

/**
 * CAM-3 live-view overlay for a COLD_CHAIN camera: the bound zone's current
 * state over the picture. Absent evidence reads as UNMONITORED, never as in
 * range, exactly as `deriveTemperatureZoneStatus` decides.
 */
export function TemperatureZoneOverlay({
  zoneName,
  zone,
}: {
  zoneName: string;
  zone: TemperatureZoneOverlayStatus | null;
}) {
  const status = STATUS[zone?.status ?? 'UNMONITORED'];
  const range =
    zone && zone.minimumTemperatureC !== null && zone.maximumTemperatureC !== null
      ? `${zone.minimumTemperatureC}–${zone.maximumTemperatureC} °C`
      : null;
  return (
    <div
      role="status"
      aria-label={`${zoneName} temperature: ${status.label}`}
      className="absolute inset-x-2 top-2 flex flex-wrap items-center gap-2 rounded-sm bg-surface-raised/90 px-2 py-1 text-xs text-text-strong shadow-sm"
    >
      <StatusPill status={status.label} tone={status.tone} />
      <span className="font-medium">{zoneName}</span>
      {zone?.latestTemperatureC != null && <span>{zone.latestTemperatureC} °C</span>}
      {range && <span className="text-text-muted">range {range}</span>}
      <span className="text-text-muted">
        {zone?.latestRecordedAt ? `read ${time(zone.latestRecordedAt)}` : 'no recent reading'}
      </span>
    </div>
  );
}
