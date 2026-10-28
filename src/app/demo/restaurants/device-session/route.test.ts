import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  cookieOptions: vi.fn(),
  sameOrigin: vi.fn(),
  actor: vi.fn(),
  enabled: vi.fn(),
  tenant: vi.fn(),
}));

vi.mock('@/lib/demo/config', () => ({ isDemoEnabled: mocks.enabled }));
vi.mock('@/lib/demo/isolation', () => ({ isDemoMutationOrigin: mocks.sameOrigin }));
vi.mock('@/lib/demo/device-session', () => ({
  DEMO_TERMINAL_SESSION_COOKIE: 'devfathom-demo-terminal-session',
  prepareDemoDeviceSession: mocks.prepare,
  demoTerminalCookieOptions: mocks.cookieOptions,
}));
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  TERMINAL_DEVICE_COOKIE: 'devfathom-terminal',
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: mocks.tenant,
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));

import { POST } from './route';

const NOW = new Date('2026-09-04T23:00:00.000Z');
const actor = {
  organization: { id: 'org_demo_restaurant_seat_1', isDemo: true },
  support: null,
  session: {
    user: {
      id: 'user_demo_restaurant_seat_1_manager',
      email: 'manager.seat1@demo.devfathom.invalid',
      organizationId: 'org_demo_restaurant_seat_1',
      demoAccessExpiresAt: Date.parse('2026-09-05T00:00:00.000Z'),
    },
  },
};
const prepared = {
  deviceSecret: 'private-device-secret',
  branchId: 'branch_1',
  sessionToken: 'terminal-session-token',
  session: {
    id: 'session_1',
    state: 'UNLOCKED',
    activeStaffProfileId: 'staff_1',
    establishedAt: '2026-09-04T12:00:00.000Z',
  },
  device: {
    id: 'device_1',
    organizationId: 'org_demo_restaurant_seat_1',
    branchId: 'branch_1',
    name: 'Front counter',
    kind: 'POS',
    stationId: null,
    branchName: 'Main branch',
  },
  operator: {
    staffProfileId: 'staff_1',
    displayName: 'Demo Manager',
    role: 'Manager',
    canComp: true,
  },
};

function request(body?: string, cookie?: string) {
  return new Request('https://www.devfathom.com/demo/restaurants/device-session', {
    method: 'POST',
    headers: {
      origin: 'https://www.devfathom.com',
      ...(cookie ? { cookie } : {}),
    },
    body,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.sameOrigin.mockReturnValue(true);
  mocks.actor.mockResolvedValue(actor);
  mocks.tenant.mockImplementation(async (_organizationId: string, run: (db: unknown) => unknown) =>
    run({})
  );
  mocks.cookieOptions.mockReturnValue({
    httpOnly: true,
    sameSite: 'strict',
    secure: true,
    path: '/',
    expires: new Date('2026-09-05T00:00:00.000Z'),
    maxAge: 3_600,
  });
  mocks.prepare.mockResolvedValue(prepared);
});

afterEach(() => vi.useRealTimers());

describe('POST demo device session', () => {
  it('accepts the empty entry bootstrap and exposes no device credential', async () => {
    const response = await POST(request());
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('"ready":true');
    expect(text).toContain('terminal-session-token');
    expect(text).not.toContain('private-device-secret');
    expect(response.headers.getSetCookie()).toEqual([
      expect.stringMatching(
        /^devfathom-terminal=private-device-secret; Path=\/; Expires=.*; Max-Age=3600; Secure; HttpOnly; SameSite=strict$/
      ),
      expect.stringMatching(
        /^devfathom-demo-terminal-session=terminal-session-token; Path=\/demo\/restaurants\/device-session; Expires=.*; Max-Age=3600; Secure; HttpOnly; SameSite=strict$/
      ),
    ]);
    const now = mocks.cookieOptions.mock.calls[0]?.[1];
    expect(now).toBeInstanceOf(Date);
    expect(mocks.cookieOptions).toHaveBeenCalledWith(actor.session.user.demoAccessExpiresAt, now);
    expect(mocks.prepare).toHaveBeenCalledWith({}, actor.session.user, 'POS', now, {
      deviceSecret: null,
      sessionToken: null,
    });
  });

  it('forwards and reissues existing terminal credentials with the absolute grant expiry', async () => {
    const cookie =
      'unrelated=value; devfathom-terminal=rdk_existing; devfathom-demo-terminal-session=rts_existing';
    mocks.prepare.mockImplementation(async (_db, _user, _kind, _now, existing) => ({
      ...prepared,
      deviceSecret: existing.deviceSecret,
      sessionToken: existing.sessionToken,
      session: { ...prepared.session, id: 'session_existing' },
    }));

    const [first, second] = await Promise.all([
      POST(request(undefined, cookie)),
      POST(request('', cookie)),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    for (const call of mocks.prepare.mock.calls) {
      expect(call).toEqual([
        {},
        actor.session.user,
        'POS',
        expect.any(Date),
        { deviceSecret: 'rdk_existing', sessionToken: 'rts_existing' },
      ]);
    }
    for (const response of [first, second]) {
      expect(response.headers.getSetCookie()).toEqual([
        expect.stringContaining(
          'devfathom-terminal=rdk_existing; Path=/; Expires=Sat, 05 Sep 2026 00:00:00 GMT;'
        ),
        expect.stringContaining(
          'devfathom-demo-terminal-session=rts_existing; Path=/demo/restaurants/device-session; Expires=Sat, 05 Sep 2026 00:00:00 GMT;'
        ),
      ]);
    }
  });

  it('returns serialized first-call responses with the newest device cookie last', async () => {
    let transactionTail = Promise.resolve();
    let currentSecret = '';
    let generation = 0;
    mocks.tenant.mockImplementation(
      async (_organizationId: string, run: (db: unknown) => unknown) => {
        const waitForTransaction = transactionTail;
        let releaseTransaction!: () => void;
        transactionTail = new Promise<void>((resolve) => {
          releaseTransaction = resolve;
        });
        await waitForTransaction;
        try {
          return await run({});
        } finally {
          releaseTransaction();
        }
      }
    );
    mocks.prepare.mockImplementation(async () => {
      generation += 1;
      currentSecret = `rdk_serial_${generation}`;
      return {
        ...prepared,
        deviceSecret: currentSecret,
        sessionToken: `rts_serial_${generation}`,
        session: { ...prepared.session, id: `session_${generation}` },
      };
    });

    const responses = await Promise.all([POST(request()), POST(request()), POST(request())]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(mocks.prepare).toHaveBeenCalledTimes(3);
    for (const call of mocks.prepare.mock.calls) {
      expect(call[4]).toEqual({ deviceSecret: null, sessionToken: null });
    }
    const returnedSecrets = responses.map((response) =>
      response.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('devfathom-terminal='))!
        .split(';')[0]!
        .slice('devfathom-terminal='.length)
    );
    expect(returnedSecrets).toEqual(['rdk_serial_1', 'rdk_serial_2', 'rdk_serial_3']);
    expect(returnedSecrets[2]).toBe(currentSecret);
  });

  it('bootstraps KDS only when explicitly requested', async () => {
    const response = await POST(request(JSON.stringify({ kind: 'KDS' })));

    expect(response.status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledWith({}, actor.session.user, 'KDS', expect.any(Date), {
      deviceSecret: null,
      sessionToken: null,
    });
  });

  it('rejects cross-origin and non-demo actors before issuance', async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.prepare).not.toHaveBeenCalled();

    mocks.sameOrigin.mockReturnValue(true);
    mocks.actor.mockResolvedValueOnce({ ...actor, organization: { id: 'org_1', isDemo: false } });
    expect((await POST(request())).status).toBe(404);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('fails closed when the demo grant cannot bound the cookie', async () => {
    mocks.cookieOptions.mockReturnValue(null);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('returns 404 without resolving an actor when the demo is disabled', async () => {
    mocks.enabled.mockReturnValue(false);

    expect((await POST(request())).status).toBe(404);
    expect(mocks.actor).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
