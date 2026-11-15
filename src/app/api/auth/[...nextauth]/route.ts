import type { NextRequest } from 'next/server';
import { handlers } from '@/lib/auth';
import {
  SESSION_UPDATE_AGE_SECONDS,
  withoutRedundantSessionCookie,
} from '@/lib/auth/session-cookie-throttle';

export const { POST } = handlers;

export async function GET(request: NextRequest): Promise<Response> {
  const response = await handlers.GET(request);
  // Auth.js re-issues the JWT session cookie on every session read and ignores
  // `updateAge` for JWT sessions; only re-issue it when something changed.
  if (request.nextUrl.pathname.replace(/\/+$/, '') !== '/api/auth/session') return response;
  return withoutRedundantSessionCookie(request, response, {
    secret: process.env.AUTH_SECRET,
    updateAgeSeconds: SESSION_UPDATE_AGE_SECONDS,
  });
}
