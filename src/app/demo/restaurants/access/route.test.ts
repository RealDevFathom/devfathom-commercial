import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oversizedRequest } from '../../../../../tests/fixtures/bounded-request';

const mocks = vi.hoisted(() => ({
  createGrant: vi.fn(),
  codeMatches: vi.fn(),
  readGrant: vi.fn(),
  resolveSeat: vi.fn(),
  createIntent: vi.fn(),
  rateLimit: vi.fn(),
  sharedHost: vi.fn(),
  enabled: vi.fn(),
  assertOrigin: vi.fn(),
}));

vi.mock('@/lib/demo/access', () => ({
  DEMO_ACCESS_COOKIE: 'df_demo_access',
  createDemoAccessGrant: mocks.createGrant,
  demoAccessCodeMatches: mocks.codeMatches,
  demoAccessCookieOptions: (expires: Date) => ({
    httpOnly: true,
    sameSite: 'lax',
    path: '/demo',
    expires,
  }),
  readDemoAccessGrant: mocks.readGrant,
  resolveDemoSeat: mocks.resolveSeat,
}));
vi.mock('@/lib/demo/config', () => ({ isDemoEnabled: mocks.enabled }));
vi.mock('@/lib/auth/login-intent', () => ({
  LOGIN_INTENT_COOKIE: 'df_login_intent',
  createLoginIntent: mocks.createIntent,
  loginIntentCookieOptions: (expires: Date) => ({
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires,
  }),
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: mocks.rateLimit }));
vi.mock('@/lib/platform/security', () => ({
  PlatformSecurityError: class PlatformSecurityError extends Error {
    status = 403;
  },
  assertPlatformMutationOrigin: mocks.assertOrigin,
  parseCookie: (cookie: string | null, name: string) => {
    const match = cookie?.split(';').find((part) => part.trim().startsWith(`${name}=`));
    return match?.trim().slice(name.length + 1) ?? null;
  },
}));
vi.mock('@/lib/tenancy/host', () => ({
  isSharedHost: mocks.sharedHost,
  requestHost: (request: Request) => new URL(request.url).hostname,
}));
vi.mock('@/server/audit', () => ({ ipFromHeaders: () => '203.0.113.4' }));

import { POST } from './route';
import { DEMO_PERSONA_KEYS, DEMO_PERSONAS } from '@/lib/demo/personas';

const ORIGINAL_EXPIRY = new Date('2026-09-05T00:00:00.000Z');
const FRESH_EXPIRY = new Date('2026-09-05T06:00:00.000Z');
const INTENT_EXPIRY = new Date('2026-09-04T12:05:00.000Z');

function request(body: Record<string, unknown>, cookie?: string) {
  return new Request('https://www.devfathom.com/demo/restaurants/access', {
    method: 'POST',
    headers: {
      origin: 'https://www.devfathom.com',
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sharedHost.mockReturnValue(true);
  mocks.enabled.mockReturnValue(true);
  mocks.rateLimit.mockReturnValue({ ok: true, retryAfter: 0 });
  mocks.codeMatches.mockReturnValue(true);
  mocks.resolveSeat.mockResolvedValue({
    persona: 'manager',
    userId: 'user_demo_restaurant_seat_2_manager',
    email: 'manager.seat2@demo.devfathom.invalid',
    seat: 2,
    name: 'Demo Restaurant — Seat 2',
    ready: true,
    organizationId: 'org_demo_restaurant_seat_2',
    managerUserId: 'user_demo_restaurant_seat_2_manager',
    managerEmail: 'manager.seat2@demo.devfathom.invalid',
  });
  mocks.readGrant.mockReturnValue(null);
  mocks.createGrant.mockReturnValue({ value: 'signed-fresh', expiresAt: FRESH_EXPIRY });
  mocks.createIntent.mockResolvedValue({ token: 'opaque-login-intent', expiresAt: INTENT_EXPIRY });
});

describe('POST demo access', () => {
  it('stops reading at the demo access cap even if the declared length is smaller', async () => {
    const limit = 1024;
    const normalRequest = request({});
    normalRequest.headers.set('content-length', '512');
    const input = oversizedRequest(limit, {
      url: normalRequest.url,
      headers: normalRequest.headers,
      chunkSize: 512,
    });

    const response = await POST(input.request);
    expect(response.status).toBe(413);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(input.cancelled()).toBe(true);
    expect(input.bytesRead()).toBe(limit + 512);
    expect(mocks.resolveSeat).not.toHaveBeenCalled();
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it.each(DEMO_PERSONA_KEYS)(
    'issues only the resolved %s intent and returns its destination',
    async (persona) => {
      mocks.resolveSeat.mockResolvedValue({
        seat: 2,
        organizationId: 'org_demo_restaurant_seat_2',
        persona,
        userId: `user_demo_restaurant_seat_2_${persona}`,
        email: `${persona}.seat2@demo.devfathom.invalid`,
      });
      const response = await POST(request({ seat: 2, code: 'correct', persona }));
      expect(mocks.resolveSeat).toHaveBeenCalledWith(2, persona);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        organizationId: 'org_demo_restaurant_seat_2',
        persona,
        callbackUrl: DEMO_PERSONAS[persona].callbackUrl,
        deviceKind: DEMO_PERSONAS[persona].deviceKind,
      });
      expect(mocks.createIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          email: `${persona}.seat2@demo.devfathom.invalid`,
          candidates: [
            expect.objectContaining({ userId: `user_demo_restaurant_seat_2_${persona}` }),
          ],
        })
      );
    }
  );

  it.each([
    { persona: 'admin' },
    { persona: 'OWNER' },
    { role: 'ADMIN' },
    { userId: 'production_admin' },
    { organizationId: 'org_production' },
  ])('rejects unsupported persona or impersonation fields %j', async (extra) => {
    expect((await POST(request({ seat: 2, code: 'correct', ...extra }))).status).toBe(400);
    expect(mocks.resolveSeat).not.toHaveBeenCalled();
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it('rejects an unready persona and prevents grant reuse across seats', async () => {
    mocks.resolveSeat.mockResolvedValueOnce(null);
    expect((await POST(request({ seat: 2, code: 'correct', persona: 'waiter' }))).status).toBe(409);
    expect(mocks.createIntent).not.toHaveBeenCalled();
    mocks.readGrant.mockReturnValue({
      organizationId: 'org_demo_restaurant_seat_1',
      seat: 1,
      expiresAt: ORIGINAL_EXPIRY.getTime(),
    });
    expect((await POST(request({ seat: 2 }, 'df_demo_access=seat-one-grant'))).status).toBe(401);
  });

  it('preserves the original absolute grant expiry on code-free re-entry', async () => {
    mocks.readGrant.mockReturnValue({
      v: 1,
      organizationId: 'org_demo_restaurant_seat_2',
      seat: 2,
      host: 'www.devfathom.com',
      expiresAt: ORIGINAL_EXPIRY.getTime(),
    });

    const response = await POST(request({ seat: 2 }, 'df_demo_access=signed-original'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      organizationId: 'org_demo_restaurant_seat_2',
      callbackUrl: '/dashboard',
      persona: 'manager',
      deviceKind: 'POS',
    });
    expect(mocks.createGrant).not.toHaveBeenCalled();
    expect(mocks.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          {
            organizationId: 'org_demo_restaurant_seat_2',
            userId: 'user_demo_restaurant_seat_2_manager',
            demoAccessExpiresAt: ORIGINAL_EXPIRY.getTime(),
          },
        ],
      })
    );
    const grantCookie = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('df_demo_access='));
    expect(grantCookie).toContain('df_demo_access=signed-original');
    expect(grantCookie).toContain(`Expires=${ORIGINAL_EXPIRY.toUTCString()}`);
    expect(grantCookie).toContain('Path=/demo');
    expect(grantCookie).toContain('HttpOnly');
    expect(grantCookie).toContain('SameSite=lax');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('requires a correct code once the old grant is expired, tampered, or host-invalid', async () => {
    mocks.readGrant.mockReturnValue(null);
    mocks.codeMatches.mockReturnValue(false);

    const response = await POST(request({ seat: 2 }, 'df_demo_access=untrusted'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid access code.' });
    expect(mocks.createIntent).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mocks.rateLimit).toHaveBeenCalledWith('demo:access:203.0.113.4', 10, 15 * 60_000);
  });

  it('starts a fresh twelve-hour grant only after a newly supplied correct code', async () => {
    const response = await POST(request({ seat: 2, code: 'correct' }));

    expect(response.status).toBe(200);
    expect(mocks.createGrant).toHaveBeenCalledWith({
      organizationId: 'org_demo_restaurant_seat_2',
      seat: 2,
      host: 'www.devfathom.com',
    });
    expect(mocks.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [expect.objectContaining({ demoAccessExpiresAt: FRESH_EXPIRY.getTime() })],
      })
    );
  });

  it('does not expose the manager identity or login-intent token in JSON', async () => {
    const response = await POST(request({ seat: 2, code: 'correct' }));
    const text = await response.text();

    expect(text).not.toContain('manager.seat2');
    expect(text).not.toContain('user_demo_restaurant');
    expect(text).not.toContain('opaque-login-intent');
  });

  it('rejects non-shared hosts before resolving a seat', async () => {
    mocks.sharedHost.mockReturnValue(false);

    const response = await POST(request({ seat: 2, code: 'correct' }));

    expect(response.status).toBe(404);
    expect(mocks.resolveSeat).not.toHaveBeenCalled();
  });

  it('returns 404 when the demo is disabled and rejects cross-origin requests', async () => {
    mocks.enabled.mockReturnValueOnce(false);
    expect((await POST(request({ seat: 2, code: 'correct' }))).status).toBe(404);
    expect(mocks.resolveSeat).not.toHaveBeenCalled();

    const OriginError = class extends Error {
      status = 403;
    };
    mocks.assertOrigin.mockImplementationOnce(() => {
      throw new OriginError();
    });
    expect((await POST(request({ seat: 2, code: 'correct' }))).status).toBe(403);
    expect(mocks.resolveSeat).not.toHaveBeenCalled();
  });

  it('rate-limits code attempts and rejects unknown JSON fields', async () => {
    mocks.rateLimit.mockReturnValueOnce({ ok: false, retryAfter: 37 });
    const limited = await POST(request({ seat: 2, code: 'wrong' }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('37');
    expect(mocks.codeMatches).not.toHaveBeenCalled();

    const malformed = await POST(request({ seat: 2, code: 'correct', organizationId: 'forged' }));
    expect(malformed.status).toBe(400);
    expect(mocks.resolveSeat).toHaveBeenCalledTimes(1);
  });
});
