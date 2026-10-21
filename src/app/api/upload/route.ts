import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';
import { withApiRoute } from '@/lib/api-route';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { putUpload, StorageUnavailableError } from '@/lib/storage';

export const POST = withApiRoute(
  async (request: Request) => {
    const actor = await resolveTenantActor({ request });
    if (!actor?.session.user?.id) {
      return new Response('Unauthorized', { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json(
        { error: `File exceeds maximum allowed size of ${MAX_ATTACHMENT_BYTES} bytes` },
        { status: 413 }
      );
    }

    // Allowlist safe, non-executable types by BOTH declared MIME and extension.
    // The extension governs how /uploads/* is served same-origin, so this is what
    // blocks stored-XSS via .html / .svg (which would otherwise run inline scripts).
    const ALLOWED_TYPES = new Set([
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'application/pdf',
      'text/plain',
      // Audio (voice messages). Non-executable containers — safe to serve same-origin.
      'audio/webm',
      'audio/ogg',
      'audio/mp4',
      'audio/mpeg',
    ]);
    const ALLOWED_EXT = new Set([
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'pdf',
      'txt',
      // Audio extensions paired with the MIME types above.
      'webm',
      'ogg',
      'oga',
      'm4a',
      'mp4',
      'mp3',
    ]);
    // MediaRecorder reports e.g. `audio/webm;codecs=opus` — match on the base type.
    const baseType = file.type.split(';')[0].trim().toLowerCase();
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    if (!ALLOWED_TYPES.has(baseType) || !ALLOWED_EXT.has(ext)) {
      return NextResponse.json(
        { error: 'Unsupported file type (images, PDF, text, or audio only)' },
        { status: 415 }
      );
    }

    const id = crypto.randomUUID();
    // Strip path separators and reduce to safe ASCII chars only
    const safeName = file.name.replace(/[/\\]/g, '').replace(/[^a-zA-Z0-9._\-]/g, '_');
    const filename = `${id}-${safeName}`;

    // RT-05: write to a PRIVATE dir (outside public/) and return an authenticated
    // delivery URL, so files are no longer world-readable by raw URL.
    await putUpload(
      actor.organization.id,
      filename,
      Buffer.from(await file.arrayBuffer()),
      baseType
    );

    return NextResponse.json({
      url: '/api/files/' + filename,
      name: file.name,
      size: file.size,
      type: file.type,
    });
  },
  (error) => {
    if (error instanceof StorageUnavailableError) {
      return NextResponse.json({ error: 'Uploads are unavailable.' }, { status: 503 });
    }
    console.error('[upload] failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
);
