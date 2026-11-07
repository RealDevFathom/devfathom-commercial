import { NextResponse } from 'next/server';
import { getPlatformSession } from '@/lib/platform/auth';
import { contentSecurityPolicy } from '@/lib/security/content-security-policy';
import {
  canReadPlatformRoute,
  platformReadHrefForPathname,
  platformSafeFallback,
} from '@/lib/platform/read-policy';

const TENANT_HOST_HEADER = 'x-devfathom-host';
const REQUEST_ID_HEADER = 'x-devfathom-request-id';
const INTERNAL_ORGANIZATION_QUERY = 'organizationId';

const publicPaths = [
  '/login',
  '/invite',
  '/forgot-password',
  '/reset-password',
  '/sso',
  '/terminal',
  '/pos',
  '/kds',
  '/meet/',
  '/api/auth',
  '/brand',
  '/wallet',
  '/pharmacy/customer',
];

/**
 * A public path covers itself and what lies under it, never a longer sibling:
 * `/pos` and `/pos/x` are public, `/positions` is not. An entry that already
 * ends in `/` (`/meet/`) covers only what lies under it, as before.
 */
function isPublicPath(pathname: string): boolean {
  return publicPaths.some((path) =>
    path.endsWith('/')
      ? pathname.startsWith(path)
      : pathname === path || pathname.startsWith(`${path}/`)
  );
}

/** Decode repeatedly so double-encoded separators cannot reach static serving. */
function isPrivateUploadPath(pathname: string): boolean {
  let decoded = pathname;
  for (;;) {
    // Treat backslashes and duplicate separators conservatively, too.
    const segments: string[] = [];
    for (const segment of decoded.replace(/\\/g, '/').toLowerCase().split('/')) {
      if (segment === '..') segments.pop();
      else if (segment && segment !== '.') segments.push(segment);
    }
    if (segments[0] === 'uploads' || segments[0] === 'private-uploads') return true;
    // Decode individual octets so an unrelated malformed escape cannot hide
    // a valid encoded upload prefix. Each iteration shortens the string.
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    );
    if (next === decoded) return false;
    decoded = next;
  }
}

export async function proxy(request: Request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  // Before auth, host redirects, and especially the static-extension bypass.
  // File access belongs exclusively to the authorized /api/files route.
  if (isPrivateUploadPath(pathname)) return new NextResponse(null, { status: 404 });
  const forwardedHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const hostWithPort = forwardedHost?.split(',')[0]?.trim().toLowerCase() ?? '';
  const host = hostWithPort.replace(/:\d+$/, '').replace(/\.$/, '');
  const requestHeaders = new Headers(request.headers);
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  // Next reads the request policy and copies its nonce to generated scripts.
  requestHeaders.set('Content-Security-Policy', csp);
  requestHeaders.set('x-nonce', nonce);
  // Host classification ignores ports, but downstream login redirects need the
  // original authority to keep local tenant navigation on the same dev server.
  requestHeaders.set(TENANT_HOST_HEADER, hostWithPort);
  requestHeaders.set(
    REQUEST_ID_HEADER,
    request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID()
  );
  const next = () => {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('Content-Security-Policy', csp);
    if (pathname === '/demo' || pathname.startsWith('/demo/')) {
      response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    }
    return response;
  };
  const baseDomain = (process.env.PLATFORM_BASE_DOMAIN ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
  const isPlatformHost =
    host === 'admin.localhost' || (!!baseDomain && host === `admin.${baseDomain}`);
  const isPlatformPath = pathname === '/platform' || pathname.startsWith('/platform/');
  const isPlatformApi = pathname === '/api/platform' || pathname.startsWith('/api/platform/');
  const isCronWorker = pathname === '/api/platform/jobs/process';
  const cookies = request.headers.get('cookie') || '';
  const hasPlatformSession = cookies.includes('df_platform_session=');

  // Platform routes have a separate, short-lived operator session. Revalidate
  // and authorize it here so denied documents and RSC requests redirect before
  // the platform shell can render identity or route data. Layout/page checks
  // remain in place as defense in depth.
  if (isPlatformPath) {
    if (!isPlatformHost) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
    if (pathname === '/platform/login') {
      // The verifier is the source of truth here, rather than the presence of
      // a cookie. This also keeps the successful destination server-owned and
      // fixed instead of accepting a client-controlled callback.
      const identity = await getPlatformSession(request);
      return identity ? NextResponse.redirect(new URL('/platform', request.url)) : next();
    }
    if (!hasPlatformSession) {
      return NextResponse.redirect(new URL('/platform/login', request.url));
    }
    const identity = await getPlatformSession(request);
    if (!identity) {
      return NextResponse.redirect(new URL('/platform/login', request.url));
    }
    const readHref = platformReadHrefForPathname(pathname);
    if (readHref && !canReadPlatformRoute(identity.role, readHref)) {
      const fallback = platformSafeFallback(identity.role);
      if (fallback) return NextResponse.redirect(new URL(fallback, request.url));
      return new NextResponse(null, { status: 403 });
    }
    return next();
  }

  // Never expose interactive control-plane APIs on a tenant or dedicated host.
  // The worker endpoint is the only exception because Vercel Cron invokes the
  // deployment's canonical URL and authenticates with its own bearer secret.
  if (isPlatformApi && !isCronWorker && !isPlatformHost) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  // Framework assets and API routes must bypass host-level page redirects.
  // In particular, redirecting /_next on admin.<base-domain> prevents the
  // platform login page from hydrating and degrades its form to native HTML.
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    /\.[a-zA-Z0-9]+$/.test(pathname)
  ) {
    return next();
  }

  // Tenant identity comes exclusively from the host and authenticated session.
  // A raw database id in a page URL is neither trusted input nor safe browser
  // history, so canonicalize the URL before auth or rendering handles it.
  if (
    !isPlatformHost &&
    (request.method === 'GET' || request.method === 'HEAD') &&
    url.searchParams.has(INTERNAL_ORGANIZATION_QUERY)
  ) {
    url.searchParams.delete(INTERNAL_ORGANIZATION_QUERY);
    return NextResponse.redirect(url);
  }

  // An admin host never falls through into a tenant workspace. This keeps
  // tenant and control-plane cookies, navigation, and mental models separate.
  if (isPlatformHost && !pathname.startsWith('/api')) {
    return NextResponse.redirect(new URL('/platform', request.url));
  }

  // Allow public paths
  if (pathname === '/demo' || pathname.startsWith('/demo/') || isPublicPath(pathname)) {
    return next();
  }

  // Check for session token
  const hasSession =
    cookies.includes('authjs.session-token') ||
    cookies.includes('__Secure-authjs.session-token') ||
    cookies.includes('df_support_session=');

  if (!hasSession) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', `${pathname}${url.search}`);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect root to dashboard
  if (pathname === '/') {
    return NextResponse.redirect(new URL(isPlatformHost ? '/platform' : '/dashboard', request.url));
  }

  return next();
}
