import { decode } from 'next-auth/jwt';

/**
 * How long a JWT session cookie may go without being re-issued on a session
 * read. Auth.js only honours `session.updateAge` for database sessions; under
 * the JWT strategy it re-encrypts the token and sends a fresh `Set-Cookie` on
 * every `GET /api/auth/session`. `withoutRedundantSessionCookie` restores the
 * documented throttle for JWT sessions.
 */
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60;

/** `authjs.session-token`, its `__Secure-` variant, and their `.N` chunks. */
const SESSION_COOKIE = /^((?:__Secure-)?authjs\.session-token)(?:\.(\d+))?$/;

/** Claims Auth.js rewrites on every encode; they do not carry session state. */
const VOLATILE_CLAIMS = new Set(['iat', 'exp', 'jti']);

type CookiePair = { name: string; value: string };
type SessionCookie = { name: string; value: string };

function parseCookieHeader(header: string | null): CookiePair[] {
  if (!header) return [];
  return header.split(';').flatMap((part) => {
    const index = part.indexOf('=');
    if (index < 0) return [];
    return [{ name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() }];
  });
}

function parseSetCookie(header: string): CookiePair | null {
  const [pair = ''] = header.split(';');
  const index = pair.indexOf('=');
  if (index < 0) return null;
  return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() };
}

/**
 * Reassembles the session token from its (possibly chunked) cookies. Returns
 * null when there is no session cookie, when more than one cookie family is
 * present, or when any chunk is empty (Auth.js clearing the session).
 */
function assembleSessionCookie(pairs: CookiePair[]): SessionCookie | null {
  let baseName: string | null = null;
  const chunks: Array<{ index: number; value: string }> = [];
  for (const { name, value } of pairs) {
    const match = SESSION_COOKIE.exec(name);
    if (!match) continue;
    if (baseName !== null && baseName !== match[1]) return null;
    if (!value) return null;
    baseName = match[1]!;
    chunks.push({ index: match[2] === undefined ? -1 : Number(match[2]), value });
  }
  if (baseName === null) return null;
  chunks.sort((a, b) => a.index - b.index);
  return { name: baseName, value: chunks.map((chunk) => chunk.value).join('') };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

function sessionClaims(payload: Record<string, unknown>): string {
  const claims = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !VOLATILE_CLAIMS.has(key))
  );
  return JSON.stringify(canonical(claims));
}

async function decodeSessionCookie(
  cookie: SessionCookie,
  secret: string
): Promise<Record<string, unknown> | null> {
  try {
    return (await decode({ token: cookie.value, secret, salt: cookie.name })) as Record<
      string,
      unknown
    > | null;
  } catch {
    return null;
  }
}

/**
 * Drops the session `Set-Cookie` from a `GET /api/auth/session` response when
 * re-issuing it would change nothing but its timestamps: the cookie the browser
 * sent is younger than `updateAgeSeconds` and every session claim the `jwt`
 * callback produced is identical to the claims it already holds.
 *
 * Any refreshed claim (role, status, revocation, revalidation time, ...) still
 * re-issues the cookie immediately, as does a cookie older than the update
 * window (sliding expiry). Anything that cannot be verified leaves the
 * response untouched, so this can only ever suppress a redundant cookie.
 */
export async function withoutRedundantSessionCookie(
  request: Request,
  response: Response,
  options: { secret: string | undefined; updateAgeSeconds: number; now?: number }
): Promise<Response> {
  if (!options.secret) return response;

  const setCookies = response.headers.getSetCookie();
  const outgoing = assembleSessionCookie(
    setCookies.map(parseSetCookie).filter((pair): pair is CookiePair => pair !== null)
  );
  if (!outgoing) return response;
  const incoming = assembleSessionCookie(parseCookieHeader(request.headers.get('cookie')));
  if (!incoming || incoming.name !== outgoing.name) return response;

  const [previous, next] = await Promise.all([
    decodeSessionCookie(incoming, options.secret),
    decodeSessionCookie(outgoing, options.secret),
  ]);
  if (!previous || !next || typeof previous.iat !== 'number') return response;

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (nowSeconds - previous.iat >= options.updateAgeSeconds) return response;
  if (sessionClaims(previous) !== sessionClaims(next)) return response;

  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  for (const header of setCookies) {
    const pair = parseSetCookie(header);
    if (pair && SESSION_COOKIE.test(pair.name)) continue;
    headers.append('set-cookie', header);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
