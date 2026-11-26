import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';
import { acquireLargeUploadSlot } from './large-upload-slot';
import { consumeBoundedBody } from '@/lib/http/read-bounded-body';
import { proxyRequestHeaders } from '@/lib/security/proxy-request-headers';

export const UPLOAD_SIZE_MESSAGE = 'Choose a file of 25 MB or smaller.';

// Allow room for the multipart boundary, part headers and SOP attribution
// fields. Each route separately checks the actual file against its 25 MB cap.
const MAX_MULTIPART_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024;

const LARGE_UPLOAD_BYTES = 8 * 1024 * 1024;
// A 25 MiB file takes about 210 seconds at 1 Mbit/s. Allow another minute
// for multipart overhead and normal variation in throughput.
const UPLOAD_BODY_DEADLINE_MS = 270_000;
type ReadUploadForm = (
  userId: string,
  organizationId: string,
  errorFormat?: 'json' | 'text'
) => Promise<FormData | Response | null>;

class UploadRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly plain = true
  ) {
    super(message);
  }
}

/** Hold a user's slot until their handler has finished storage and cleanup. */
export function uploadPost(
  handler: (request: Request, readUploadForm: ReadUploadForm) => Promise<Response>
) {
  return async (request: Request) => {
    const { requestHeaders, csp } = proxyRequestHeaders(request);
    const routed = new Request(request, {
      headers: requestHeaders,
      body: request.body,
      duplex: 'half',
    } as RequestInit);
    let release: (() => Promise<void>) | undefined;
    async function reserve(userId: string, organizationId: string) {
      let slot: Awaited<ReturnType<typeof acquireLargeUploadSlot>>;
      try {
        slot = await acquireLargeUploadSlot(userId, organizationId);
      } catch {
        throw new UploadRefused('Uploads are temporarily unavailable. Try again shortly.', 503);
      }
      if (slot === 'organization-capacity')
        throw new UploadRefused('Large uploads are busy. Try again shortly.', 429);
      if (!slot)
        throw new UploadRefused(
          'Two large uploads are in progress. Wait for one to finish and try again.',
          429,
          false
        );
      release = slot;
    }
    async function readUploadForm(
      userId: string,
      organizationId: string,
      errorFormat: 'json' | 'text' = 'json'
    ) {
      const declared = Number(routed.headers.get('content-length'));
      if (declared > MAX_MULTIPART_BYTES) return null;
      const chunks: Uint8Array[] = [];
      const deadline = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (declared > LARGE_UPLOAD_BYTES) await reserve(userId, organizationId);
        timer = setTimeout(() => deadline.abort(), UPLOAD_BODY_DEADLINE_MS);
        const complete = await consumeBoundedBody(
          routed,
          MAX_MULTIPART_BYTES,
          (chunk, total) => {
            if (total > LARGE_UPLOAD_BYTES && !release) {
              return reserve(userId, organizationId).then(() => {
                chunks.push(chunk);
              });
            }
            chunks.push(chunk);
          },
          deadline.signal
        );
        if (!complete) return null;
      } catch (error) {
        if (error instanceof UploadRefused) {
          return error.plain || errorFormat === 'text'
            ? new Response(error.message, { status: error.status })
            : Response.json({ error: error.message }, { status: error.status });
        }
        if (deadline.signal.aborted) {
          return new Response('The upload took too long. Try again shortly.', { status: 408 });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
      return new Response(Buffer.concat(chunks), { headers: routed.headers }).formData();
    }
    try {
      const response = await handler(routed, readUploadForm);
      response.headers.set('Content-Security-Policy', csp);
      return response;
    } finally {
      await release?.();
    }
  };
}

// Preserve Next's automatic method responses and their proxy CSP as well.
export function uploadMethodResponse(request: Request) {
  const { csp } = proxyRequestHeaders(request);
  const headers = new Headers({ 'Content-Security-Policy': csp });
  if (request.method === 'OPTIONS') {
    headers.set('Allow', 'OPTIONS, POST');
    return new Response(null, { status: 204, headers });
  }
  return new Response(null, { status: 405, headers });
}
