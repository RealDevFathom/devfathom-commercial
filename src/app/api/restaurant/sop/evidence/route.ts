import crypto from 'node:crypto';

import { NextResponse } from 'next/server';

import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';
import { can, subjectFromSession } from '@/lib/abac';
import { attachEvidence } from '@/lib/restaurant/sop-execution';
import { deleteUpload, putUpload } from '@/lib/storage';
import { createTRPCContext } from '@/server/trpc';

const EVIDENCE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

function destination(request: Request, form: FormData, notice: string, kind: 'success' | 'error') {
  const url = new URL('/restaurant/sop', request.url);
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
  if (origin && origin !== new URL(request.url).origin) {
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
  try {
    const file = form.get('file');
    const purpose = String(form.get('evidencePurpose') ?? '').trim();
    const occurrenceId = String(form.get('occurrenceId') ?? '').trim();
    const occurrenceStepId = String(form.get('occurrenceStepId') ?? '').trim();
    const uploaderStaffProfileId = String(form.get('uploaderStaffProfileId') ?? '').trim();
    if (!(file instanceof File) || file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Choose a file between 1 byte and ${MAX_ATTACHMENT_BYTES} bytes.`);
    }
    if (purpose !== 'photo' && purpose !== 'signature') {
      throw new Error('Choose whether this file is photo or signature proof.');
    }
    const baseType = file.type.split(';')[0]!.trim().toLowerCase();
    const extension = EVIDENCE_TYPES[baseType as keyof typeof EVIDENCE_TYPES];
    if (!extension) throw new Error('Proof must be a JPEG, PNG, or WebP image.');
    if (!occurrenceId || !occurrenceStepId || !uploaderStaffProfileId) {
      throw new Error('Occurrence, checklist step, and uploader are required.');
    }

    const ctx = await createTRPCContext({ req: request });
    organizationId = ctx.organization?.id ?? ctx.session?.user?.organizationId ?? null;
    if (!organizationId || !ctx.session?.user) throw new Error('Workspace not found.');
    const allowed = await can(subjectFromSession(ctx.session.user), 'sop:complete', undefined, {
      db: ctx.db,
      source: 'TRPC',
    });
    if (!allowed) throw new Error('You do not have permission to capture SOP proof.');

    const bytes = Buffer.from(await file.arrayBuffer());
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    storedFilename = `sop-${crypto.randomUUID()}.${extension}`;
    await putUpload(organizationId, storedFilename, bytes, baseType);

    await attachEvidence(ctx.db, {
      occurrenceId,
      occurrenceStepId,
      contentHashHex: hash,
      mimeType: `${baseType}; evidence=${purpose}`,
      sizeBytes: bytes.length,
      storageRef: `/api/files/${storedFilename}`,
      uploaderStaffProfileId,
    });
    return NextResponse.redirect(destination(request, form, 'Proof captured.', 'success'), 303);
  } catch (error) {
    if (storedFilename && organizationId) {
      await deleteUpload(organizationId, storedFilename).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : 'Proof capture failed.';
    return NextResponse.redirect(destination(request, form, message, 'error'), 303);
  }
}
