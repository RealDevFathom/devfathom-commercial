import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  sameOrigin: vi.fn(),
  actor: vi.fn(),
  cookieOptions: vi.fn(),
  reset: vi.fn(),
  prepare: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock('@/lib/demo/config', () => ({
  isDemoEnabled: mocks.enabled,
  demoSeatFromOrganizationId: (organizationId: string) =>
    organizationId === 'org_demo_restaurant_seat_1' ? 1 : null,
  demoManagerId: (seat: number) => `user_demo_restaurant_seat_${seat}_manager`,
  demoManagerEmail: (seat: number) => `manager.seat${seat}@demo.devfathom.invalid`,
}));
vi.mock('@/lib/demo/isolation', () => ({ isDemoMutationOrigin: mocks.sameOrigin }));
vi.mock('@/lib/demo/device-session', () => ({
  DEMO_TERMINAL_SESSION_COOKIE: 'devfathom-demo-terminal-session',
  demoTerminalCookieOptions: mocks.cookieOptions,
  prepareDemoDeviceSession: mocks.prepare,
}));
vi.mock('@/lib/demo/jobs', () => ({ DEMO_RESET_TRANSACTION_TIMEOUT_MS: 30 * 60_000 }));
vi.mock('@/lib/demo/reset', () => ({ resetDemoSeatInTransaction: mocks.reset }));
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  TERMINAL_DEVICE_COOKIE: 'devfathom-terminal',
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));

import { POST } from './route';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const actor = {
  organization: { id: 'org_demo_restaurant_seat_1', isDemo: true },
  support: null,
  session: {
    user: {
      id: 'user_demo_restaurant_seat_1_manager',
      email: 'manager.seat1@demo.devfathom.invalid',
      organizationId: 'org_demo_restaurant_seat_1',
      demoAccessExpiresAt: NOW.getTime() + 60 * 60_000,
    },
  },
};
const db = { $queryRaw: vi.fn() };

function request() {
  return new Request('https://www.devfathom.com/demo/restaurants/reset', {
    method: 'POST',
    headers: { origin: 'https://www.devfathom.com', 'sec-fetch-site': 'same-origin' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.sameOrigin.mockReturnValue(true);
  mocks.actor.mockResolvedValue(actor);
  mocks.cookieOptions.mockReturnValue({
    httpOnly: true,
    sameSite: 'strict',
    secure: true,
    path: '/',
    expires: new Date(NOW.getTime() + 60 * 60_000),
    maxAge: 60 * 60,
  });
  db.$queryRaw.mockResolvedValue([
    {
      id: actor.organization.id,
      isDemo: true,
      lastDemoResetAt: null,
      now: NOW,
    },
  ]);
  mocks.reset.mockResolvedValue({
    organizationId: actor.organization.id,
    seatNumber: 1,
    managerUserId: actor.session.user.id,
    managerEmail: actor.session.user.email,
    counts: { branches: 1, liveOrders: 2 },
  });
  mocks.prepare.mockResolvedValue({
    deviceSecret: 'private-device-secret',
    branchId: 'branch_demo',
    sessionToken: 'private-session-token',
  });
  mocks.withTenantDb.mockImplementation(
    async (_organizationId: string, run: (scopedDb: unknown) => unknown) => run(db)
  );
});

describe('POST demo restaurant reset', () => {
  it('reads a timezone-neutral database instant for the seeded KDS business date', async () => {
    await POST(request());

    expect(db.$queryRaw.mock.calls[0]?.[0].join('')).toContain(
      "clock_timestamp() AT TIME ZONE 'UTC'"
    );
    expect(mocks.reset).toHaveBeenCalledWith(db, {
      organizationId: actor.organization.id,
      now: NOW,
    });
  });

  it('locks, resets, and rebuilds runtime in one bounded tenant transaction', async () => {
    const response = await POST(request());
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('"resetAt":"2026-09-04T12:00:00.000Z"');
    expect(text).toContain('"branches":1');
    expect(text).not.toContain('private-device-secret');
    expect(text).not.toContain('private-session-token');
    expect(mocks.withTenantDb).toHaveBeenCalledWith(actor.organization.id, expect.any(Function), {
      maxWait: 30_000,
      timeout: 30 * 60_000,
    });
    expect(mocks.reset).toHaveBeenCalledWith(db, {
      organizationId: actor.organization.id,
      now: NOW,
    });
    expect(mocks.prepare).toHaveBeenCalledWith(db, actor.session.user, 'POS', NOW);
    expect(mocks.reset.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prepare.mock.invocationCallOrder[0]!
    );
    expect(response.headers.getSetCookie()).toEqual([
      expect.stringMatching(
        /^devfathom-terminal=private-device-secret; Path=\/; Expires=.*; Max-Age=3600; Secure; HttpOnly; SameSite=strict$/
      ),
      expect.stringMatching(
        /^devfathom-demo-terminal-session=private-session-token; Path=\/demo\/restaurants\/device-session; Expires=.*; Max-Age=3600; Secure; HttpOnly; SameSite=strict$/
      ),
    ]);
  });

  it('allows owner reset and denies operational personas', async () => {
    const owner = {
      ...actor,
      session: {
        user: {
          ...actor.session.user,
          id: 'user_demo_restaurant_seat_1_owner',
          email: 'owner.seat1@demo.devfathom.invalid',
        },
      },
    };
    mocks.actor.mockResolvedValueOnce(owner);
    expect((await POST(request())).status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledWith(db, owner.session.user, 'POS', NOW);
    mocks.reset.mockClear();
    for (const persona of ['cashier', 'waiter', 'kitchen', 'inventory', 'finance']) {
      mocks.actor.mockResolvedValueOnce({
        ...actor,
        session: {
          user: {
            ...actor.session.user,
            id: `user_demo_restaurant_seat_1_${persona}`,
            email: `${persona}.seat1@demo.devfathom.invalid`,
          },
        },
      });
      expect((await POST(request())).status).toBe(404);
    }
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('enforces the ten-minute cooldown under the row lock', async () => {
    db.$queryRaw.mockResolvedValueOnce([
      {
        id: actor.organization.id,
        isDemo: true,
        lastDemoResetAt: new Date(NOW.getTime() - 5 * 60_000),
        now: NOW,
      },
    ]);

    const response = await POST(request());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: 'This demo seat was reset recently.',
      retryAfter: 300,
    });
    expect(response.headers.get('retry-after')).toBe('300');
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('fails before mutation for disabled, cross-origin, expired, and mismatched actors', async () => {
    mocks.enabled.mockReturnValueOnce(false);
    expect((await POST(request())).status).toBe(404);

    mocks.sameOrigin.mockReturnValueOnce(false);
    expect((await POST(request())).status).toBe(403);

    mocks.cookieOptions.mockReturnValueOnce(null);
    expect((await POST(request())).status).toBe(401);

    mocks.actor.mockResolvedValueOnce({
      ...actor,
      session: { user: { ...actor.session.user, id: 'user_other' } },
    });
    expect((await POST(request())).status).toBe(404);

    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('never resets a row that lost its demo flag while waiting for the lock', async () => {
    db.$queryRaw.mockResolvedValueOnce([
      { id: actor.organization.id, isDemo: false, lastDemoResetAt: null, now: NOW },
    ]);

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
