import { NextRequest } from 'next/server';
import { handlers } from '@/lib/auth';
import { readBoundedBody } from '@/lib/http/read-bounded-body';
import {
  SESSION_UPDATE_AGE_SECONDS,
  withoutRedundantSessionCookie,
} from '@/lib/auth/session-cookie-throttle';

export async function POST(request: NextRequest): Promise<Response> {
  if (!request.body) return handlers.POST(request);
  const body = await readBoundedBody(request, 32 * 1024).catch(() => undefined);
  if (body === null) return Response.json({ error: 'Request body is too large.' }, { status: 413 });
  if (body === undefined) return Response.json('Bad request.', { status: 400 });

  return handlers.POST(
    new NextRequest(request.url, {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      body,
    })
  );
}

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
