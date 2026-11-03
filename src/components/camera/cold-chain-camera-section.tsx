import { readExcursionEvidence } from '@/lib/cameras/excursion-evidence';
import { stillDataUrl } from '@/lib/pharmacy/counter-evidence';
import type { TemperatureZoneStatusResult } from '@/lib/pharmacy/temperature-log';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { CameraTile } from './camera-tile';
import { ExcursionEvidenceTimeline } from './excursion-evidence-timeline';
import { TemperatureZoneOverlay } from './temperature-zone-overlay';

/**
 * CAM-3 on the pharmacy cold-chain section: each fridge camera with its zone's
 * temperatureZoneStatuses over the picture, then the excursion timeline.
 *
 * Pharmacy has no live-stream route for the vertical-neutral cameras yet (CAM-1
 * keeps bare-ID MediaMTX reads unsupported), so the picture is the zone's
 * newest captured excursion still. The caller has already authorized the
 * actor for this branch.
 */
export async function ColdChainCameraSection({
  db,
  scope,
  zones,
  statuses,
  latestTemperatureC,
}: {
  db: ScopedDb;
  scope: { organizationId: string; branchId: string };
  zones: ReadonlyArray<{ id: string; name: string }>;
  statuses: readonly TemperatureZoneStatusResult[];
  latestTemperatureC: ReadonlyMap<string, number>;
}) {
  const [cameras, evidence] = await Promise.all([
    db.camera.findMany({
      where: { ...scope, preset: 'COLD_CHAIN', enabled: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, preset: true, temperatureZoneId: true },
    }),
    readExcursionEvidence(db, scope, (key) => stillDataUrl(scope.organizationId, key)),
  ]);
  const zoneNames = new Map(zones.map((zone) => [zone.id, zone.name]));
  const statusByZone = new Map(statuses.map((status) => [status.stockLocationId, status]));
  const stillByZone = new Map<string, string>();
  for (const entry of evidence) {
    if (entry.image && !stillByZone.has(entry.temperatureZoneId)) {
      stillByZone.set(entry.temperatureZoneId, entry.image);
    }
  }

  return (
    <div className="space-y-4">
      <h3 className="font-medium text-text-strong">Fridge cameras</h3>
      {cameras.length === 0 ? (
        <p className="text-sm text-text-muted">
          No camera is linked to a fridge at this branch yet. Link one in Cameras to see fridge
          snapshots here.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {cameras.map((camera) => {
            const zoneId = camera.temperatureZoneId!;
            const status = statusByZone.get(zoneId);
            const still = stillByZone.get(zoneId);
            return (
              <CameraTile
                key={camera.id}
                name={camera.name}
                preset={camera.preset}
                media={
                  still ? (
                    // A private data: URL from the branch-scoped read; nothing to optimise.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      alt={`Latest excursion still from ${camera.name}`}
                      className="h-full w-full object-cover"
                      src={still}
                    />
                  ) : (
                    'No still captured yet'
                  )
                }
                overlay={
                  <TemperatureZoneOverlay
                    zoneName={zoneNames.get(zoneId) ?? 'Unknown zone'}
                    zone={
                      status
                        ? {
                            status: status.status,
                            minimumTemperatureC: status.minimumTemperatureC,
                            maximumTemperatureC: status.maximumTemperatureC,
                            latestRecordedAt: status.latestRecordedAt?.toISOString() ?? null,
                            latestTemperatureC: latestTemperatureC.get(zoneId) ?? null,
                          }
                        : null
                    }
                  />
                }
              />
            );
          })}
        </div>
      )}
      <h3 className="font-medium text-text-strong">Out-of-range temperature snapshots</h3>
      <ExcursionEvidenceTimeline entries={evidence} zoneNames={zoneNames} />
    </div>
  );
}
