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

/** A loopback, private-network or single-label host: an address only a proxy in front reaches. */
function isInternalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!name) return false;
  if (name === 'localhost' || name === '::1' || !name.includes('.') && !name.includes(':'))
    return true;
  const octets = name.split('.').map(Number);
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    const [a, b] = octets as [number, number, number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return name.endsWith('.internal') || name.endsWith('.local');
}

/**
 * DEV-957 phase 2: this site's origin for an exact Origin comparison, without trusting a
 * client-supplied X-Forwarded-Host. The forwarded host and protocol are read only when the
 * server itself is reached on an internal address (a loopback, private-network or
 * single-label host, as behind a reverse proxy), where only that proxy can reach it and
 * sets them. A request that reaches the server on its public host is judged by the host it
 * actually connected to (the Host header, else request.url), and any X-Forwarded-Host it
 * carries is ignored; X-Forwarded-Proto can still say https for that same host.
 */
export function trustedRequestOrigin(request: Request): string {
  const requestUrl = new URL(request.url);
  const connectedHost = request.headers.get('host')?.trim() || requestUrl.host;
  if (isInternalHost(connectedHost) && request.headers.get('x-forwarded-host'))
    return publicRequestOrigin(request);
  // The protocol may come from a TLS-terminating proxy; it can only choose http or https
  // for the host the client really connected to, never another host.
  const protocol = (
    request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    requestUrl.protocol.slice(0, -1)
  ).toLowerCase();
  if (!['http', 'https'].includes(protocol) || !connectedHost)
    throw new Error('Invalid public request origin.');
  const origin = new URL(`${protocol}://${connectedHost}`).origin.toLowerCase();
  if (!origin.startsWith(`${protocol}://`)) throw new Error('Invalid public request origin.');
  return origin;
}
