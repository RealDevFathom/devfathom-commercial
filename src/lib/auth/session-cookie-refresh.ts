import { createHmac, timingSafeEqual } from 'node:crypto';

export const JWT_SESSION_UPDATE_AGE_SECONDS = 60 * 60;

const UPDATE_COOKIE = 'authjs.session-updated';
const SECURE_UPDATE_COOKIE = `__Secure-${UPDATE_COOKIE}`;
const SESSION_COOKIE_PATTERN = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?=/;

function signature(secret: string, cookieName: string, updatedAt: number): string {
  return createHmac('sha256', secret).update(`${cookieName}:${updatedAt}`).digest('base64url');
}

function validUpdateCookie(request: Request, secret: string, now: number): boolean {
  const cookies = request.headers.get('cookie') ?? '';
  for (const part of cookies.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName !== UPDATE_COOKIE && rawName !== SECURE_UPDATE_COOKIE) continue;

    const [timestampText, suppliedSignature] = rawValue.join('=').split('.');
    const updatedAt = Number(timestampText);
    if (
      !Number.isSafeInteger(updatedAt) ||
      updatedAt > now ||
      now - updatedAt >= JWT_SESSION_UPDATE_AGE_SECONDS ||
      !suppliedSignature
    ) {
      return false;
    }

    const expected = Buffer.from(signature(secret, rawName, updatedAt));
    const supplied = Buffer.from(suppliedSignature);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  return false;
}

function updateCookie(cookieName: string, secret: string, now: number, secure: boolean): string {
  const value = `${now}.${signature(secret, cookieName, now)}`;
  return [
    `${cookieName}=${value}`,
    'Path=/',
    `Max-Age=${JWT_SESSION_UPDATE_AGE_SECONDS}`,
    'HttpOnly',
    secure ? 'Secure' : '',
    'SameSite=Lax',
  ]
    .filter(Boolean)
    .join('; ');
}

/**
 * Auth.js intentionally rotates JWT cookies on every session read and does not
 * apply session.updateAge to the JWT strategy. Keep its validation/session
 * callbacks intact, but discard that redundant rotation inside the update
 * window. A signed HttpOnly marker prevents a client from extending the window.
 */
export async function handleAuthRequest(
  request: Request,
  handler: (request: Request) => Promise<Response>,
  options: { secret?: string; now?: number } = {}
): Promise<Response> {
  const response = await handler(request);
  const secret = options.secret;
  if (!secret) return response;

  const setCookies = response.headers.getSetCookie();
  const issuedSessionCookies = setCookies.filter(
    (cookie) => SESSION_COOKIE_PATTERN.test(cookie) && !/;\s*Max-Age=0(?:;|$)/i.test(cookie)
  );
  if (issuedSessionCookies.length === 0) return response;

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const isSessionRead = new URL(request.url).pathname.endsWith('/api/auth/session');
  if (isSessionRead && validUpdateCookie(request, secret, now)) {
    response.headers.delete('set-cookie');
    for (const cookie of setCookies) {
      if (!issuedSessionCookies.includes(cookie)) response.headers.append('set-cookie', cookie);
    }
    return response;
  }

  const secure = issuedSessionCookies.some((cookie) =>
    /^__Secure-authjs\.session-token(?:\.\d+)?=/.test(cookie)
  );
  const cookieName = secure ? SECURE_UPDATE_COOKIE : UPDATE_COOKIE;
  response.headers.append('set-cookie', updateCookie(cookieName, secret, now, secure));
  return response;
}
