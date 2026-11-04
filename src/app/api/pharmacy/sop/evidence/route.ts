import crypto from 'node:crypto';

import { TRPCError } from '@trpc/server';

import { responseForPasswordChange } from '@/lib/auth/session-state';
import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';
import { publicRequestOrigin } from '@/lib/http-origin';
import { SopExecutionError, attachEvidence } from '@/lib/restaurant/sop-execution';
import { deleteUpload, putUpload, StorageUnavailableError } from '@/lib/storage';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacySopRouter } from '@/server/routers/pharmacy-sop';
import { createTRPCContext } from '@/server/trpc';

/**
 * DEV-751 — multipart proof capture for a pharmacy SOP occurrence.
 *
 * Authorization is the `pharmacySop.evidenceTarget` procedure, called through a
 * server-side caller so the upload passes the same gates as every pharmacy SOP
 * procedure: a usable session, the `pharmacy-safety` module, `sop:complete`,
 * the caller's pharmacy branch assignment, the occurrence belonging to that
 * branch's SOP site, and the occurrence being the caller's own work in
 * progress. The uploader is always the session actor that procedure resolves;
 * an uploader field in the form is never read.
 *
 * Nothing is stored before authorization passes. A retry with the same bytes
 * resolves to the same evidence row (the engine's retry-identity unique), and
 * the redundant blob is removed. Any failure after storage removes the blob,
 * so a refused or interrupted upload leaves no evidence row and no orphan file.
 */

export const runtime = 'nodejs';

const EVIDENCE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

type Stage = 'file_validation' | 'authorization' | 'storage' | 'attach' | 'cleanup';

class EvidenceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceInputError';
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
      throw new EvidenceInputError('Branch and occurrence are required.');
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
    const target = await pharmacySopRouter.createCaller(ctx).evidenceTarget({
      pharmacyBranchId,
      occurrenceId,
      occurrenceStepId,
    });

    stage = 'storage';
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    storedFilename = `sop-${crypto.randomUUID()}.${extension}`;
    await putUpload(organizationId, storedFilename, bytes, baseType);

    stage = 'attach';
    const evidence = await attachEvidence(ctx.db, {
      occurrenceId: target.occurrenceId,
      occurrenceStepId: target.occurrenceStepId,
      contentHashHex: hash,
      mimeType: `${baseType}; evidence=${purpose}`,
      sizeBytes: bytes.length,
      storageRef: `/api/files/${storedFilename}`,
      uploaderStaffProfileId: target.uploaderStaffProfileId,
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
    if (error instanceof TRPCError) {
      const status = TRPC_STATUS[error.code];
      if (status) return json(status, { error: error.message });
    }
    if (error instanceof SopExecutionError) {
      const status =
        error.reason === 'NOT_FOUND' || error.reason === 'STEP_NOT_FOUND'
          ? 404
          : error.reason === 'NOT_OWNER'
            ? 403
            : error.reason === 'INVALID_STATE'
              ? 409
              : 400;
      return json(status, { error: 'Proof could not be attached to this occurrence.' });
    }
    if (error instanceof StorageUnavailableError) {
      return json(503, { error: 'Proof capture unavailable. Storage is unavailable.' });
    }
    return json(500, { error: 'Proof capture failed. Check the file and try again.' });
  }
}
