import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { publicRequestOrigin } from '@/lib/http-origin';
import { rateLimit } from '@/lib/rate-limit';
import { ipFromHeaders } from '@/server/audit';
import { workspaceRequestSchema } from '@/app/login/register/request-schema';
import {
  LICENCE_DOCUMENT_REFUSAL,
  MAX_LICENCE_FILE_BYTES,
  verifyLicenceDocument,
} from '@/lib/workspace-requests/licence-document';

const MAX_BODY = MAX_LICENCE_FILE_BYTES + 64 * 1024;

/** Public intake only: creates a NEW platform lead, never a user, tenant or session. */
export async function POST(request: Request) {
  try {
    if (
      request.headers.get('origin')?.toLowerCase() !== publicRequestOrigin(request) ||
      !['same-origin', 'none', null].includes(request.headers.get('sec-fetch-site'))
    )
      return Response.json({ error: 'Not allowed.' }, { status: 403 });
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data'))
      return Response.json({ error: 'Submit the workspace request form.' }, { status: 415 });
    const gate = await rateLimit(
      `workspace-request:ip:${ipFromHeaders(request.headers) ?? 'unknown'}`,
      5,
      60 * 60_000
    );
    if (!gate.ok)
      return Response.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } }
      );
    // Bound actual streamed bytes, including requests without Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: 'The form is empty.' }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        return Response.json(
          { error: 'Use a licence document smaller than 1 MB.' },
          { status: 413 }
        );
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    let form: FormData;
    try {
      form = await new Request(request.url, {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type')! },
        body: bytes,
      }).formData();
    } catch {
      return Response.json(
        { error: 'The form could not be read. Please try again.' },
        { status: 400 }
      );
    }
    const parsed = workspaceRequestSchema.safeParse({
      ...Object.fromEntries(form),
      channels: form.getAll('channels'),
    });
    if (!parsed.success)
      return Response.json(
        { error: 'Check the highlighted fields.', fields: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    let document: { name: string; type: string; base64: string; checked: true } | undefined;
    if (parsed.data.vertical === 'pharmacy') {
      const file = form.get('licenceCopy');
      if (!(file instanceof File) || !file.size || file.size > MAX_LICENCE_FILE_BYTES)
        return Response.json(
          {
            error: 'Upload a PDF, JPG or PNG licence copy, up to 1 MB.',
            fields: { licenceCopy: ['A licence copy up to 1 MB is required.'] },
          },
          { status: 400 }
        );
      const buffer = Buffer.from(await file.arrayBuffer());
      const verified = await verifyLicenceDocument(buffer, file.type);
      if (!verified)
        return Response.json(
          {
            error: LICENCE_DOCUMENT_REFUSAL,
            fields: { licenceCopy: [LICENCE_DOCUMENT_REFUSAL] },
          },
          { status: 400 }
        );
      // Private evidence stays inside the existing platform lead; no public upload URL.
      document = {
        ...verified,
        checked: true,
        base64: buffer.toString('base64'),
      };
    }
    const lead = await withPlatformDb((db) =>
      db.platformLead.create({
        data: {
          name: parsed.data.ownerName,
          email: parsed.data.email,
          phone: parsed.data.phone,
          companyName: parsed.data.companyName,
          status: 'NEW',
          source: `workspace-request:${parsed.data.vertical}`,
          notes: JSON.stringify({
            kind: 'workspace-request',
            approval: 'pending',
            details: parsed.data,
            document,
          }),
        },
        select: { id: true },
      })
    );
    return Response.json(
      { id: lead.id, status: 'pending' },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return Response.json(
      { error: 'We could not save your request. Your details are still here. Please try again.' },
      { status: 503 }
    );
  }
}
