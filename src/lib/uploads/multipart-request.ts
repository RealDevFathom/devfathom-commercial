import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';
import { acquireLargeUploadSlot } from './large-upload-slot';
import { consumeBoundedBody } from '@/lib/http/read-bounded-body';
import { proxyRequestHeaders } from '@/lib/security/proxy-request-headers';
import { rateLimit } from '@/lib/rate-limit';

export const UPLOAD_SIZE_MESSAGE = 'Choose a file of 25 MB or smaller.';

// Allow room for the multipart boundary, part headers and SOP attribution
// fields. Each route separately checks the actual file against its 25 MB cap.
const MAX_MULTIPART_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024;

const LARGE_UPLOAD_BYTES = 8 * 1024 * 1024;
// A 25 MiB file takes about 210 seconds at 1 Mbit/s. Allow another minute
// for multipart overhead and normal variation in throughput.
const UPLOAD_BODY_DEADLINE_MS = 270_000;
// DEV-1056: how often an account may start an upload, whatever its size. The large-upload
// slots bound how many large transfers run at once, not how many uploads are made, so a
// signed-in account could otherwise post small files in a loop. A person attaching files
// by hand stays far below 60 in ten minutes (one every ten seconds, sustained); a business
// gets ten times that for its whole staff. Refused attempts count too. This limits
// requests, not stored bytes.
export const UPLOAD_RATE_WINDOW_MS = 10 * 60 * 1000;
export const UPLOADS_PER_USER_PER_WINDOW = 60;
export const UPLOADS_PER_BUSINESS_PER_WINDOW = 600;
export const UPLOAD_RATE_MESSAGE = 'Too many uploads. Wait a few minutes and try again.';

/**
 * Count one upload against its user, then its business. Returns the refusal, or `null`.
 * A user over their own limit is refused before the business is charged, so one account
 * cannot spend the whole business's allowance with refused requests.
 */
async function uploadRateRefusal(userId: string, organizationId: string) {
  for (const [key, limit] of [
    [`upload:user:${userId}`, UPLOADS_PER_USER_PER_WINDOW],
    [`upload:org:${organizationId}`, UPLOADS_PER_BUSINESS_PER_WINDOW],
  ] as const) {
    const result = await rateLimit(key, limit, UPLOAD_RATE_WINDOW_MS);
    if (!result.ok) {
      return new Response(UPLOAD_RATE_MESSAGE, {
        status: 429,
        headers: { 'Retry-After': String(Math.max(1, result.retryAfter)) },
      });
    }
  }
  return null;
}

type ReadUploadForm = (
  userId: string,
  organizationId: string,
  errorFormat?: 'json' | 'text',
  maxFileBytes?: number
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
    // Next wraps the incoming request. Reuse its stream without asking the
    // native Request constructor to read private fields from the wrapper.
    const routed = new Request(request.url, {
      method: request.method,
      signal: request.signal,
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
      errorFormat: 'json' | 'text' = 'json',
      maxFileBytes = MAX_ATTACHMENT_BYTES
    ) {
      // The caller has resolved the session; nothing of the body has been read yet.
      const rateRefusal = await uploadRateRefusal(userId, organizationId);
      if (rateRefusal) return rateRefusal;
      const maxMultipartBytes = Math.min(MAX_MULTIPART_BYTES, maxFileBytes + 64 * 1024);
      const declared = Number(routed.headers.get('content-length'));
      if (declared > maxMultipartBytes) return null;
      const chunks: Uint8Array[] = [];
      const deadline = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (declared > LARGE_UPLOAD_BYTES) await reserve(userId, organizationId);
        timer = setTimeout(() => deadline.abort(), UPLOAD_BODY_DEADLINE_MS);
        const complete = await consumeBoundedBody(
          routed,
          maxMultipartBytes,
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
