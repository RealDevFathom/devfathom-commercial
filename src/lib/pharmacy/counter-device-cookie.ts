import { trustedRequestOrigin } from '@/lib/http-origin';

/**
 * DEV-957 phase 1: how an enrolled pharmacy counter browser presents its device
 * credential without JavaScript ever holding it again after enrolment.
 *
 * The raw `pcd_…` secret lives in a host-only, httpOnly, SameSite=Strict cookie
 * scoped to the counter API. The rules are the restaurant browser terminal's
 * (`deviceSecretFromRequest` in src/lib/restaurant/terminal-auth.ts):
 *
 *  - a request carrying BOTH the cookie and an Authorization header is refused,
 *    because two credential channels make it ambiguous which device is acting;
 *  - the cookie is accepted only on a state-changing request whose Origin header
 *    is present and exactly this site's public origin (no Origin, another
 *    origin, or a malformed one is refused). DEV-957 phase 2: that origin comes
 *    from `trustedRequestOrigin`, which reads a client-supplied X-Forwarded-Host
 *    only when the server is reached on an internal address behind a proxy;
 *  - the bearer header keeps working for tools and tests, with no extra rule.
 */
export const PHARMACY_COUNTER_DEVICE_COOKIE = 'df_pharmacy_counter_device';
/** The cookie is sent only to the counter's own API, never to pages or tRPC. */
export const PHARMACY_COUNTER_DEVICE_COOKIE_PATH = '/api/pharmacy/counter';
/** As the restaurant browser terminal: an enrolment lasts until rotated or revoked. */
export const PHARMACY_COUNTER_DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 180;

const SECRET_FORMAT = /^pcd_[A-Za-z0-9_-]{43}$/;
const BEARER_PREFIX = 'Bearer ';

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join('='));
    } catch {
      return null;
    }
  }
  return null;
}

export type CounterDeviceCredential =
  | { ok: true; secret: string; cookie: boolean }
  | { ok: false; reason: 'missing' | 'ambiguous' | 'malformed' };

/** The device credential a counter request carries, and over which channel. */
export function counterDeviceCredential(request: Request): CounterDeviceCredential {
  const header = request.headers.get('authorization');
  const cookieSecret = cookieValue(request, PHARMACY_COUNTER_DEVICE_COOKIE);
  if (header !== null && cookieSecret !== null) return { ok: false, reason: 'ambiguous' };
  if (header !== null) {
    const secret = header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : '';
    return SECRET_FORMAT.test(secret)
      ? { ok: true, secret, cookie: false }
      : { ok: false, reason: 'malformed' };
  }
  if (cookieSecret === null) return { ok: false, reason: 'missing' };
  return SECRET_FORMAT.test(cookieSecret)
    ? { ok: true, secret: cookieSecret, cookie: true }
    : { ok: false, reason: 'malformed' };
}

/** True only for a request whose Origin header is present and is exactly this site. */
export function exactSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin.toLowerCase() === trustedRequestOrigin(request);
  } catch {
    return false;
  }
}

/** The cookie a cookie-path request may use: only a state-changing, exact-origin one. */
export function cookieCredentialAllowed(request: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return false;
  return exactSameOrigin(request);
}

/** The device cookie's attributes; `maxAge` 0 clears it. */
export function counterDeviceCookieOptions(request: Request, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: counterDeviceCookieSecure(request),
    path: PHARMACY_COUNTER_DEVICE_COOKIE_PATH,
    maxAge,
    ...(maxAge === 0 ? { expires: new Date(0) } : {}),
  };
}

/** Secure everywhere but plain-http local development, as the restaurant terminal. */
export function counterDeviceCookieSecure(request: Request): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  try {
    return trustedRequestOrigin(request).startsWith('https:');
  } catch {
    return true;
  }
}
