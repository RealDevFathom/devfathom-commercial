import { describe, expect, it } from 'vitest';
import { handleAuthRequest, JWT_SESSION_UPDATE_AGE_SECONDS } from './session-cookie-refresh';

const SECRET = 'test-secret-that-is-not-used-outside-this-test';
const SESSION_COOKIE =
  '__Secure-authjs.session-token=rotated-token; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax';

function rotatingHandler(extraCookie?: string): (request: Request) => Promise<Response> {
  return async () => {
    const headers = new Headers();
    headers.append('set-cookie', SESSION_COOKIE);
    if (extraCookie) headers.append('set-cookie', extraCookie);
    return new Response('{}', { headers });
  };
}

describe('JWT session cookie refresh window', () => {
  it('does not reissue the session token on consecutive session reads', async () => {
    const first = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session'),
      rotatingHandler(),
      { secret: SECRET, now: 1_000 }
    );
    const firstCookies = first.headers.getSetCookie();
    const marker = firstCookies.find((cookie) =>
      cookie.startsWith('__Secure-authjs.session-updated=')
    );
    expect(firstCookies).toContain(SESSION_COOKIE);
    expect(marker).toBeDefined();

    const second = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session', {
        headers: { cookie: marker!.split(';', 1)[0]! },
      }),
      rotatingHandler(),
      { secret: SECRET, now: 1_001 }
    );

    expect(second.headers.getSetCookie()).toEqual([]);
  });

  it('reissues the session token after the update window and preserves other cookies', async () => {
    const first = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session'),
      rotatingHandler(),
      { secret: SECRET, now: 2_000 }
    );
    const marker = first.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Secure-authjs.session-updated='))!;
    const csrf = 'authjs.csrf-token=csrf; Path=/; HttpOnly; SameSite=Lax';

    const response = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session', {
        headers: { cookie: marker.split(';', 1)[0]! },
      }),
      rotatingHandler(csrf),
      { secret: SECRET, now: 2_000 + JWT_SESSION_UPDATE_AGE_SECONDS }
    );

    expect(response.headers.getSetCookie()).toContain(SESSION_COOKIE);
    expect(response.headers.getSetCookie()).toContain(csrf);
    expect(response.headers.getSetCookie()).toHaveLength(3);
  });

  it('does not trust a forged update marker', async () => {
    const response = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session', {
        headers: { cookie: '__Secure-authjs.session-updated=3000.forged' },
      }),
      rotatingHandler(),
      { secret: SECRET, now: 3_001 }
    );

    expect(response.headers.getSetCookie()).toContain(SESSION_COOKIE);
  });

  it('never suppresses session-cookie deletion', async () => {
    const deletion =
      '__Secure-authjs.session-token=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax';
    const first = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session'),
      rotatingHandler(),
      { secret: SECRET, now: 4_000 }
    );
    const marker = first.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Secure-authjs.session-updated='))!;
    const response = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session', {
        headers: { cookie: marker.split(';', 1)[0]! },
      }),
      rotatingHandler(deletion),
      { secret: SECRET, now: 4_001 }
    );

    expect(response.headers.getSetCookie()).not.toContain(SESSION_COOKIE);
    expect(response.headers.getSetCookie()).toContain(deletion);
  });
});
