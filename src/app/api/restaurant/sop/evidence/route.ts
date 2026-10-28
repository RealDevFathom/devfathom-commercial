import crypto from 'node:crypto';

import { NextResponse } from 'next/server';

import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';
import { can, subjectFromSession } from '@/lib/abac';
import { publicRequestOrigin } from '@/lib/http-origin';
import { attachEvidence } from '@/lib/restaurant/sop-execution';
import { deleteUpload, putUpload, StorageUnavailableError } from '@/lib/storage';
import { resolveRestaurantActor } from '@/server/restaurant-actor';
import { createTRPCContext } from '@/server/trpc';

const EVIDENCE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

type EvidenceCaptureStage =
  'file_validation' | 'context' | 'authorization' | 'storage' | 'attach' | 'cleanup';

function warnEvidenceCaptureFailure(stage: EvidenceCaptureStage, error: unknown) {
  try {
    console.warn(
      'restaurant_sop_evidence_capture_failed',
      JSON.stringify({
        event: 'restaurant_sop_evidence_capture_failed',
        stage,
        errorClass: error instanceof Error ? error.name : typeof error,
      })
    );
  } catch {
    // Telemetry must never change the public failure response.
  }
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
    throw new Error(`Choose a file between 1 byte and ${MAX_ATTACHMENT_BYTES} bytes.`);
  }

  const baseType = value.type.split(';')[0]!.trim().toLowerCase();
  const extension = EVIDENCE_TYPES[baseType as keyof typeof EVIDENCE_TYPES];
  if (!extension) throw new Error('Proof must be a JPEG, PNG, or WebP image.');

  const bytes = Buffer.from(await value.arrayBuffer());
  if (bytes.length !== value.size) throw new Error('Invalid file metadata.');
  return { baseType, bytes, extension };
}

function destination(request: Request, form: FormData, notice: string, kind: 'success' | 'error') {
  const url = new URL('/restaurant/sop', publicRequestOrigin(request));
  for (const key of ['branchId', 'businessDate', 'occurrenceId'] as const) {
    const value = String(form.get(key) ?? '').trim();
    if (value && !value.includes('/') && value.length <= 100) {
      url.searchParams.set(
        key === 'branchId' ? 'branch' : key === 'businessDate' ? 'date' : 'occurrence',
        value
      );
    }
  }
  url.searchParams.set('kind', kind);
  url.searchParams.set('notice', notice.slice(0, 500));
  return url;
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  let sameOrigin = false;
  try {
    sameOrigin =
      origin !== null &&
      new URL(origin).origin.toLowerCase() === publicRequestOrigin(request) &&
      (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none');
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) {
    return new Response('Forbidden', { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response('Invalid multipart form.', { status: 400 });
  }

  let storedFilename: string | null = null;
  let organizationId: string | null = null;
  let stage: EvidenceCaptureStage = 'file_validation';
  try {
    const file = form.get('file');
    const purpose = String(form.get('evidencePurpose') ?? '').trim();
    const occurrenceId = String(form.get('occurrenceId') ?? '').trim();
    const occurrenceStepId = String(form.get('occurrenceStepId') ?? '').trim();
    const { baseType, bytes, extension } = await readEvidenceFile(file);
    if (purpose !== 'photo' && purpose !== 'signature') {
      throw new Error('Choose whether this file is photo or signature proof.');
    }
    if (!occurrenceId || !occurrenceStepId) {
      throw new Error('Occurrence and checklist step are required.');
    }

    stage = 'context';
    const ctx = await createTRPCContext({ req: request });
    organizationId = ctx.organization?.id ?? ctx.session?.user?.organizationId ?? null;
    if (!organizationId || !ctx.session?.user) throw new Error('Workspace not found.');
    stage = 'authorization';
    const allowed = await can(subjectFromSession(ctx.session.user), 'sop:complete', undefined, {
      db: ctx.db,
      source: 'TRPC',
    });
    if (!allowed) throw new Error('You do not have permission to capture SOP proof.');
    const occurrence = await ctx.db.restaurantSopOccurrence.findUnique({
      where: { id: occurrenceId },
      select: { branchId: true },
    });
    if (!occurrence) throw new Error('Occurrence not found.');
    const { staffProfileId: uploaderStaffProfileId } = await resolveRestaurantActor(ctx, [
      occurrence.branchId,
    ]);

    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    storedFilename = `sop-${crypto.randomUUID()}.${extension}`;
    stage = 'storage';
    await putUpload(organizationId, storedFilename, bytes, baseType);

    stage = 'attach';
    const evidence = await attachEvidence(ctx.db, {
      occurrenceId,
      occurrenceStepId,
      contentHashHex: hash,
      mimeType: `${baseType}; evidence=${purpose}`,
      sizeBytes: bytes.length,
      storageRef: `/api/files/${storedFilename}`,
      uploaderStaffProfileId,
    });
    if (!evidence.created) {
      stage = 'cleanup';
      await deleteUpload(organizationId, storedFilename);
      storedFilename = null;
    }
    return NextResponse.redirect(destination(request, form, 'Proof captured.', 'success'), 303);
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
        warnEvidenceCaptureFailure('cleanup', cleanupError);
        return NextResponse.redirect(
          destination(
            request,
            form,
            'Proof capture failed. Stored file cleanup is incomplete.',
            'error'
          ),
          303
        );
      }
    }
    warnEvidenceCaptureFailure(stage, error);
    return NextResponse.redirect(
      destination(
        request,
        form,
        stage === 'cleanup'
          ? 'Proof capture failed. Stored file cleanup is incomplete.'
          : error instanceof StorageUnavailableError
            ? 'Proof capture unavailable. Storage is unavailable.'
            : 'Proof capture failed. Check the file and try again.',
        'error'
      ),
      303
    );
  }
}
