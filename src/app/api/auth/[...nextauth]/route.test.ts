// @vitest-environment node
import { Auth, type AuthConfig } from '@auth/core';
import { encode } from '@auth/core/jwt';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'route-test-secret-0123456789abcdef0123456789';
const COOKIE = '__Secure-authjs.session-token';
const HOUR = 60 * 60;

const claims = vi.hoisted(() => ({
  refresh: null as null | ((token: Record<string, unknown>) => void),
}));

vi.mock('@/lib/auth', () => {
  const config: AuthConfig = {
    secret: SECRET,
    trustHost: true,
    basePath: '/api/auth',
    providers: [],
    session: { strategy: 'jwt', maxAge: 8 * HOUR, updateAge: HOUR },
    callbacks: {
      async jwt({ token }) {
        claims.refresh?.(token as Record<string, unknown>);
        return token;
      },
    },
  };
  const handler = (request: Request) => Auth(request, config);
  return { handlers: { GET: handler, POST: handler } };
});

const { GET } = await import('./route');

async function sessionCookie(issuedSecondsAgo: number) {
  // encode() stamps iat from the clock, so mint the cookie in the past.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() - issuedSecondsAgo * 1000);
  try {
    return await encode({
      secret: SECRET,
      salt: COOKIE,
      maxAge: 8 * HOUR,
      token: { sub: 'user_1', id: 'user_1', role: 'ADMIN', lastValidatedAt: 1 },
    });
  } finally {
    vi.useRealTimers();
  }
}

function sessionRead(cookie: string, path = '/api/auth/session') {
  return new NextRequest(`https://acme.devfathom.com${path}`, {
    headers: { cookie: `${COOKIE}=${cookie}` },
  });
}

function sessionSetCookies(response: Response) {
  return response.headers.getSetCookie().filter((header) => header.startsWith(COOKIE));
}

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', SECRET);
  claims.refresh = null;
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/auth/session cookie re-issue', () => {
  it('does not re-issue an unchanged session cookie on back-to-back reads', async () => {
    const cookie = await sessionCookie(5);

    const first = await GET(sessionRead(cookie));
    const second = await GET(sessionRead(cookie));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({ user: {} });
    expect(sessionSetCookies(first)).toEqual([]);
    expect(sessionSetCookies(second)).toEqual([]);
  });

  it('re-issues the cookie once the update window has elapsed', async () => {
    const cookie = await sessionCookie(HOUR + 1);

    const response = await GET(sessionRead(cookie));

    expect(sessionSetCookies(response)).toHaveLength(1);
    expect(sessionSetCookies(response)[0]).toMatch(/HttpOnly/i);
  });

  it('re-issues the cookie immediately when the jwt callback refreshed a claim', async () => {
    claims.refresh = (token) => {
      token.role = 'MEMBER';
      token.lastValidatedAt = 2;
    };
    const cookie = await sessionCookie(5);

    const response = await GET(sessionRead(cookie));

    expect(sessionSetCookies(response)).toHaveLength(1);
  });

  it('leaves other auth routes untouched', async () => {
    const cookie = await sessionCookie(5);

    const response = await GET(sessionRead(cookie, '/api/auth/csrf'));

    expect(response.headers.getSetCookie().some((h) => h.includes('authjs.csrf-token'))).toBe(true);
  });

  it('still clears a session cookie that cannot be verified', async () => {
    const response = await GET(sessionRead('not-a-valid-token'));

    const cleared = sessionSetCookies(response);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatch(new RegExp(`^${COOKIE.replace(/[.-]/g, '\\$&')}=;`));
  });
});
