import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';
import { readBoundedBody } from '@/lib/http/read-bounded-body';
import { proxyRequestHeaders } from '@/lib/security/proxy-request-headers';

export const UPLOAD_SIZE_MESSAGE = 'Choose a file of 25 MB or smaller.';

// Allow room for the multipart boundary, part headers and SOP attribution
// fields. Each route separately checks the actual file against its 25 MB cap.
const MAX_MULTIPART_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024;

export async function readUploadForm(request: Request): Promise<FormData | null> {
  const bytes = await readBoundedBody(request, MAX_MULTIPART_BYTES);
  if (bytes === null) return null;
  return new Response(bytes, { headers: request.headers }).formData();
}

/** API routes normally pass through the proxy with these request and response
 * headers. Transfer the unconsumed stream to the route without cloning it. */
export function uploadPost(handler: (request: Request) => Promise<Response>) {
  return async (request: Request) => {
    const { requestHeaders, csp } = proxyRequestHeaders(request);
    const response = await handler(new Request(request, { headers: requestHeaders }));
    response.headers.set('Content-Security-Policy', csp);
    return response;
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
