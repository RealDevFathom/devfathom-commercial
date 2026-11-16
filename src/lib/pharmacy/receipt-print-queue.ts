import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { PharmacyPrintBridge, PharmacyPrintJob } from '@/generated/prisma/client';
import {
  RawPrintValidationError,
  validateRawStoredPrintDocument,
  type PrintDocument,
} from '@/lib/restaurant/printing/contract';
import { renderEscPos } from '@/lib/restaurant/printing/esc-pos';
import { resolveTransport } from '@/lib/restaurant/printing/target';
import {
  generateDeviceSecret,
  hashDeviceSecret,
  isDeviceUsable,
} from '@/lib/retail-terminal/device-secret';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-741 — the Pharmacy thermal receipt print queue.
 *
 * Reuses the Restaurant print seam where it is identical (ESC/POS renderer,
 * strict printable-document contract, host transport parser, host bridge
 * script) and owns only what differs: the pharmacy branch aggregate, a
 * branch-bound bridge credential, and receipt-specific duplicate rules.
 *
 * Honest delivery vocabulary. The server never dials a printer. A bridge
 * claims a job, writes bytes to its host transport, and reports what the
 * transport said. `SENT_TO_PRINTER` means the transport accepted the bytes; it
 * is never evidence that paper came out (`paperConfirmed` is always false).
 *
 * Duplicate protection:
 *   - one ORIGINAL job per sale (fixed key + partial unique index);
 *   - every reprint needs its own caller key and is a marked reprint document;
 *   - a job is claimable only once per attempt (attempt-bound claim token);
 *   - an unclaimed job goes stale after QUEUE_TTL_MS and is never sent late,
 *     so a receipt printed through the browser meanwhile is not doubled;
 *   - a claimed job with no answer is UNCONFIRMED, never retried automatically;
 *     a retry after FAILED/UNCONFIRMED needs an operator's paper check.
 */

export const PHARMACY_PRINT_BRIDGE_SECRET_PREFIX = 'ppb_';
/** A claimed attempt counts as SENDING for this long, then UNCONFIRMED. */
export const PRINT_CLAIM_LEASE_MS = 30_000;
/** An unclaimed job older than this is EXPIRED and will not be sent. */
export const PRINT_QUEUE_TTL_MS = 5 * 60_000;
/** A bridge that has not polled for this long is offline. */
export const PRINT_BRIDGE_ONLINE_MS = 60_000;

export const PRINT_FAILURE_CODES = [
  'TRANSPORT_FAILED',
  'PRINTER_NOT_ALLOWED',
  'INVALID_JOB',
  'INVALID_DOCUMENT',
] as const;
export type PrintFailureCode = (typeof PRINT_FAILURE_CODES)[number];

export type PrintJobState =
  'QUEUED' | 'SENDING' | 'SENT_TO_PRINTER' | 'FAILED' | 'UNCONFIRMED' | 'EXPIRED';

export type PharmacyPrintQueueErrorReason =
  | 'NO_BRIDGE'
  | 'BRIDGE_REQUIRED'
  | 'BRIDGE_NOT_FOUND'
  | 'BRIDGE_OFFLINE'
  | 'BRIDGE_REVOKED'
  | 'REPRINT_KEY_REQUIRED'
  | 'JOB_NOT_FOUND'
  | 'NOT_RETRYABLE'
  | 'PAPER_CHECK_REQUIRED'
  | 'CHANGED'
  | 'INVALID_NAME'
  | 'INVALID_PRINTER';

export class PharmacyPrintQueueError extends Error {
  constructor(readonly reason: PharmacyPrintQueueErrorReason) {
    super(reason);
    this.name = 'PharmacyPrintQueueError';
  }
}

type Scope = { organizationId: string; branchId: string };

// ── Bridge credential ─────────────────────────────────────────────────────────

const CREDENTIAL = /^(ppb_[A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{1,172})$/;
const ORGANIZATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * `ppb_<secret>.<base64url organization id>`. The organization part is a
 * routing hint, not a secret: it lets the transport open the tenant scope
 * BEFORE the hash lookup, so no platform-wide read or RLS widening is needed.
 * Only the hash of the secret part is stored and compared.
 */
export function formatPharmacyPrintBridgeCredential(secret: string, organizationId: string) {
  return `${secret}.${Buffer.from(organizationId, 'utf8').toString('base64url')}`;
}

export function parsePharmacyPrintBridgeCredential(
  token: string
): { secret: string; organizationId: string } | null {
  const match = CREDENTIAL.exec(token);
  if (!match) return null;
  const organizationId = Buffer.from(match[2], 'base64url').toString('utf8');
  if (!ORGANIZATION_ID.test(organizationId)) return null;
  // Reject non-canonical encodings so one credential has exactly one spelling.
  if (Buffer.from(organizationId, 'utf8').toString('base64url') !== match[2]) return null;
  return { secret: match[1], organizationId };
}

/**
 * Same explicit-target grammar as the host bridge. The server does not know the
 * host OS, so a target valid on any supported host is accepted; the host
 * re-validates against its own platform and allowlist before any write.
 */
export function isValidPrinterTarget(printerId: string): boolean {
  if (!/^[\x21-\x7e]{1,128}$/.test(printerId)) return false;
  return (['darwin', 'win32', 'linux'] as const).some((platform) => {
    try {
      resolveTransport(printerId, platform);
      return true;
    } catch {
      return false;
    }
  });
}

export type PrintBridgeView = {
  id: string;
  name: string;
  status: 'ACTIVE' | 'REVOKED';
  lastSeenAt: string | null;
  online: boolean;
};

function bridgeOnline(
  bridge: Pick<PharmacyPrintBridge, 'status' | 'revokedAt' | 'lastSeenAt'>,
  now: Date
) {
  return (
    isDeviceUsable(bridge) &&
    !!bridge.lastSeenAt &&
    now.getTime() - bridge.lastSeenAt.getTime() < PRINT_BRIDGE_ONLINE_MS
  );
}

export function bridgeView(bridge: PharmacyPrintBridge, now: Date): PrintBridgeView {
  return {
    id: bridge.id,
    name: bridge.name,
    status: bridge.status,
    lastSeenAt: bridge.lastSeenAt?.toISOString() ?? null,
    online: bridgeOnline(bridge, now),
  };
}

/** Caller authorizes configuration. The credential is returned once and never stored. */
export async function enrollPharmacyPrintBridge(
  db: Pick<ScopedDb, 'pharmacyPrintBridge'>,
  scope: Scope & { actorId: string },
  input: { name: string; printerId: string }
): Promise<{ bridge: PharmacyPrintBridge; credential: string }> {
  const name = input.name.trim();
  if (!name || name.length > 80) throw new PharmacyPrintQueueError('INVALID_NAME');
  if (!isValidPrinterTarget(input.printerId)) throw new PharmacyPrintQueueError('INVALID_PRINTER');
  const { secret, secretHash } = generateDeviceSecret(PHARMACY_PRINT_BRIDGE_SECRET_PREFIX);
  const bridge = await db.pharmacyPrintBridge.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      name,
      printerId: input.printerId,
      deviceSecretHash: secretHash,
      enrolledByActorId: scope.actorId,
    },
  });
  return { bridge, credential: formatPharmacyPrintBridgeCredential(secret, scope.organizationId) };
}

/** Durable revocation with a SERVER clock; the row stays for reconciliation. */
export async function revokePharmacyPrintBridge(
  db: Pick<ScopedDb, 'pharmacyPrintBridge'>,
  scope: Scope,
  bridgeId: string,
  now: Date
): Promise<PharmacyPrintBridge> {
  const bridge = await db.pharmacyPrintBridge.findFirst({
    where: { id: bridgeId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!bridge) throw new PharmacyPrintQueueError('BRIDGE_NOT_FOUND');
  if (bridge.status === 'REVOKED') return bridge;
  return db.pharmacyPrintBridge.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: bridgeId } },
    data: { status: 'REVOKED', revokedAt: now },
  });
}

export async function listPharmacyPrintBridges(
  db: Pick<ScopedDb, 'pharmacyPrintBridge'>,
  scope: Scope
): Promise<PharmacyPrintBridge[]> {
  return db.pharmacyPrintBridge.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
  });
}

/** Resolve inside the credential's tenant scope. Any status; caller applies `isDeviceUsable`. */
export async function resolvePharmacyPrintBridge(
  db: Pick<ScopedDb, 'pharmacyPrintBridge'>,
  credential: { secret: string; organizationId: string }
): Promise<PharmacyPrintBridge | null> {
  const bridge = await db.pharmacyPrintBridge.findUnique({
    where: { deviceSecretHash: hashDeviceSecret(credential.secret) },
  });
  return bridge && bridge.organizationId === credential.organizationId ? bridge : null;
}

export async function touchPharmacyPrintBridge(
  db: Pick<ScopedDb, 'pharmacyPrintBridge'>,
  bridge: Pick<PharmacyPrintBridge, 'organizationId' | 'id'>,
  now: Date
): Promise<void> {
  await db.pharmacyPrintBridge.update({
    where: { organizationId_id: { organizationId: bridge.organizationId, id: bridge.id } },
    data: { lastSeenAt: now },
  });
}

// ── Job state ─────────────────────────────────────────────────────────────────

type JobStateFields = Pick<PharmacyPrintJob, 'status' | 'lastAttemptAt' | 'queuedAt'>;

export function derivePrintJobState(job: JobStateFields, now: Date): PrintJobState {
  if (job.status === 'TRANSPORT_ACCEPTED') return 'SENT_TO_PRINTER';
  if (job.status === 'FAILED') return 'FAILED';
  if (job.lastAttemptAt) {
    return now.getTime() - job.lastAttemptAt.getTime() < PRINT_CLAIM_LEASE_MS
      ? 'SENDING'
      : 'UNCONFIRMED';
  }
  return now.getTime() - job.queuedAt.getTime() < PRINT_QUEUE_TTL_MS ? 'QUEUED' : 'EXPIRED';
}

const RETRYABLE: ReadonlySet<PrintJobState> = new Set(['FAILED', 'UNCONFIRMED', 'EXPIRED']);
/** Bytes may have reached the printer, so a person must look before resending. */
const PAPER_CHECK: ReadonlySet<PrintJobState> = new Set(['FAILED', 'UNCONFIRMED']);

export type PrintJobView = {
  id: string;
  saleId: string;
  receiptNumber: number;
  reprint: boolean;
  copyNumber: number;
  bridgeId: string;
  paperWidth: number;
  state: PrintJobState;
  attemptCount: number;
  queuedAt: string;
  lastAttemptAt: string | null;
  acceptedAt: string | null;
  failureCode: string | null;
  /** Always false: no transport in this system can observe paper. */
  paperConfirmed: false;
  retryable: boolean;
  retryRequiresPaperCheck: boolean;
};

export function printJobView(job: PharmacyPrintJob, now: Date): PrintJobView {
  const state = derivePrintJobState(job, now);
  return {
    id: job.id,
    saleId: job.saleId,
    receiptNumber: job.receiptNumber,
    reprint: job.reprint,
    copyNumber: job.copyNumber,
    bridgeId: job.bridgeId,
    paperWidth: job.paperWidth,
    state,
    attemptCount: job.attemptCount,
    queuedAt: job.queuedAt.toISOString(),
    lastAttemptAt: job.lastAttemptAt?.toISOString() ?? null,
    acceptedAt: job.acceptedAt?.toISOString() ?? null,
    failureCode: job.failureCode,
    paperConfirmed: false,
    retryable: RETRYABLE.has(state),
    retryRequiresPaperCheck: PAPER_CHECK.has(state),
  };
}

// ── Enqueue ───────────────────────────────────────────────────────────────────

type QueueDb = Pick<ScopedDb, '$executeRawUnsafe' | 'pharmacyPrintBridge' | 'pharmacyPrintJob'>;

export function receiptPrintIdempotencyKey(saleId: string, reprint: boolean, requestKey?: string) {
  if (!reprint) return `sale:${saleId}:original`;
  if (!requestKey) throw new PharmacyPrintQueueError('REPRINT_KEY_REQUIRED');
  return `sale:${saleId}:reprint:${requestKey}`;
}

export async function selectPharmacyPrintBridge(
  db: QueueDb,
  scope: Scope,
  bridgeId: string | undefined,
  now: Date
) {
  const bridges = await db.pharmacyPrintBridge.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'ACTIVE',
      revokedAt: null,
      ...(bridgeId ? { id: bridgeId } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
  if (bridgeId && bridges.length === 0) throw new PharmacyPrintQueueError('BRIDGE_NOT_FOUND');
  if (bridges.length === 0) throw new PharmacyPrintQueueError('NO_BRIDGE');
  // Never guess between printers: two receipt printers means the caller chooses.
  if (bridges.length > 1) throw new PharmacyPrintQueueError('BRIDGE_REQUIRED');
  const bridge = bridges[0]!;
  // A job left for an offline bridge could print long after the operator gave
  // up and used the browser. Refuse instead; the caller falls back.
  if (!bridgeOnline(bridge, now)) throw new PharmacyPrintQueueError('BRIDGE_OFFLINE');
  return bridge;
}

/**
 * Queue a receipt the CALLER already built from the settled sale (see
 * `allocateSettledCounterReceiptPrintJob`). Run inside one transaction. A replay
 * of the same key returns the existing job and never creates a second one.
 */
export async function enqueuePharmacyReceiptPrint(
  db: QueueDb,
  input: Scope & {
    actorId: string;
    saleId: string;
    receiptNumber: number;
    reprint: boolean;
    selectedBridge?: PharmacyPrintBridge;
    copyNumber: number;
    idempotencyKey?: string;
    requestKey?: string;
    bridgeId?: string;
    document: PrintDocument;
    byteCount: number;
    paperWidth: 58 | 80;
    now: Date;
  }
): Promise<{ job: PharmacyPrintJob; replayed: boolean }> {
  if (
    !Number.isSafeInteger(input.copyNumber) ||
    input.copyNumber < 1 ||
    input.reprint !== input.copyNumber > 1
  ) {
    throw new PharmacyPrintQueueError('CHANGED');
  }
  const idempotencyKey =
    input.idempotencyKey ??
    receiptPrintIdempotencyKey(input.saleId, input.reprint, input.requestKey);
  // Serialize every print of one sale, so the original rule and replay checks
  // see each other even before the unique index would.
  await db.$executeRawUnsafe(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    `pharmacy-print:${input.organizationId}:${input.branchId}:${input.saleId}`
  );
  const prior = await db.pharmacyPrintJob.findUnique({
    where: {
      organizationId_branchId_idempotencyKey: {
        organizationId: input.organizationId,
        branchId: input.branchId,
        idempotencyKey,
      },
    },
  });
  if (prior) {
    if (prior.saleId !== input.saleId || prior.reprint !== input.reprint) {
      throw new PharmacyPrintQueueError('CHANGED');
    }
    return { job: prior, replayed: true };
  }
  const bridge =
    input.selectedBridge ?? (await selectPharmacyPrintBridge(db, input, input.bridgeId, input.now));
  const job = await db.pharmacyPrintJob.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      bridgeId: bridge.id,
      printerId: bridge.printerId,
      saleId: input.saleId,
      receiptNumber: input.receiptNumber,
      reprint: input.reprint,
      copyNumber: input.copyNumber,
      idempotencyKey,
      document: input.document,
      byteCount: input.byteCount,
      paperWidth: input.paperWidth,
      queuedAt: input.now,
      requestedByActorId: input.actorId,
    },
  });
  return { job, replayed: false };
}

export async function readPharmacyPrintJob(
  db: Pick<ScopedDb, 'pharmacyPrintJob'>,
  scope: Scope,
  jobId: string
): Promise<PharmacyPrintJob> {
  const job = await db.pharmacyPrintJob.findFirst({
    where: { id: jobId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!job) throw new PharmacyPrintQueueError('JOB_NOT_FOUND');
  return job;
}

/**
 * Operator retry of the SAME job (same document, same marking). Allowed only
 * when nothing is in flight. After FAILED/UNCONFIRMED the operator must state
 * that no paper came out; EXPIRED was never sent, so no check is needed.
 */
export async function retryPharmacyPrintJob(
  db: Pick<ScopedDb, 'pharmacyPrintBridge' | 'pharmacyPrintJob'>,
  scope: Scope & { actorId: string },
  input: { jobId: string; paperChecked: boolean; now: Date }
): Promise<PharmacyPrintJob> {
  const job = await readPharmacyPrintJob(db, scope, input.jobId);
  const state = derivePrintJobState(job, input.now);
  if (!RETRYABLE.has(state)) throw new PharmacyPrintQueueError('NOT_RETRYABLE');
  if (PAPER_CHECK.has(state) && !input.paperChecked) {
    throw new PharmacyPrintQueueError('PAPER_CHECK_REQUIRED');
  }
  const bridge = await db.pharmacyPrintBridge.findFirst({
    where: { id: job.bridgeId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!bridge || !isDeviceUsable(bridge)) throw new PharmacyPrintQueueError('BRIDGE_REVOKED');
  if (!bridgeOnline(bridge, input.now)) throw new PharmacyPrintQueueError('BRIDGE_OFFLINE');
  // Guarded on the exact observed attempt: a late acknowledgement and a retry
  // cannot both win.
  const updated = await db.pharmacyPrintJob.updateMany({
    where: {
      id: job.id,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: job.status,
      attemptCount: job.attemptCount,
      lastAttemptAt: job.lastAttemptAt,
    },
    data: {
      status: 'PENDING',
      lastAttemptAt: null,
      failureCode: null,
      queuedAt: input.now,
      retriedByActorId: scope.actorId,
    },
  });
  if (updated.count !== 1) throw new PharmacyPrintQueueError('CHANGED');
  return readPharmacyPrintJob(db, scope, job.id);
}

// ── Bridge claim / acknowledge ────────────────────────────────────────────────

type BridgeIdentity = Pick<PharmacyPrintBridge, 'id' | 'organizationId' | 'branchId' | 'printerId'>;

/** HMAC binding the bridge to one persisted attempt. A retry changes the attempt. */
function claimToken(
  job: Pick<PharmacyPrintJob, 'id' | 'organizationId' | 'branchId' | 'attemptCount'> & {
    lastAttemptAt: Date;
  },
  bridgeId: string
): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is required for print claims.');
  return createHmac('sha256', secret)
    .update(
      JSON.stringify([
        'pharmacy-print-claim-v1',
        job.organizationId,
        job.branchId,
        job.id,
        bridgeId,
        job.attemptCount,
        job.lastAttemptAt.toISOString(),
      ])
    )
    .digest('hex');
}

export type ClaimedPharmacyPrintJob = {
  id: string;
  claimToken: string;
  printerId: string;
  documentType: 'RECEIPT';
  bytes: string;
  attempt: number;
  paperWidth: number;
};

/** Re-render from the stored server document; the stored byte count must still match. */
function renderStored(job: Pick<PharmacyPrintJob, 'document' | 'byteCount'>): Uint8Array | null {
  try {
    const bytes = renderEscPos(validateRawStoredPrintDocument(job.document));
    return bytes.length === job.byteCount ? bytes : null;
  } catch (error) {
    if (error instanceof RawPrintValidationError) return null;
    throw error;
  }
}

/**
 * Claim fresh work for THIS bridge only. A job is offered once per attempt;
 * stale or already-attempted jobs are never re-offered automatically.
 */
export async function claimNextPharmacyPrintJob(
  db: Pick<ScopedDb, 'pharmacyPrintJob'>,
  bridge: BridgeIdentity,
  now: Date
): Promise<ClaimedPharmacyPrintJob | null> {
  const fresh = {
    organizationId: bridge.organizationId,
    branchId: bridge.branchId,
    bridgeId: bridge.id,
    status: 'PENDING' as const,
    lastAttemptAt: null,
    queuedAt: { gt: new Date(now.getTime() - PRINT_QUEUE_TTL_MS) },
  };
  const candidates = await db.pharmacyPrintJob.findMany({
    where: fresh,
    orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
    take: 5,
  });
  for (const candidate of candidates) {
    const guard = { ...fresh, id: candidate.id, attemptCount: candidate.attemptCount };
    const bytes = candidate.printerId === bridge.printerId ? renderStored(candidate) : null;
    if (!bytes) {
      // Never dispatch a document or destination that no longer verifies.
      await db.pharmacyPrintJob.updateMany({
        where: guard,
        data: {
          status: 'FAILED',
          failureCode:
            candidate.printerId === bridge.printerId ? 'INVALID_DOCUMENT' : 'INVALID_JOB',
          lastAttemptAt: now,
        },
      });
      continue;
    }
    const attempt = candidate.attemptCount + 1;
    const claimed = await db.pharmacyPrintJob.updateMany({
      where: guard,
      data: { lastAttemptAt: now, attemptCount: attempt },
    });
    if (claimed.count !== 1) continue;
    return {
      id: candidate.id,
      claimToken: claimToken(
        { ...candidate, attemptCount: attempt, lastAttemptAt: now },
        bridge.id
      ),
      printerId: candidate.printerId,
      documentType: 'RECEIPT',
      bytes: Buffer.from(bytes).toString('base64'),
      attempt,
      paperWidth: candidate.paperWidth,
    };
  }
  return null;
}

/**
 * Record what the host transport reported for the CURRENT attempt. A late
 * answer is still accepted while that attempt is current (it is better truth
 * than UNCONFIRMED); once an operator retried, the old token no longer matches.
 */
export async function acknowledgePharmacyPrintJob(
  db: Pick<ScopedDb, 'pharmacyPrintJob'>,
  bridge: BridgeIdentity,
  input: {
    jobId: string;
    claimToken: string;
    outcome: 'TRANSPORT_ACCEPTED' | 'FAILED';
    failureCode?: PrintFailureCode;
    now: Date;
  }
): Promise<{ acknowledged: boolean; replayed: boolean }> {
  const rejected = { acknowledged: false, replayed: false };
  if (!/^[a-f0-9]{64}$/.test(input.claimToken)) return rejected;
  const current = await db.pharmacyPrintJob.findFirst({
    where: {
      id: input.jobId,
      organizationId: bridge.organizationId,
      branchId: bridge.branchId,
      bridgeId: bridge.id,
    },
  });
  if (!current?.lastAttemptAt || current.attemptCount < 1) return rejected;
  const expected = claimToken({ ...current, lastAttemptAt: current.lastAttemptAt }, bridge.id);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.claimToken, 'hex'))) {
    return rejected;
  }
  if (current.status === input.outcome) return { acknowledged: true, replayed: true };
  if (current.status !== 'PENDING') return rejected;
  if (current.lastAttemptAt.getTime() > input.now.getTime()) return rejected;
  const updated = await db.pharmacyPrintJob.updateMany({
    where: {
      id: current.id,
      organizationId: bridge.organizationId,
      branchId: bridge.branchId,
      bridgeId: bridge.id,
      status: 'PENDING',
      attemptCount: current.attemptCount,
      lastAttemptAt: current.lastAttemptAt,
    },
    data:
      input.outcome === 'TRANSPORT_ACCEPTED'
        ? { status: 'TRANSPORT_ACCEPTED', acceptedAt: input.now }
        : { status: 'FAILED', failureCode: input.failureCode ?? 'TRANSPORT_FAILED' },
  });
  return updated.count === 1 ? { acknowledged: true, replayed: false } : rejected;
}
