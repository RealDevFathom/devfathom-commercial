// @vitest-environment node
import { encode } from '@auth/core/jwt';
import { describe, expect, it } from 'vitest';

import { withoutRedundantSessionCookie } from './session-cookie-throttle';

const SECRET = 'throttle-test-secret-0123456789abcdef012345';
const COOKIE = 'authjs.session-token';
const HOUR = 60 * 60;
const claims = { sub: 'user_1', id: 'user_1', role: 'ADMIN', lastValidatedAt: 1 };

function mint(token: Record<string, unknown> = claims) {
  return encode({ secret: SECRET, salt: COOKIE, maxAge: 8 * HOUR, token });
}

function chunks(value: string) {
  const middle = Math.ceil(value.length / 2);
  return [value.slice(0, middle), value.slice(middle)];
}

function sessionResponse(setCookies: string[]) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const header of setCookies) headers.append('set-cookie', header);
  headers.append('set-cookie', 'other=keep; Path=/');
  return new Response('{"user":{}}', { status: 200, headers });
}

function setCookieNames(response: Response) {
  return response.headers.getSetCookie().map((header) => header.split('=')[0]);
}

const options = { secret: SECRET, updateAgeSeconds: HOUR };

describe('withoutRedundantSessionCookie', () => {
  it('drops redundant chunked session cookies and keeps unrelated cookies', async () => {
    const [in0, in1] = chunks(await mint());
    const [out0, out1] = chunks(await mint());
    const request = new Request('https://x.test/api/auth/session', {
      headers: { cookie: `${COOKIE}.1=${in1}; ${COOKIE}.0=${in0}` },
    });

    const response = await withoutRedundantSessionCookie(
      request,
      sessionResponse([`${COOKIE}.0=${out0}; Path=/`, `${COOKIE}.1=${out1}; Path=/`]),
      options
    );

    expect(setCookieNames(response)).toEqual(['other']);
    expect(await response.json()).toEqual({ user: {} });
  });

  it('keeps the cookie when the secret is unavailable or a claim changed', async () => {
    const cookie = await mint();
    const request = new Request('https://x.test/api/auth/session', {
      headers: { cookie: `${COOKIE}=${cookie}` },
    });
    const changed = await mint({ ...claims, role: 'MEMBER' });

    const noSecret = await withoutRedundantSessionCookie(
      request,
      sessionResponse([`${COOKIE}=${await mint()}; Path=/`]),
      { secret: undefined, updateAgeSeconds: HOUR }
    );
    const refreshed = await withoutRedundantSessionCookie(
      request,
      sessionResponse([`${COOKIE}=${changed}; Path=/`]),
      options
    );

    expect(setCookieNames(noSecret)).toEqual([COOKIE, 'other']);
    expect(setCookieNames(refreshed)).toEqual([COOKIE, 'other']);
  });

  it('keeps the cookie once the incoming token is older than the update window', async () => {
    const cookie = await mint();
    const request = new Request('https://x.test/api/auth/session', {
      headers: { cookie: `${COOKIE}=${cookie}` },
    });

    const response = await withoutRedundantSessionCookie(
      request,
      sessionResponse([`${COOKIE}=${await mint()}; Path=/`]),
      { ...options, now: Date.now() + (HOUR + 1) * 1000 }
    );

    expect(setCookieNames(response)).toEqual([COOKIE, 'other']);
  });

  it('keeps cookies that clear the session', async () => {
    const request = new Request('https://x.test/api/auth/session', {
      headers: { cookie: `${COOKIE}=${await mint()}` },
    });

    const response = await withoutRedundantSessionCookie(
      request,
      sessionResponse([`${COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`]),
      options
    );

    expect(setCookieNames(response)).toEqual([COOKIE, 'other']);
  });
});
