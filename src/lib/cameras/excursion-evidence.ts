import 'server-only';

import { deriveTemperatureZoneStatus } from '@/lib/pharmacy/temperature-log';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { CAMERA_EVIDENCE_CAPTURE_WINDOW_MS, canReadCameraEvidence } from './evidence';

/**
 * CAM-3 excursion evidence. When readings put a cold-chain zone into EXCURSION
 * and a COLD_CHAIN camera watches that zone, one still is requested per
 * excursion run, in the transaction that stored the readings. The CAM-2 relay
 * and pharmacy.camera.snapshot.v1 job capture it exactly like counter evidence.
 */

type Scope = { organizationId: string; branchId: string };

/** Readings walked back to find where the out-of-range run began. */
const RUN_SCAN_LIMIT = 500;

export async function requestExcursionEvidence(
  db: ScopedDb,
  scope: Scope,
  stockLocationId: string,
  now: Date
): Promise<{ evidenceId: string } | null> {
  const camera = await db.camera.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      preset: 'COLD_CHAIN',
      temperatureZoneId: stockLocationId,
      enabled: true,
      gateway: { status: 'ACTIVE', revokedAt: null },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  if (!camera) return null;

  const zone = await db.pharmacyStockLocation.findFirst({
    where: {
      id: stockLocationId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      active: true,
    },
    select: {
      coldChain: true,
      minimumTemperatureC: true,
      maximumTemperatureC: true,
      expectedTemperatureReadingIntervalMinutes: true,
      temperatureExcursionDurationMinutes: true,
    },
  });
  if (!zone) return null;

  // Newest first. ponytail: a run longer than RUN_SCAN_LIMIT readings starts a
  // second evidence row; page the walk if loggers ever report that densely.
  const readings = await db.pharmacyTemperatureLog.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      stockLocationId,
      recordedAt: { lte: now },
    },
    orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    take: RUN_SCAN_LIMIT,
    select: { id: true, temperatureC: true, recordedAt: true, outOfRange: true },
  });
  const latest = readings[0];
  // A still taken now is evidence of now only: an imported backlog raises none.
  if (!latest || now.getTime() - latest.recordedAt.getTime() > CAMERA_EVIDENCE_CAPTURE_WINDOW_MS) {
    return null;
  }
  if (deriveTemperatureZoneStatus(zone, readings, now) !== 'EXCURSION') return null;

  // The run's first reading names the excursion, so later readings in the same
  // run resolve to the same evidence row.
  const intervalMs = zone.expectedTemperatureReadingIntervalMinutes * 60_000;
  let start = 0;
  while (
    start + 1 < readings.length &&
    readings[start + 1]!.outOfRange &&
    readings[start]!.recordedAt.getTime() - readings[start + 1]!.recordedAt.getTime() <= intervalMs
  ) {
    start += 1;
  }

  const subjectId = readings[start]!.id;
  await db.cameraEvidence.createMany({
    data: [
      {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        subjectKind: 'PHARMACY_TEMPERATURE_EXCURSION',
        subjectId,
        cameraId: camera.id,
        temperatureZoneId: stockLocationId,
        readingTemperatureC: latest.temperatureC,
        readingRecordedAt: latest.recordedAt,
      },
    ],
    skipDuplicates: true,
  });
  const evidence = await db.cameraEvidence.findUniqueOrThrow({
    where: {
      organizationId_subjectKind_subjectId: {
        organizationId: scope.organizationId,
        subjectKind: 'PHARMACY_TEMPERATURE_EXCURSION',
        subjectId,
      },
    },
    select: { id: true },
  });
  return { evidenceId: evidence.id };
}

/** One entry in a zone's excursion timeline. Never exposes a storage key. */
export type ExcursionEvidenceView = {
  id: string;
  temperatureZoneId: string;
  readingTemperatureC: number;
  readingRecordedAt: string;
  status: 'PENDING' | 'CAPTURED' | 'FAILED' | 'PURGED';
  requestedAt: string;
  capturedAt: string | null;
  failureReason: string | null;
  /** A data: URL for a captured still that is still in storage; else null. */
  image: string | null;
};

/**
 * The excursion stills for this branch, newest first. Authorization of the
 * actor for the branch is the caller's job; the branch filter keeps another
 * branch's evidence out even when a zone id is guessed.
 */
export async function readExcursionEvidence(
  db: ScopedDb,
  scope: Scope,
  readStill: (storageKey: string) => Promise<string | null>,
  take = 20
): Promise<ExcursionEvidenceView[]> {
  const rows = await db.cameraEvidence.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      subjectKind: 'PHARMACY_TEMPERATURE_EXCURSION',
    },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    take,
    include: { camera: { select: { gateway: { select: { retentionDays: true } } } } },
  });
  const now = new Date();
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      temperatureZoneId: row.temperatureZoneId!,
      readingTemperatureC: row.readingTemperatureC!,
      readingRecordedAt: row.readingRecordedAt!.toISOString(),
      status: row.status,
      requestedAt: row.requestedAt.toISOString(),
      capturedAt: row.capturedAt?.toISOString() ?? null,
      failureReason: row.failureReason,
      image: canReadCameraEvidence(row, row.camera?.gateway?.retentionDays, now)
        ? await readStill(row.storageKey)
        : null,
    }))
  );
}
