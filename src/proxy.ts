import { NextResponse } from 'next/server';

const publicPaths = ['/login', '/api/auth', '/brand'];

export function proxy(request: Request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Allow public paths
  if (publicPaths.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  // Allow static assets and API routes
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/trpc') ||
    pathname.startsWith('/api/v1') ||
    pathname.includes('.')
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
