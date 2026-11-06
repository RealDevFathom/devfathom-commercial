import 'server-only';

import type { CameraEvidenceSubject, PlatformJob } from '@/generated/prisma/client';
import {
  cameraGatewayRuntime,
  type CameraGatewayRuntime,
} from '@/lib/cameras/camera-gateway-runtime';
import {
  canReadCameraEvidence,
  captureCameraEvidence,
  enterCameraTenantScope,
  evidenceSnapshotAdapter,
  purgeExpiredCameraEvidence,
  type ExpiredCameraEvidence,
} from '@/lib/cameras/evidence';
import { getUpload } from '@/lib/storage';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { PharmacyCounterError, type CounterScope } from './counter';
import { activeLegalHoldKeys } from './retention';

/**
 * CAM-2 counter evidence: a camera still bound to each tender, refund and daily
 * close. The request is written inside the money event's own transaction, so a
 * committed event always has its evidence request and a rolled-back one never
 * does. The capture happens later in the pharmacy.camera.snapshot.v1 platform
 * job, which `processPlatformJobs` enqueues from the pending rows.
 */
export const PHARMACY_CAMERA_SNAPSHOT_JOB = 'pharmacy.camera.snapshot.v1';

export type CounterEvidenceKind = 'TENDER' | 'REFUND' | 'DAILY_CLOSE';

const SUBJECT = {
  TENDER: 'PHARMACY_TENDER',
  REFUND: 'PHARMACY_REFUND',
  DAILY_CLOSE: 'PHARMACY_DAILY_CLOSE',
} as const satisfies Record<CounterEvidenceKind, CameraEvidenceSubject>;

async function subjectSale(
  db: ScopedDb,
  scope: CounterScope,
  kind: CounterEvidenceKind,
  subjectId: string
): Promise<string | null> {
  const where = { id: subjectId, organizationId: scope.organizationId, branchId: scope.branchId };
  const subject =
    kind === 'TENDER'
      ? await db.pharmacyTender.findFirst({ where, select: { saleId: true } })
      : kind === 'REFUND'
        ? await db.pharmacyRefund.findFirst({ where, select: { saleId: true } })
        : await db.pharmacyDailyClose
            .findFirst({ where, select: { id: true } })
            .then((close) => close && { saleId: null });
  if (!subject) throw new PharmacyCounterError('NOT_FOUND');
  return subject.saleId;
}

/**
 * The event id from a tender or refund result. An idempotent replay returns the
 * stored payload, whose static type drops the id, so it is read and checked here.
 */
export function settledSubjectId(result: object, key: 'tenderId' | 'refundId'): string {
  const value = (result as Record<string, unknown>)[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Settlement result carries no ${key}.`);
  }
  return value;
}

/**
 * Request a still for one money event. Call inside the event's transaction.
 * Idempotent per event, so a replayed tender does not request a second still.
 * Returns null when the branch has no usable evidence camera: the sale is never
 * blocked by the absence of a camera.
 */
export async function requestCounterEvidence(
  db: ScopedDb,
  scope: CounterScope,
  input: { kind: CounterEvidenceKind; subjectId: string }
): Promise<{ evidenceId: string } | null> {
  const saleId = await subjectSale(db, scope, input.kind, input.subjectId);
  const camera = await db.camera.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      enabled: true,
      counterEvidence: true,
      gateway: { status: 'ACTIVE', revokedAt: null },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  if (!camera) return null;

  const subjectKind = SUBJECT[input.kind];
  await db.cameraEvidence.createMany({
    data: [
      {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        subjectKind,
        subjectId: input.subjectId,
        saleId,
        cameraId: camera.id,
      },
    ],
    skipDuplicates: true,
  });
  const evidence = await db.cameraEvidence.findUniqueOrThrow({
    where: {
      organizationId_subjectKind_subjectId: {
        organizationId: scope.organizationId,
        subjectKind,
        subjectId: input.subjectId,
      },
    },
    select: { id: true },
  });
  return { evidenceId: evidence.id };
}

/** What the receipt history shows for one still. Never exposes a storage key. */
export type CounterEvidenceView = {
  id: string;
  kind: CounterEvidenceKind;
  status: 'PENDING' | 'CAPTURED' | 'FAILED' | 'PURGED';
  requestedAt: string;
  capturedAt: string | null;
  /** A data: URL for a captured still that is still in storage; else null. */
  image: string | null;
};

/** Counter subjects only: a sale's evidence never includes a CAM-3 excursion. */
const KIND: Record<(typeof SUBJECT)[CounterEvidenceKind], CounterEvidenceKind> = {
  PHARMACY_TENDER: 'TENDER',
  PHARMACY_REFUND: 'REFUND',
  PHARMACY_DAILY_CLOSE: 'DAILY_CLOSE',
};

/**
 * The stills bound to one sale's tenders and refunds, in this branch only.
 * Authorization of the actor for the branch is the caller's job, exactly as for
 * `readCounterReceipt`; this filter keeps another branch's evidence out even
 * when a sale id is guessed.
 */
export async function readCounterEvidence(
  db: ScopedDb,
  scope: CounterScope,
  saleId: string
): Promise<CounterEvidenceView[]> {
  return readBoundEvidence(db, scope, {
    saleId,
    subjectKind: { in: ['PHARMACY_TENDER', 'PHARMACY_REFUND'] },
  });
}

export async function readDailyCloseEvidence(db: ScopedDb, scope: CounterScope, closeId: string) {
  return readBoundEvidence(db, scope, { subjectId: closeId, subjectKind: 'PHARMACY_DAILY_CLOSE' });
}

async function readBoundEvidence(
  db: ScopedDb,
  scope: CounterScope,
  binding: import('@/generated/prisma/client').Prisma.CameraEvidenceWhereInput
): Promise<CounterEvidenceView[]> {
  const rows = await db.cameraEvidence.findMany({
    where: { ...binding, organizationId: scope.organizationId, branchId: scope.branchId },
    orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      subjectKind: true,
      status: true,
      storageKey: true,
      requestedAt: true,
      capturedAt: true,
      camera: { select: { gateway: { select: { retentionDays: true } } } },
    },
  });
  const now = new Date();
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      kind: KIND[row.subjectKind as keyof typeof KIND],
      status: row.status,
      requestedAt: row.requestedAt.toISOString(),
      capturedAt: row.capturedAt?.toISOString() ?? null,
      image: canReadCameraEvidence(row, row.camera?.gateway?.retentionDays, now)
        ? await stillDataUrl(scope.organizationId, row.storageKey)
        : null,
    }))
  );
}

export async function stillDataUrl(
  organizationId: string,
  storageKey: string
): Promise<string | null> {
  try {
    const bytes = await getUpload(organizationId, storageKey);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch (error) {
    // A still removed between the read and the fetch reads as missing, not as
    // a failed receipt; any other storage failure still surfaces.
    if ((error as { code?: string; statusCode?: number }).code === 'ENOENT') return null;
    if ((error as { statusCode?: number }).statusCode === 404) return null;
    throw error;
  }
}

function jobOrganization(job: Pick<PlatformJob, 'organizationId' | 'type'>) {
  if (!job.organizationId) throw new Error(`${job.type} requires an organization.`);
  return job.organizationId;
}

/** The pharmacy.camera.snapshot.v1 handler. Runs inside the job transaction. */
export async function runCounterEvidenceSnapshotJob(
  db: ScopedDb,
  job: Pick<PlatformJob, 'organizationId' | 'type' | 'attempts' | 'maxAttempts'>,
  payload: Record<string, unknown>,
  options: { runtime?: CameraGatewayRuntime; now?: Date } = {}
) {
  const organizationId = jobOrganization(job);
  const evidenceId = payload.evidenceId;
  if (typeof evidenceId !== 'string' || !evidenceId) {
    throw new Error('Job payload requires "evidenceId".');
  }
  await enterCameraTenantScope(db, organizationId);
  return captureCameraEvidence(db, {
    organizationId,
    evidenceId,
    adapter: evidenceSnapshotAdapter(options.runtime ?? cameraGatewayRuntime, {
      vertical: 'pharmacy',
    }),
    now: options.now ?? new Date(),
    finalAttempt: job.attempts >= job.maxAttempts,
  });
}

/**
 * Legal holds that keep a counter still past retention: a FISCAL hold on the
 * sale it belongs to, or on the event itself (the only handle a daily close
 * has). Read through retention.ts so the latest hold event decides. A CAM-3
 * excursion still is not a money record: an AUDIT hold on the temperature
 * reading that opened the excursion keeps it.
 */
async function counterEvidenceHolds(db: ScopedDb, evidence: ExpiredCameraEvidence) {
  if (evidence.subjectKind === 'PHARMACY_TEMPERATURE_EXCURSION') {
    return activeLegalHoldKeys(db, 'AUDIT', evidence.subjectId);
  }
  const keys = new Set(await activeLegalHoldKeys(db, 'FISCAL', evidence.subjectId));
  if (evidence.saleId) {
    for (const key of await activeLegalHoldKeys(db, 'FISCAL', evidence.saleId)) keys.add(key);
  }
  return [...keys].sort();
}

/** The camera.evidence.retention.v1 handler for one organization. */
export async function runCameraEvidenceRetentionJob(
  db: ScopedDb,
  job: Pick<PlatformJob, 'organizationId' | 'type'>,
  options: { now?: Date } = {}
) {
  const organizationId = jobOrganization(job);
  await enterCameraTenantScope(db, organizationId);
  return purgeExpiredCameraEvidence(db, {
    organizationId,
    now: options.now ?? new Date(),
    heldBy: (evidence) => counterEvidenceHolds(db, evidence),
  });
}
