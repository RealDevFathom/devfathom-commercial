import { contentSecurityPolicy } from './content-security-policy';

const TENANT_HOST_HEADER = 'x-devfathom-host';
const REQUEST_ID_HEADER = 'x-devfathom-request-id';
// DEV-961: the request method, for `resolveTenantActor`, which cannot see it in a server
// component or server action. Always overwritten here, so a client cannot supply it.
const REQUEST_METHOD_HEADER = 'x-devfathom-request-method';

/** Shared by the proxy and the multipart endpoints outside its body clone. */
export function proxyRequestHeaders(request: Request) {
  const forwardedHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const hostWithPort = forwardedHost?.split(',')[0]?.trim().toLowerCase() ?? '';
  const requestHeaders = new Headers(request.headers);
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  // Next reads the request policy and copies its nonce to generated scripts.
  requestHeaders.set('Content-Security-Policy', csp);
  requestHeaders.set('x-nonce', nonce);
  // Host classification ignores ports, but downstream login redirects need the
  // original authority to keep local tenant navigation on the same dev server.
  requestHeaders.set(TENANT_HOST_HEADER, hostWithPort);
  requestHeaders.set(REQUEST_METHOD_HEADER, request.method);
  requestHeaders.set(
    REQUEST_ID_HEADER,
    request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID()
  );
  return { requestHeaders, hostWithPort, csp };
}
