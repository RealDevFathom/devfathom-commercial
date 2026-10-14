/**
 * Next.js can expose an internal runtime URL in request.url while the browser
 * is using a tenant, admin, preview, or dedicated host. Reconstruct URLs that
 * leave the server from the proxy-normalized public host and protocol.
 */
export function publicRequestOrigin(request: Request): string {
  const requestUrl = new URL(request.url);
  const forwardedHost =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ??
    request.headers.get('host')?.trim() ??
    requestUrl.host;
  const forwardedProtocol =
    request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() ??
    requestUrl.protocol.slice(0, -1);
  if (!['http', 'https'].includes(forwardedProtocol) || !forwardedHost) {
    throw new Error('Invalid public request origin.');
  }
  const origin = new URL(`${forwardedProtocol}://${forwardedHost}`).origin.toLowerCase();
  if (!origin.startsWith(`${forwardedProtocol}://`)) {
    throw new Error('Invalid public request origin.');
  }
  return origin;
}

export function publicRequestUrl(request: Request): URL {
  const internal = new URL(request.url);
  return new URL(`${internal.pathname}${internal.search}`, publicRequestOrigin(request));
}
