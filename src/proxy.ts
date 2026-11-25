import { NextResponse } from 'next/server';
import { getPlatformSession } from '@/lib/platform/auth';
import { proxyRequestHeaders } from '@/lib/security/proxy-request-headers';
import {
  canReadPlatformRoute,
  platformReadHrefForPathname,
  platformSafeFallback,
} from '@/lib/platform/read-policy';

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
  // DEV-15: customer PWA; its own portal session, never a staff session.
  '/my-pharmacy',
  '/apply',
  '/student',
  // DEV-16: tokenized hosted receipts; the token, not a session, grants access.
  '/receipt',
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

function isWorkspaceRequestDownload(pathname: string): boolean {
  try {
    return /^\/api\/platform\/workspace-requests\/[^/]+\/?$/.test(decodeURIComponent(pathname));
  } catch {
    return false;
  }
}

export async function proxy(request: Request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  // Before auth, host redirects, and especially the static-extension bypass.
  // File access belongs exclusively to the authorized /api/files route.
  if (isPrivateUploadPath(pathname)) return new NextResponse(null, { status: 404 });
  const { requestHeaders, hostWithPort, csp } = proxyRequestHeaders(request);
  const host = hostWithPort.replace(/:\d+$/, '').replace(/\.$/, '');
  const next = () => {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    // Next uses the proxy's response header in place of the handler's policy.
    // Keep the page policy and enforce the attachment sandbox at this boundary.
    response.headers.set(
      'Content-Security-Policy',
      isWorkspaceRequestDownload(pathname) ? `${csp}; sandbox` : csp
    );
    if (pathname === '/demo' || pathname.startsWith('/demo/')) {
      response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    }
    if (pathname === '/receipt' || pathname.startsWith('/receipt/')) {
      // A receipt link is private: never indexed, cached, or leaked as a referrer.
      response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
      response.headers.set('Referrer-Policy', 'no-referrer');
      response.headers.set('Cache-Control', 'private, no-store');
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

// These exact route handlers apply the API header policy themselves and bound
// the multipart stream. All other paths keep Next's 8 MB proxy clone limit.
export const config = {
  matcher: '/((?!api/(?:upload|(?:restaurant|pharmacy)/sop/evidence)/?$).*)',
};
