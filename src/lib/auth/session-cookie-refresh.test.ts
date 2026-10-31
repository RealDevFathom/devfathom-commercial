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
    expect(marker).toContain(`Max-Age=${JWT_SESSION_UPDATE_AGE_SECONDS}`);
    expect(marker).toContain('HttpOnly');
    expect(marker).toContain('Secure');

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

  it('suppresses rotation until the exact end of the update window', async () => {
    const first = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session'),
      rotatingHandler(),
      { secret: SECRET, now: 2_000 }
    );
    const marker = first.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Secure-authjs.session-updated='))!;
    const response = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session', {
        headers: { cookie: marker.split(';', 1)[0]! },
      }),
      rotatingHandler(),
      { secret: SECRET, now: 2_000 + JWT_SESSION_UPDATE_AGE_SECONDS - 1 }
    );

    expect(response.headers.getSetCookie()).toEqual([]);
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

  it('does not trust a marker signed with another secret', async () => {
    const first = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session'),
      rotatingHandler(),
      { secret: 'another-secret', now: 3_000 }
    );
    const marker = first.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Secure-authjs.session-updated='))!;
    const response = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session', {
        headers: { cookie: marker.split(';', 1)[0]! },
      }),
      rotatingHandler(),
      { secret: SECRET, now: 3_001 }
    );

    expect(response.headers.getSetCookie()).toContain(SESSION_COOKIE);
  });

  it('does not suppress rotation outside the session endpoint', async () => {
    const first = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session'),
      rotatingHandler(),
      { secret: SECRET, now: 3_000 }
    );
    const marker = first.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Secure-authjs.session-updated='))!;
    const response = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/callback', {
        headers: { cookie: marker.split(';', 1)[0]! },
      }),
      rotatingHandler(),
      { secret: SECRET, now: 3_001 }
    );

    expect(response.headers.getSetCookie()).toContain(SESSION_COOKIE);
  });

  it('leaves session cookies unchanged when no secret is configured', async () => {
    const response = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session'),
      rotatingHandler()
    );

    expect(response.headers.getSetCookie()).toEqual([SESSION_COOKIE]);
  });

  it('uses a non-secure marker for a non-secure session cookie', async () => {
    const sessionCookie =
      'authjs.session-token=rotated-token; Path=/; Max-Age=28800; HttpOnly; SameSite=Lax';
    const response = await handleAuthRequest(
      new Request('http://tenant.test/api/auth/session'),
      async () => new Response('{}', { headers: { 'set-cookie': sessionCookie } }),
      { secret: SECRET, now: 3_000 }
    );
    const marker = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('authjs.session-updated='));

    expect(marker).toBeDefined();
    expect(marker).not.toContain('Secure');
  });

  it('suppresses every chunk of a rotated session cookie', async () => {
    const chunkedHandler = async () => {
      const headers = new Headers();
      headers.append(
        'set-cookie',
        '__Secure-authjs.session-token.0=first; Path=/; Secure; HttpOnly; SameSite=Lax'
      );
      headers.append(
        'set-cookie',
        '__Secure-authjs.session-token.1=second; Path=/; Secure; HttpOnly; SameSite=Lax'
      );
      return new Response('{}', { headers });
    };
    const first = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session'),
      chunkedHandler,
      { secret: SECRET, now: 3_000 }
    );
    const marker = first.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Secure-authjs.session-updated='))!;
    const response = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session', {
        headers: { cookie: marker.split(';', 1)[0]! },
      }),
      chunkedHandler,
      { secret: SECRET, now: 3_001 }
    );

    expect(response.headers.getSetCookie()).toEqual([]);
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

  it('persists explicit session updates during the refresh window', async () => {
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
        method: 'POST',
        headers: { cookie: marker.split(';', 1)[0]! },
        body: JSON.stringify({ data: { name: 'Updated name' } }),
      }),
      rotatingHandler(),
      { secret: SECRET, now: 4_001 }
    );

    expect(response.headers.getSetCookie()).toContain(SESSION_COOKIE);
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it.each([
    ['__Secure-authjs.session-token.0', '__Secure-authjs.session-token'],
    ['__Secure-authjs.session-token', '__Secure-authjs.session-token.0'],
    ['__Secure-authjs.session-token.1', '__Secure-authjs.session-token.0'],
  ])('keeps replacement cookies when rotation cleans up %s', async (oldName, newName) => {
    const first = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session'),
      rotatingHandler(),
      { secret: SECRET, now: 4_000 }
    );
    const marker = first.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Secure-authjs.session-updated='))!;
    const deletion = `${oldName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
    const replacement = `${newName}=new-token; Path=/; Secure; HttpOnly; SameSite=Lax`;
    const csrf = 'authjs.csrf-token=csrf; Path=/; HttpOnly; SameSite=Lax';
    const response = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session', {
        headers: { cookie: `${marker.split(';', 1)[0]!}; ${oldName}=old-token` },
      }),
      async () => {
        const headers = new Headers();
        for (const cookie of [deletion, replacement, csrf]) headers.append('set-cookie', cookie);
        return new Response('{}', { headers });
      },
      { secret: SECRET, now: 4_001 }
    );

    expect(response.headers.getSetCookie()).toContain(deletion);
    expect(response.headers.getSetCookie()).toContain(replacement);
    expect(response.headers.getSetCookie()).toContain(csrf);
  });

  it('preserves deletion-only responses for invalid sessions', async () => {
    const first = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session'),
      rotatingHandler(),
      { secret: SECRET, now: 4_000 }
    );
    const marker = first.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Secure-authjs.session-updated='))!;
    const deletion =
      '__Secure-authjs.session-token=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax';
    const response = await handleAuthRequest(
      new Request('https://tenant.test/api/auth/session', {
        headers: { cookie: marker.split(';', 1)[0]! },
      }),
      async () => new Response('null', { headers: { 'set-cookie': deletion } }),
      { secret: SECRET, now: 4_001 }
    );

    expect(response.headers.getSetCookie()).toEqual([deletion]);
  });
});
