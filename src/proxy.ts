import { NextResponse } from 'next/server';

const publicPaths = [
  '/login',
  '/invite',
  '/forgot-password',
  '/reset-password',
  '/api/auth',
  '/brand',
];

export function proxy(request: Request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Allow public paths
  if (publicPaths.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  // Allow static assets and API routes. SEC-03: match a trailing file extension
  // (e.g. `.ico`, `.png`, `.css`) rather than ANY path containing a dot — a dotted
  // route segment no longer bypasses the gate. All /api/* routes pass here because
  // they enforce their own auth (session for app routes, df_ token for /api/v1).
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    /\.[a-zA-Z0-9]+$/.test(pathname)
  ) {
    return NextResponse.next();
  }

  // Check for session token
  const cookies = request.headers.get('cookie') || '';
  const hasSession =
    cookies.includes('authjs.session-token') || cookies.includes('__Secure-authjs.session-token');

  if (!hasSession) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect root to dashboard
  if (pathname === '/') {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  return NextResponse.next();
}
