import { uploadPost, UPLOAD_SIZE_MESSAGE } from '@/lib/uploads/multipart-request';
import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';
import { responseForPasswordChange } from '@/lib/auth/session-state';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { deleteUpload, putUpload, StorageUnavailableError } from '@/lib/storage';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { registerUpload } from '@/lib/uploads/registry';

export const POST = uploadPost(async (request, readUploadForm) => {
  try {
    const actor = await resolveTenantActor({ request });
    if (!actor?.session.user?.id) {
      return new Response('Unauthorized', { status: 401 });
    }
    const uploadedById = actor.session.user.id;

    const formData = await readUploadForm(uploadedById);
    if (formData instanceof Response) return formData;
    if (!formData) return NextResponse.json({ error: UPLOAD_SIZE_MESSAGE }, { status: 413 });
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json({ error: UPLOAD_SIZE_MESSAGE }, { status: 413 });
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
    // DEV-837: record who uploaded this object, server-side. Attaching it to a
    // project, task or contract later binds it, and only its uploader can.
    // An object the registry does not know is never served, so a failed
    // registration removes the stored object rather than leaving it orphaned.
    try {
      await withTenantDb(actor.organization.id, (db) =>
        registerUpload(db, { name: filename, uploadedById })
      );
    } catch (error) {
      await deleteUpload(actor.organization.id, filename).catch(() => undefined);
      throw error;
    }

    return NextResponse.json({
      url: '/api/files/' + filename,
      name: file.name,
      size: file.size,
      type: file.type,
    });
  } catch (error) {
    const passwordChange = responseForPasswordChange(error);
    if (passwordChange) return passwordChange;
    if (error instanceof StorageUnavailableError) {
      return NextResponse.json({ error: 'Uploads are unavailable.' }, { status: 503 });
    }
    console.error('[upload] failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});

export {
  uploadMethodResponse as GET,
  uploadMethodResponse as HEAD,
  uploadMethodResponse as PUT,
  uploadMethodResponse as PATCH,
  uploadMethodResponse as DELETE,
  uploadMethodResponse as OPTIONS,
} from '@/lib/uploads/multipart-request';
