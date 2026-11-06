import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { deleteUpload } from '@/lib/storage';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { CameraGatewayRuntime } from './camera-gateway-runtime';
import type { CameraSnapshotScope } from './snapshot-transport';
import {
  storeCameraSnapshot,
  type CameraSnapshotSource,
  type CameraSnapshotTarget,
} from './snapshots';

/**
 * A still taken long after the event it is bound to is not evidence of that
 * event. Past this window a pending capture is refused and recorded as failed.
 */
export const CAMERA_EVIDENCE_CAPTURE_WINDOW_MS = 15 * 60_000;

/** Stable, non-sensitive failure codes. Gateway errors are never persisted. */
export type CameraEvidenceFailure =
  'SNAPSHOT_UNSUPPORTED' | 'CAMERA_UNAVAILABLE' | 'CAPTURE_WINDOW_ELAPSED' | 'SNAPSHOT_UNAVAILABLE';

export type CameraEvidenceCaptureResult =
  | { evidenceId: string; outcome: 'CAPTURED'; byteLength: number }
  | { evidenceId: string; outcome: 'FAILED'; reason: CameraEvidenceFailure }
  | { evidenceId: string; outcome: 'ALREADY_SETTLED'; status: string };

/**
 * Drop the job's platform privileges for the rest of its transaction. Every
 * evidence read and write after this is decided by tenant row-level security.
 */
export async function enterCameraTenantScope(db: ScopedDb, organizationId: string) {
  await db.$queryRawUnsafe(
    `SELECT set_config('app.current_organization_id', $1, true),
            set_config('app.current_user_id', '', true),
            set_config('app.is_platform_admin', 'false', true)`,
    organizationId
  );
}

/**
 * A still source for evidence capture. `supports` lets a configured gateway say
 * a camera was never provisioned for stills, which is final, not retryable.
 */
export type CameraEvidenceSnapshotSource = CameraSnapshotSource & {
  supports?(target: CameraSnapshotTarget): boolean;
};

function snapshotScope(target: CameraSnapshotTarget): CameraSnapshotScope | null {
  // The binding pins one branch for both the gateway and the camera.
  if (target.gatewayBranchId !== target.branchId) return null;
  return {
    vertical: 'pharmacy',
    organizationId: target.organizationId,
    branchId: target.branchId,
    gatewayId: target.gatewayId,
    cameraId: target.cameraId,
    baseUrl: target.gatewayBaseUrl,
  };
}

/**
 * The simulator takes a still by its fixed camera reference. A configured
 * MediaMTX gateway takes one only for pharmacy evidence, only through the
 * DEV-745 snapshot service, and only for a camera whose exact organization,
 * branch, gateway, camera and gateway URL were provisioned in
 * CAMERA_SNAPSHOT_BINDINGS. Everything else fails closed as unsupported; a bare
 * camera reference is never resolved against a real gateway.
 */
export function evidenceSnapshotAdapter(
  runtime: CameraGatewayRuntime,
  options: { vertical?: 'pharmacy' } = {}
): CameraEvidenceSnapshotSource | null {
  if (runtime.available && runtime.mode === 'simulated') return runtime.adapter;
  if (
    !runtime.available ||
    runtime.mode !== 'mediamtx' ||
    options.vertical !== 'pharmacy' ||
    !runtime.snapshots
  )
    return null;
  const snapshots = runtime.snapshots;
  return {
    supports(target) {
      const scope = snapshotScope(target);
      return Boolean(scope && snapshots.supports(scope));
    },
    async getSnapshot(_cameraRef, target) {
      const scope = target ? snapshotScope(target) : null;
      if (!scope) throw new Error('Camera snapshot unavailable.');
      return snapshots.readSnapshot(scope);
    },
  };
}

/**
 * For camera consoles: true when evidence stills can be taken for this camera
 * under the current runtime. False is the honest "unsupported" state.
 */
export function evidenceSnapshotSupported(
  runtime: CameraGatewayRuntime,
  target: CameraSnapshotTarget
): boolean {
  const source = evidenceSnapshotAdapter(runtime, { vertical: 'pharmacy' });
  if (!source) return false;
  return source.supports ? source.supports(target) : true;
}

/**
 * The owner's opt-in is re-read at capture, not only when the still was
 * requested: turning off counter evidence, or moving a cold-chain camera off
 * the zone, stops pending and retried captures too. Unknown kinds never capture.
 */
function stillOptedIn(
  evidence: { subjectKind: string; temperatureZoneId?: string | null },
  camera: { counterEvidence?: boolean; preset?: string | null; temperatureZoneId?: string | null }
): boolean {
  switch (evidence.subjectKind) {
    case 'PHARMACY_TENDER':
    case 'PHARMACY_REFUND':
    case 'PHARMACY_DAILY_CLOSE':
      return camera.counterEvidence === true;
    case 'PHARMACY_TEMPERATURE_EXCURSION':
      return (
        camera.preset === 'COLD_CHAIN' &&
        Boolean(evidence.temperatureZoneId) &&
        camera.temperatureZoneId === evidence.temperatureZoneId
      );
    default:
      return false;
  }
}

async function settle(
  db: ScopedDb,
  evidence: { id: string; organizationId: string },
  data: Prisma.CameraEvidenceUpdateManyMutationInput
) {
  const updated = await db.cameraEvidence.updateMany({
    where: { id: evidence.id, organizationId: evidence.organizationId, status: 'PENDING' },
    data,
  });
  return updated.count === 1;
}

/**
 * Capture the still for one pending evidence row. Idempotent: a row that is no
 * longer pending is reported and left alone, so a redelivered job is harmless.
 * Adapter and storage errors are rethrown while the job has attempts left and
 * recorded as SNAPSHOT_UNAVAILABLE on the last one; database errors always
 * propagate.
 */
export async function captureCameraEvidence(
  db: ScopedDb,
  input: {
    organizationId: string;
    evidenceId: string;
    adapter: CameraEvidenceSnapshotSource | null;
    now: Date;
    finalAttempt: boolean;
  }
): Promise<CameraEvidenceCaptureResult> {
  const evidence = await db.cameraEvidence.findFirst({
    where: { id: input.evidenceId, organizationId: input.organizationId },
    include: { camera: { include: { gateway: true } } },
  });
  if (!evidence) throw new Error('Camera evidence no longer exists.');
  if (evidence.status !== 'PENDING') {
    return { evidenceId: evidence.id, outcome: 'ALREADY_SETTLED', status: evidence.status };
  }

  const fail = async (reason: CameraEvidenceFailure): Promise<CameraEvidenceCaptureResult> => {
    const settled = await settle(db, evidence, { status: 'FAILED', failureReason: reason });
    return settled
      ? { evidenceId: evidence.id, outcome: 'FAILED', reason }
      : { evidenceId: evidence.id, outcome: 'ALREADY_SETTLED', status: 'SETTLED_CONCURRENTLY' };
  };

  const { camera } = evidence;
  if (
    !camera.enabled ||
    !stillOptedIn(evidence, camera) ||
    camera.branchId !== evidence.branchId ||
    camera.gateway.status !== 'ACTIVE' ||
    camera.gateway.revokedAt !== null
  ) {
    return fail('CAMERA_UNAVAILABLE');
  }
  if (input.now.getTime() - evidence.requestedAt.getTime() > CAMERA_EVIDENCE_CAPTURE_WINDOW_MS) {
    return fail('CAPTURE_WINDOW_ELAPSED');
  }
  if (!input.adapter) return fail('SNAPSHOT_UNSUPPORTED');

  const target: CameraSnapshotTarget = {
    organizationId: evidence.organizationId,
    branchId: evidence.branchId,
    gatewayId: camera.gatewayId,
    gatewayBranchId: camera.gateway.branchId,
    gatewayBaseUrl: camera.gateway.baseUrl,
    cameraId: camera.id,
  };
  if (input.adapter.supports && !input.adapter.supports(target)) {
    return fail('SNAPSHOT_UNSUPPORTED');
  }

  let stored: Awaited<ReturnType<typeof storeCameraSnapshot>>;
  try {
    stored = await storeCameraSnapshot(input.adapter, {
      organizationId: evidence.organizationId,
      cameraId: camera.sourceRef,
      target,
    });
  } catch (error) {
    if (!input.finalAttempt) throw error;
    return fail('SNAPSHOT_UNAVAILABLE');
  }

  let settled: boolean;
  try {
    settled = await settle(db, evidence, {
      status: 'CAPTURED',
      storageKey: stored.filename,
      byteLength: stored.byteLength,
      capturedAt: input.now,
    });
  } catch (error) {
    // Best-effort orphan cleanup; the database error is the one that matters.
    await deleteUpload(evidence.organizationId, stored.filename).catch(() => undefined);
    throw error;
  }
  if (!settled) {
    // Another delivery settled the row first; this still is bound to nothing.
    await deleteUpload(evidence.organizationId, stored.filename);
    return { evidenceId: evidence.id, outcome: 'ALREADY_SETTLED', status: 'SETTLED_CONCURRENTLY' };
  }
  return { evidenceId: evidence.id, outcome: 'CAPTURED', byteLength: stored.byteLength };
}

export type ExpiredCameraEvidence = {
  id: string;
  storageKey: string;
  subjectKind: string;
  subjectId: string;
  saleId: string | null;
  capturedAt: Date;
};

/** Read expiry matches purge expiry; a legal hold preserves bytes, not read access. */
export function canReadCameraEvidence(
  evidence: { status: string; storageKey: string | null; capturedAt: Date | null },
  retentionDays: number | null | undefined,
  now: Date
): evidence is { status: 'CAPTURED'; storageKey: string; capturedAt: Date } {
  const capturedAt = evidence.capturedAt instanceof Date ? evidence.capturedAt.getTime() : NaN;
  const serverNow = now instanceof Date ? now.getTime() : NaN;
  return (
    evidence.status === 'CAPTURED' &&
    typeof evidence.storageKey === 'string' &&
    evidence.storageKey.length > 0 &&
    typeof retentionDays === 'number' &&
    Number.isInteger(retentionDays) &&
    retentionDays >= 1 &&
    retentionDays <= 3650 &&
    Number.isFinite(capturedAt) &&
    Number.isFinite(serverNow) &&
    capturedAt <= serverNow &&
    capturedAt > serverNow - retentionDays * 86_400_000
  );
}

/** SQL predicate: a captured still past its own gateway's retention period. */
export function cameraEvidenceDueSql(now: Date) {
  return Prisma.sql`e."status" = 'CAPTURED'
      AND e."capturedAt" <= ${now}::timestamp - make_interval(days => g."retentionDays")`;
}

const RETENTION_SCAN_BATCH = 200;

/**
 * Clear captured stills older than their gateway's retentionDays, unless
 * `heldBy` names an active legal hold for one. The row is kept as PURGED so the
 * binding stays auditable; only the image is removed. Pending captures past the
 * capture window are closed as CAPTURE_WINDOW_ELAPSED in the same pass.
 *
 * Held stills are stepped over with a keyset cursor, so any number of them can
 * never starve the rest. At most `maxPurges` stills are removed per pass; the
 * worker schedules another pass while due stills remain.
 */
export async function purgeExpiredCameraEvidence(
  db: ScopedDb,
  input: {
    organizationId: string;
    now: Date;
    heldBy: (evidence: ExpiredCameraEvidence) => Promise<string[]>;
    maxPurges?: number;
  }
) {
  const abandoned = await db.cameraEvidence.updateMany({
    where: {
      organizationId: input.organizationId,
      status: 'PENDING',
      requestedAt: { lt: new Date(input.now.getTime() - CAMERA_EVIDENCE_CAPTURE_WINDOW_MS) },
    },
    data: { status: 'FAILED', failureReason: 'CAPTURE_WINDOW_ELAPSED' },
  });

  const maxPurges = input.maxPurges ?? 200;
  const purgedIds: string[] = [];
  const held: Array<{ id: string; holdKeys: string[] }> = [];
  let cursor: { capturedAt: Date; id: string } | null = null;
  while (purgedIds.length < maxPurges) {
    const after: Prisma.Sql = cursor
      ? Prisma.sql`AND (e."capturedAt", e."id") > (${cursor.capturedAt}::timestamp, ${cursor.id})`
      : Prisma.empty;
    const batch: ExpiredCameraEvidence[] = await db.$queryRaw<ExpiredCameraEvidence[]>(Prisma.sql`
      SELECT e."id", e."storageKey", e."subjectKind"::text AS "subjectKind", e."subjectId",
             e."saleId", e."capturedAt"
      FROM "camera_evidence" e
      JOIN "cameras" c ON c."organizationId" = e."organizationId" AND c."id" = e."cameraId"
      JOIN "camera_gateways" g ON g."organizationId" = c."organizationId" AND g."id" = c."gatewayId"
      WHERE e."organizationId" = ${input.organizationId}
        AND ${cameraEvidenceDueSql(input.now)}
        ${after}
      ORDER BY e."capturedAt" ASC, e."id" ASC
      LIMIT ${RETENTION_SCAN_BATCH}
    `);
    for (const evidence of batch) {
      if (purgedIds.length >= maxPurges) break;
      cursor = { capturedAt: evidence.capturedAt, id: evidence.id };
      const holdKeys = await input.heldBy(evidence);
      if (holdKeys.length > 0) {
        held.push({ id: evidence.id, holdKeys });
        continue;
      }
      const cleared = await db.cameraEvidence.updateMany({
        where: { id: evidence.id, organizationId: input.organizationId, status: 'CAPTURED' },
        data: { status: 'PURGED', storageKey: null, purgedAt: input.now },
      });
      if (cleared.count !== 1) continue;
      // Idempotent: a re-run after a lost commit deletes nothing and succeeds.
      await deleteUpload(input.organizationId, evidence.storageKey);
      purgedIds.push(evidence.id);
    }
    if (batch.length < RETENTION_SCAN_BATCH) break;
  }
  return { purgedIds, held, abandonedPending: abandoned.count };
}
