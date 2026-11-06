import crypto from 'node:crypto';

import { TRPCError } from '@trpc/server';

import { responseForPasswordChange } from '@/lib/auth/session-state';
import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';
import { publicRequestOrigin } from '@/lib/http-origin';
import { PHARMACY_SOP_CHANGED_MESSAGE } from '@/lib/pharmacy/sop-shared';
import {
  pharmacySopEvidenceFilename,
  resolvePharmacySopProvenance,
  writePharmacySopUploadReceipt,
} from '@/lib/pharmacy/sop-evidence';
import { SopExecutionError, attachEvidence } from '@/lib/restaurant/sop-execution';
import { deleteUpload, putUpload, StorageUnavailableError } from '@/lib/storage';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { appRouter } from '@/server/routers/_app';
import { createTRPCContext } from '@/server/trpc';

/**
 * DEV-751 — multipart proof capture for a pharmacy SOP occurrence.
 *
 * Authorization is the `pharmacySop.evidenceTarget` procedure, called through
 * the app router's server-side caller — so its middleware path is the real
 * `pharmacySop.evidenceTarget` and the upload passes the same gates and audit
 * path as every pharmacy SOP procedure: a usable session, the `pharmacy-safety` module, `sop:complete`,
 * the caller's pharmacy branch assignment, the occurrence belonging to that
 * branch's SOP site, and the occurrence being the caller's own work in
 * progress. The uploader is always the session actor that procedure resolves;
 * an uploader field in the form is never read.
 *
 * Nothing is stored before authorization passes. A retry with the same bytes
 * resolves to the same evidence row (the engine's retry-identity unique), and
 * the redundant blob is removed. Any failure after storage removes the blob,
 * so a refused or interrupted upload leaves no evidence row and no orphan file.
 *
 * Provenance is a server-issued capture receipt (`pharmacy_sop_evidence_captures`)
 * written in the same transaction as the engine's evidence row, from the
 * evidence id the engine returned and the session actor — never from the form.
 * If the receipt cannot be written the attach rolls back with it and the
 * response is retryable; nothing is ever deleted from the append-only tables.
 * A retry that resolves to an existing row heals a missing receipt (idempotent,
 * never a duplicate) — but only for a row that is already provably pharmacy
 * proof: one with a receipt, or whose legacy name verifies under the current
 * secret. Identical bytes that were attached through a restaurant surface
 * never gain a receipt this way; the retry is refused instead.
 *
 * Blobs are still named by `pharmacySopEvidenceFilename` (`pharmacy-sop-<uuid>-<mac>`)
 * so proof written before receipts existed stays recognisable until the legacy
 * receipt backfill has run. Evidence attached to a pharmacy occurrence through
 * any other route has no receipt and never counts as pharmacy proof.
 */

export const runtime = 'nodejs';

const EVIDENCE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

type Stage = 'file_validation' | 'authorization' | 'storage' | 'attach' | 'receipt' | 'cleanup';

class EvidenceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceInputError';
  }
}

/** A retry resolved to an existing row that is not provably pharmacy proof. */
class UnreceiptableEvidenceError extends Error {
  constructor() {
    super('Identical proof is already on this step but was not captured here.');
    this.name = 'UnreceiptableEvidenceError';
  }
}

function warn(stage: Stage, error: unknown) {
  try {
    console.warn(
      'pharmacy_sop_evidence_capture_failed',
      JSON.stringify({
        event: 'pharmacy_sop_evidence_capture_failed',
        stage,
        errorClass: error instanceof Error ? error.name : typeof error,
      })
    );
  } catch {
    // Telemetry must never change the public failure response.
  }
}

/** One transaction for `work`; a request-level transaction is reused (scoped-db). */
function inTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: NO_STORE });
}

async function readEvidenceFile(value: FormDataEntryValue | null) {
  const tag = Object.prototype.toString.call(value);
  if (
    typeof value !== 'object' ||
    value === null ||
    (tag !== '[object File]' && tag !== '[object Blob]') ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > MAX_ATTACHMENT_BYTES ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    typeof value.type !== 'string' ||
    typeof value.arrayBuffer !== 'function'
  ) {
    throw new EvidenceInputError(`Choose a file between 1 byte and ${MAX_ATTACHMENT_BYTES} bytes.`);
  }
  const baseType = value.type.split(';')[0]!.trim().toLowerCase();
  const extension = EVIDENCE_TYPES[baseType as keyof typeof EVIDENCE_TYPES];
  if (!extension) throw new EvidenceInputError('Proof must be a JPEG, PNG, or WebP image.');
  const bytes = Buffer.from(await value.arrayBuffer());
  // A truncated body (an interrupted upload) never matches its declared size.
  if (bytes.length !== value.size) throw new EvidenceInputError('The upload was incomplete.');
  return { baseType, bytes, extension };
}

function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

const TRPC_STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
};

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  try {
    return (
      origin !== null &&
      new URL(origin).origin.toLowerCase() === publicRequestOrigin(request) &&
      (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none')
    );
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return new Response('Forbidden', { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { error: 'The upload was incomplete or not a multipart form.' });
  }

  let stage: Stage = 'file_validation';
  let storedFilename: string | null = null;
  let organizationId: string | null = null;
  try {
    const pharmacyBranchId = field(form, 'pharmacyBranchId');
    const occurrenceId = field(form, 'occurrenceId');
    const occurrenceStepId = field(form, 'occurrenceStepId') || null;
    const purpose = field(form, 'evidencePurpose') || 'photo';
    if (!pharmacyBranchId || !occurrenceId) {
      throw new EvidenceInputError('Choose the branch and procedure first.');
    }
    if (purpose !== 'photo' && purpose !== 'signature') {
      throw new EvidenceInputError('Choose whether this file is photo or signature proof.');
    }
    const { baseType, bytes, extension } = await readEvidenceFile(form.get('file'));

    stage = 'authorization';
    const actor = await resolveTenantActor({ request });
    if (!actor?.session.user?.id) return json(401, { error: 'Sign in to capture proof.' });
    const ctx = await createTRPCContext({
      req: request,
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
    organizationId = ctx.organization?.id ?? ctx.session?.user?.organizationId ?? null;
    if (!organizationId) return json(404, { error: 'Workspace not found.' });
    const target = await appRouter.createCaller(ctx).pharmacySop.evidenceTarget({
      pharmacyBranchId,
      occurrenceId,
      occurrenceStepId,
    });

    stage = 'storage';
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const mimeType = `${baseType}; evidence=${purpose}`;
    storedFilename = pharmacySopEvidenceFilename(
      {
        organizationId,
        occurrenceId: target.occurrenceId,
        occurrenceStepId: target.occurrenceStepId,
        contentHash: hash,
        mimeType,
        uploaderStaffProfileId: target.uploaderStaffProfileId,
      },
      extension
    );
    await putUpload(organizationId, storedFilename, bytes, baseType);

    stage = 'attach';
    const capturedByUserId = actor.session.user.id;
    const tenantId = organizationId;
    // One transaction: the engine row and its receipt commit together or not
    // at all (a request-level transaction is reused by the engine helper).
    const evidence = await inTransaction(ctx.db, async (tx) => {
      const attached = await attachEvidence(tx, {
        occurrenceId: target.occurrenceId,
        occurrenceStepId: target.occurrenceStepId,
        contentHashHex: hash,
        mimeType,
        sizeBytes: bytes.length,
        storageRef: `/api/files/${storedFilename}`,
        uploaderStaffProfileId: target.uploaderStaffProfileId,
      });
      stage = 'receipt';
      if (!attached.created) {
        // A retry: the row predates this request. Heal its receipt only when
        // the row is already provably pharmacy proof.
        const existing = await tx.restaurantSopEvidence.findFirst({
          where: { id: attached.evidenceId, occurrenceId: target.occurrenceId },
          select: {
            id: true,
            occurrenceId: true,
            occurrenceStepId: true,
            contentHash: true,
            mimeType: true,
            uploaderStaffProfileId: true,
            storageRef: true,
          },
        });
        const [provenance] = existing
          ? await resolvePharmacySopProvenance(tx, tenantId, [existing])
          : [];
        if (provenance !== 'RECEIPT' && provenance !== 'LEGACY_HMAC') {
          throw new UnreceiptableEvidenceError();
        }
      }
      await writePharmacySopUploadReceipt(tx, {
        organizationId: tenantId,
        pharmacyBranchId: target.pharmacyBranchId,
        occurrenceId: target.occurrenceId,
        evidenceId: attached.evidenceId,
        contentHash: attached.contentHash,
        capturedByStaffProfileId: target.uploaderStaffProfileId,
        capturedByUserId,
      });
      return attached;
    });
    if (!evidence.created) {
      // An identical retry: the first upload already holds the row and blob.
      stage = 'cleanup';
      await deleteUpload(organizationId, storedFilename);
      storedFilename = null;
    }
    return json(evidence.created ? 201 : 200, {
      evidenceId: evidence.evidenceId,
      contentHash: evidence.contentHash,
      created: evidence.created,
    });
  } catch (error) {
    if (
      storedFilename &&
      organizationId &&
      stage !== 'cleanup' &&
      !(stage === 'storage' && error instanceof StorageUnavailableError)
    ) {
      try {
        await deleteUpload(organizationId, storedFilename);
      } catch (cleanupError) {
        warn('cleanup', cleanupError);
        return json(500, { error: 'Proof capture failed. Stored file cleanup is incomplete.' });
      }
    }
    if (stage === 'cleanup') {
      warn('cleanup', error);
      return json(500, { error: 'Proof capture failed. Stored file cleanup is incomplete.' });
    }
    warn(stage, error);
    const passwordChange = responseForPasswordChange(error);
    if (passwordChange) return passwordChange;
    if (error instanceof EvidenceInputError) return json(400, { error: error.message });
    if (error instanceof UnreceiptableEvidenceError) {
      return json(409, {
        error:
          'This exact image is already on the step but was not captured in the pharmacy workspace. Take a new photo, or ask a manager to review it.',
      });
    }
    // `stage` moves to 'receipt' inside the transaction callback, which
    // control-flow narrowing does not follow; widen it back to the union.
    if ((stage as Stage) === 'receipt') {
      // Nothing was kept: the attach rolled back with the receipt. A retry
      // re-attaches idempotently and writes the receipt again.
      return json(503, { error: 'Proof was not saved. Retry in a moment.', retryable: true });
    }
    // `conflict: true` marks a procedure that moved on since the screen read
    // it (a stale tab): the upload hands it to the runner, which re-reads the
    // procedure, instead of offering a retry that cannot succeed.
    if (error instanceof TRPCError) {
      const status = TRPC_STATUS[error.code];
      if (status === 409) return json(409, { error: error.message, conflict: true });
      if (status) return json(status, { error: error.message });
    }
    if (error instanceof SopExecutionError) {
      if (error.reason === 'INVALID_STATE') {
        return json(409, { error: PHARMACY_SOP_CHANGED_MESSAGE, conflict: true });
      }
      const status =
        error.reason === 'NOT_FOUND' || error.reason === 'STEP_NOT_FOUND'
          ? 404
          : error.reason === 'NOT_OWNER'
            ? 403
            : 400;
      return json(status, { error: 'Proof could not be added to this procedure.' });
    }
    if (error instanceof StorageUnavailableError) {
      return json(503, { error: 'Proof capture unavailable. Storage is unavailable.' });
    }
    return json(500, { error: 'Proof capture failed. Check the file and try again.' });
  }
}
