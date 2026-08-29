import { NextResponse } from 'next/server';

const TENANT_HOST_HEADER = 'x-devfathom-host';
const REQUEST_ID_HEADER = 'x-devfathom-request-id';

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
];

export function proxy(request: Request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const forwardedHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const host = (forwardedHost?.split(',')[0]?.trim().toLowerCase() ?? '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(TENANT_HOST_HEADER, host);
  requestHeaders.set(
    REQUEST_ID_HEADER,
    request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID()
  );
  const next = () => NextResponse.next({ request: { headers: requestHeaders } });
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

  // Platform routes have a separate, short-lived operator session. Proxy only
  // performs an optimistic cookie-presence check; the platform layout and every
  // platform API operation revalidate the opaque token against PostgreSQL.
  if (isPlatformPath) {
    if (!isPlatformHost) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
    if (pathname === '/platform/login') return next();
    if (!hasPlatformSession) {
      return NextResponse.redirect(new URL('/platform/login', request.url));
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

  // An admin host never falls through into a tenant workspace. This keeps
  // tenant and control-plane cookies, navigation, and mental models separate.
  if (isPlatformHost && !pathname.startsWith('/api')) {
    return NextResponse.redirect(new URL('/platform', request.url));
  }

  // Allow public paths
  if (publicPaths.some((path) => pathname.startsWith(path))) {
    return next();
  }

  // Check for session token
  const hasSession =
    cookies.includes('authjs.session-token') ||
    cookies.includes('__Secure-authjs.session-token') ||
    cookies.includes('df_support_session=');

  if (!hasSession) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect root to dashboard
  if (pathname === '/') {
    return NextResponse.redirect(new URL(isPlatformHost ? '/platform' : '/dashboard', request.url));
  }

  return next();
}
