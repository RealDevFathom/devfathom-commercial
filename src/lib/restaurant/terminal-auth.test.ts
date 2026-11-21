import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateDeviceSecret } from './devices';
import { generateTerminalSessionToken } from './terminal-session';

/**
 * Transport behaviour of `withDeviceAuth` / `withTerminalAuth` against an
 * in-memory store. The tenancy scopes and the rate limiter are mocked so the
 * wrapper's control flow — flood control, device discovery, C5 revalidation and
 * error mapping — is exercised without a live database. The security decision
 * itself (`evaluateTerminalSession`) is unit-tested purely in
 * `terminal-session.test.ts`; here we prove the wrapper wires it in and maps its
 * verdicts to the right HTTP status.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  store: { devices: [] as Row[], sessions: [] as Row[], orgs: [] as Row[], branches: [] as Row[] },
  rate: { ok: true },
  // WHA-138 Lane A: the EFFECTIVE entitlement snapshot the wrapper resolves per
  // request. Enabled by default so the pre-existing transport cases stay valid;
  // the entitlement cases below flip it off.
  entitlements: { enabled: ['restaurant-pos'] as string[] },
  resolveTenantActor: vi.fn(),
  findDemoStaff: vi.fn(),
  findStaff: vi.fn(),
  grants: [] as { capability: string; effect: string }[],
}));

function findBy(rows: Row[], where: Record<string, unknown>): Row | null {
  return (
    rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null
  );
}

vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: async (organizationId: string) => ({
    organizationId,
    enabledModules: h.entitlements.enabled,
  }),
  hasModule: (view: { enabledModules: string[] }, key: string) => view.enabledModules.includes(key),
}));

vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '203.0.113.5',
  rateLimit: () =>
    h.rate.ok
      ? { ok: true, retryAfter: 0, remaining: 1 }
      : { ok: false, retryAfter: 30, remaining: 0 },
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: h.resolveTenantActor,
}));

vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    restaurantStaffProfile: { findMany: h.findDemoStaff, findUnique: h.findStaff },
    restaurantStaffCapabilityGrant: { findMany: async () => h.grants },
    restaurantStaffJobRole: { findMany: async () => [] },
    restaurantRegisteredDevice: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        findBy(h.store.devices, where),
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = findBy(h.store.devices, where);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    $queryRaw: async (_query: TemplateStringsArray, tokenHash: string, deviceId: string) =>
      h.store.sessions.filter((row) => row.tokenHash === tokenHash && row.deviceId === deviceId),
    restaurantTerminalSession: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        findBy(h.store.sessions, where),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const row = findBy(h.store.sessions, where);
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = findBy(h.store.sessions, where);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    organization: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        findBy(h.store.orgs, where),
    },
    restaurantBranch: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        findBy(h.store.branches, where),
    },
  };
  return {
    withPlatformDb: (fn: (d: unknown) => unknown) => fn(db),
    withTenantDb: (_orgId: string, fn: (d: unknown) => unknown) => fn(db),
  };
});

import { hashDeviceSecret } from './devices';
import { hashTerminalSessionToken } from './terminal-session';
import { TERMINAL_DEVICE_COOKIE, withDeviceAuth, withTerminalAuth } from './terminal-auth';
import { openOrderBody, terminalCommandRoute } from './terminal-orders';

const ORG = 'org_restaurant_test';
const DEMO_ORG = 'org_demo_restaurant_seat_1';

let deviceSecret: string;
let sessionToken: string;

function seedDevice(overrides: Row = {}): void {
  h.store.orgs.push({ id: ORG, status: 'ACTIVE', isDemo: false });
  const gen = generateDeviceSecret();
  deviceSecret = gen.secret;
  h.store.devices.push({
    id: 'dev_1',
    name: 'Demo POS S1 Main',
    kind: 'POS',
    organizationId: ORG,
    branchId: 'branch_1',
    deviceSecretHash: gen.secretHash,
    status: 'ACTIVE',
    revokedAt: null,
    lastSeenAt: null,
    ...overrides,
  });
  h.store.branches.push({ id: 'branch_1', organizationId: ORG, active: true });
}

function seedSession(overrides: Row = {}): void {
  const gen = generateTerminalSessionToken();
  sessionToken = gen.token;
  h.store.sessions.push({
    id: 'sess_1',
    organizationId: ORG,
    deviceId: 'dev_1',
    activeStaffProfileId: null,
    tokenHash: gen.tokenHash,
    endedAt: null,
    lastActivityAt: new Date(),
    ...overrides,
  });
}

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://tenant.test/api/restaurant/terminal', { method: 'POST', headers });
}

beforeEach(() => {
  h.findStaff.mockReset().mockResolvedValue({ status: 'ACTIVE', primaryBranchId: 'branch_1' });
  h.grants = [{ capability: 'pos:operate', effect: 'ALLOW' }];
  h.findDemoStaff.mockReset().mockResolvedValue([{ id: 'staff_1' }]);
  h.store.devices = [];
  h.store.sessions = [];
  h.store.orgs = [];
  h.store.branches = [];
  h.rate.ok = true;
  h.entitlements.enabled = ['restaurant-pos'];
  h.resolveTenantActor.mockReset();
  h.resolveTenantActor.mockResolvedValue(null);
});

describe('withDeviceAuth', () => {
  it('rejects a missing or malformed device credential with 401', async () => {
    seedDevice();
    const handler = withDeviceAuth(() => new Response('ok'));
    expect((await handler(req())).status).toBe(401);
    expect((await handler(req({ authorization: 'Bearer nope' }))).status).toBe(401);
  });

  it('rejects an unknown device secret with 401', async () => {
    seedDevice();
    const handler = withDeviceAuth(() => new Response('ok'));
    const res = await handler(req({ authorization: `Bearer ${generateDeviceSecret().secret}` }));
    expect(res.status).toBe(401);
  });

  it('rejects a device whose organization is suspended with 401', async () => {
    seedDevice();
    h.store.orgs[0].status = 'SUSPENDED';
    const handler = withDeviceAuth(() => new Response('ok'));
    expect((await handler(req({ authorization: `Bearer ${deviceSecret}` }))).status).toBe(401);
  });

  it('rejects a revoked device on the fresh tenant read with 403', async () => {
    seedDevice({ status: 'REVOKED', revokedAt: new Date() });
    const handler = withDeviceAuth(() => new Response('ok'));
    expect((await handler(req({ authorization: `Bearer ${deviceSecret}` }))).status).toBe(403);
  });

  it('rejects a trusted device when its branch is inactive', async () => {
    seedDevice();
    h.store.branches[0].active = false;
    const inner = vi.fn(() => new Response('ok'));
    const handler = withDeviceAuth(inner);
    const response = await handler(req({ authorization: `Bearer ${deviceSecret}` }));
    expect(response.status).toBe(403);
    expect(inner).not.toHaveBeenCalled();
  });

  it('runs the handler for a trusted device and records the check-in', async () => {
    seedDevice();
    const handler = withDeviceAuth((ctx) => {
      expect(ctx.device.id).toBe('dev_1');
      expect(ctx.organizationId).toBe(ORG);
      return NextJson({ established: true }, 201);
    });
    const res = await handler(req({ authorization: `Bearer ${deviceSecret}` }));
    expect(res.status).toBe(201);
    expect(h.store.devices[0].lastSeenAt).toBeInstanceOf(Date);
  });

  it('accepts the host-only browser cookie only for an exact state-changing origin', async () => {
    seedDevice();
    const handler = withDeviceAuth(() => new Response('ok'));
    const cookie = `${TERMINAL_DEVICE_COOKIE}=${encodeURIComponent(deviceSecret)}`;

    expect((await handler(req({ cookie, origin: 'https://tenant.test' }))).status).toBe(200);
    expect((await handler(req({ cookie, origin: 'https://evil.test' }))).status).toBe(403);
    expect((await handler(req({ cookie }))).status).toBe(403);
  });

  it('rejects requests that ambiguously carry both cookie and bearer credentials', async () => {
    seedDevice();
    const handler = withDeviceAuth(() => new Response('ok'));
    const cookie = `${TERMINAL_DEVICE_COOKIE}=${encodeURIComponent(deviceSecret)}`;

    const response = await handler(
      req({
        authorization: `Bearer ${deviceSecret}`,
        cookie,
        origin: 'https://tenant.test',
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Terminal browser is not enrolled.' });
  });

  it('preserves bearer integrations without imposing browser Origin checks', async () => {
    seedDevice();
    const handler = withDeviceAuth(() => new Response('ok'));
    expect((await handler(req({ authorization: `Bearer ${deviceSecret}` }))).status).toBe(200);
  });

  it('returns 429 when the flood control trips', async () => {
    seedDevice();
    h.rate.ok = false;
    const handler = withDeviceAuth(() => new Response('ok'));
    expect((await handler(req({ authorization: `Bearer ${deviceSecret}` }))).status).toBe(429);
  });

  // WHA-138 Lane A: entitlement is enforced by the transport itself, so a
  // trusted device on a tenant whose POS module is disabled is rejected even
  // though nothing in navigation was involved.
  it('rejects a trusted device with 403 when restaurant-pos is disabled', async () => {
    seedDevice();
    h.entitlements.enabled = [];
    const inner = vi.fn(() => new Response('ok'));
    const handler = withDeviceAuth(inner);
    const res = await handler(req({ authorization: `Bearer ${deviceSecret}` }));
    expect(res.status).toBe(403);
    expect(inner).not.toHaveBeenCalled();
    // The gate runs before the check-in, so a disabled tenant records nothing.
    expect(h.store.devices[0].lastSeenAt).toBeNull();
  });

  it('runs the handler when restaurant-pos is enabled via any effective source', async () => {
    seedDevice();
    h.entitlements.enabled = ['restaurant-core', 'restaurant-pos'];
    const handler = withDeviceAuth(() => new Response('ok'));
    expect((await handler(req({ authorization: `Bearer ${deviceSecret}` }))).status).toBe(200);
  });
});

describe('withTerminalAuth', () => {
  it('requires a well-formed session token', async () => {
    seedDevice();
    const handler = withTerminalAuth(() => new Response('ok'));
    expect((await handler(req({ authorization: `Bearer ${deviceSecret}` }))).status).toBe(401);
  });

  it('runs the handler for a live session, exposing device + lock state', async () => {
    seedDevice();
    seedSession({ activeStaffProfileId: 'staff_1' });
    const handler = withTerminalAuth((ctx) => {
      expect(ctx.session.id).toBe('sess_1');
      expect(ctx.state).toBe('UNLOCKED');
      return new Response('ok');
    });
    const res = await handler(
      req({ authorization: `Bearer ${deviceSecret}`, 'x-terminal-session': sessionToken })
    );
    expect(res.status).toBe(200);
    expect(h.store.sessions[0].lastActivityAt).toBeInstanceOf(Date);
  });

  it.each(['deactivation', 'linked account deactivation', 'transfer', 'withdrawal'] as const)(
    'locks a bound kitchen operator after %s without refreshing idle time',
    async (change) => {
      seedDevice({ kind: 'KDS' });
      seedSession({ activeStaffProfileId: 'staff_1' });
      h.grants = [{ capability: 'kitchen:operate', effect: 'ALLOW' }];
      const inner = vi.fn(() => new Response('ok'));
      const handler = withTerminalAuth(inner);
      const headers = {
        authorization: `Bearer ${deviceSecret}`,
        'x-terminal-session': sessionToken,
      };
      expect((await handler(req(headers))).status).toBe(200);
      const lastActivityAt = h.store.sessions[0].lastActivityAt;
      if (change === 'withdrawal') h.grants = [];
      else if (change === 'linked account deactivation') {
        h.findStaff.mockResolvedValue({
          status: 'ACTIVE',
          primaryBranchId: 'branch_1',
          userId: 'linked_staff',
          user: { status: 'INACTIVE' },
        });
      } else
        h.findStaff.mockResolvedValue(
          change === 'deactivation'
            ? { status: 'SUSPENDED', primaryBranchId: 'branch_1' }
            : { status: 'ACTIVE', primaryBranchId: 'other' }
        );
      expect((await handler(req(headers))).status).toBe(403);
      expect(h.store.sessions[0]).toMatchObject({ activeStaffProfileId: null, lastActivityAt });
      expect(inner).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['staff_1', 'staff_1'],
    ['new-operator', 'new-operator'],
  ] as const)(
    'preserves the current binding and idle timestamp after an operation refusal (%s)',
    async (current, expected) => {
      seedDevice();
      seedSession({ activeStaffProfileId: current });
      const heartbeat = h.store.sessions[0].lastActivityAt;
      const refusal = new Error('Access denied');
      const handler = withTerminalAuth(
        () => {
          throw refusal;
        },
        {
          mapError: () => new Response(null, { status: 403 }),
        }
      );
      expect(
        (
          await handler(
            req({ authorization: `Bearer ${deviceSecret}`, 'x-terminal-session': sessionToken })
          )
        ).status
      ).toBe(403);
      expect(h.store.sessions[0]).toMatchObject({
        activeStaffProfileId: expected,
        lastActivityAt: heartbeat,
      });
    }
  );

  it('locks a POS operator missing base access without running the operation or touching idle time', async () => {
    seedDevice();
    seedSession({ activeStaffProfileId: 'staff_1' });
    h.grants = [{ capability: 'payments:collect', effect: 'ALLOW' }];
    const inner = vi.fn(() => new Response('ok'));
    const before = h.store.sessions[0].lastActivityAt;
    const response = await withTerminalAuth(inner)(
      req({ authorization: `Bearer ${deviceSecret}`, 'x-terminal-session': sessionToken })
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('pos:operate') });
    expect(h.store.sessions[0]).toMatchObject({
      activeStaffProfileId: null,
      lastActivityAt: before,
    });
    expect(inner).not.toHaveBeenCalled();
  });

  it('checks a session-bearing station queue poll before reading tickets', async () => {
    seedDevice({ kind: 'KDS', stationId: 'kitchen' });
    seedSession({ activeStaffProfileId: 'staff_1' });
    const before = h.store.sessions[0].lastActivityAt;
    const { GET } = await import('@/app/api/restaurant/kds/queue/route');
    const response = await GET(
      new Request('https://tenant.test/api/restaurant/kds/queue', {
        headers: {
          authorization: `Bearer ${deviceSecret}`,
          'x-terminal-session': sessionToken,
        },
      })
    );
    expect(response.status).toBe(403);
    expect(h.store.sessions[0]).toMatchObject({
      activeStaffProfileId: null,
      lastActivityAt: before,
    });
  });

  it('runs request preflight before persistent device or session touches', async () => {
    seedDevice();
    seedSession({ activeStaffProfileId: 'staff_1', lastActivityAt: null });
    const inner = vi.fn(() => new Response('ok'));
    const handler = withTerminalAuth(inner, {
      preflight: () => NextJson({ error: 'Delivery is not configured.' }, 400),
    });

    const response = await handler(
      req({ authorization: `Bearer ${deviceSecret}`, 'x-terminal-session': sessionToken })
    );

    expect(response.status).toBe(400);
    expect(inner).not.toHaveBeenCalled();
    expect(h.store.devices[0].lastSeenAt).toBeNull();
    expect(h.store.sessions[0].lastActivityAt).toBeNull();
  });

  it('rejects REST delivery without a customer before auth touches or order command work', async () => {
    seedDevice();
    seedSession({ activeStaffProfileId: 'staff_1', lastActivityAt: null });
    const run = vi.fn();
    const handler = terminalCommandRoute(openOrderBody, run, 201);
    const response = await handler(
      new Request('https://tenant.test/api/restaurant/orders/open', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deviceSecret}`,
          'x-terminal-session': sessionToken,
          'idempotency-key': 'delivery-bypass',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ channel: 'DELIVERY' }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid input',
      details: [
        expect.objectContaining({
          path: ['customerId'],
          message: 'Select a customer for delivery.',
        }),
      ],
    });
    expect(run).not.toHaveBeenCalled();
    expect(h.store.devices[0].lastSeenAt).toBeNull();
    expect(h.store.sessions[0].lastActivityAt).toBeNull();
  });

  it('rejects mid-session when the device is revoked (403, no trust cache)', async () => {
    seedDevice({ status: 'REVOKED', revokedAt: new Date() });
    seedSession();
    const handler = withTerminalAuth(() => new Response('ok'));
    const res = await handler(
      req({ authorization: `Bearer ${deviceSecret}`, 'x-terminal-session': sessionToken })
    );
    expect(res.status).toBe(403);
  });

  it('rejects replay of an ended session with 401', async () => {
    seedDevice();
    seedSession({ endedAt: new Date(Date.now() - 1000) });
    const handler = withTerminalAuth(() => new Response('ok'));
    const res = await handler(
      req({ authorization: `Bearer ${deviceSecret}`, 'x-terminal-session': sessionToken })
    );
    expect(res.status).toBe(401);
  });

  it('rejects a session token that belongs to another device', async () => {
    seedDevice();
    seedSession({ deviceId: 'dev_other' });
    const handler = withTerminalAuth(() => new Response('ok'));
    const res = await handler(
      req({ authorization: `Bearer ${deviceSecret}`, 'x-terminal-session': sessionToken })
    );
    expect(res.status).toBe(401);
  });

  // WHA-138 Lane A: a live, otherwise-valid session is still refused when the
  // tenant's POS entitlement is disabled — the module can be turned off
  // mid-session and takes effect on the very next request (no trust cache).
  it('rejects a live session with 403 when restaurant-pos is disabled', async () => {
    seedDevice();
    seedSession({ activeStaffProfileId: 'staff_1' });
    h.entitlements.enabled = ['restaurant-core'];
    const inner = vi.fn(() => new Response('ok'));
    const handler = withTerminalAuth(inner);
    const res = await handler(
      req({ authorization: `Bearer ${deviceSecret}`, 'x-terminal-session': sessionToken })
    );
    expect(res.status).toBe(403);
    expect(inner).not.toHaveBeenCalled();
    expect(h.store.devices[0].lastSeenAt).toBeNull();
  });
});

describe('demo terminal actor binding', () => {
  function markDemo() {
    h.store.orgs[0].isDemo = true;
    h.store.orgs[0].id = DEMO_ORG;
    for (const row of [...h.store.devices, ...h.store.sessions, ...h.store.branches])
      row.organizationId = DEMO_ORG;
  }

  function validActor(overrides: Record<string, unknown> = {}) {
    return {
      organization: {
        id: DEMO_ORG,
        isDemo: true,
        slug: 'demo-restaurant-seat-1',
        status: 'ACTIVE',
        vertical: 'RESTAURANT',
        deploymentMode: 'SHARED',
      },
      support: null,
      session: {
        user: {
          id: 'user_demo_restaurant_seat_1_manager',
          email: 'manager.seat1@demo.devfathom.invalid',
          organizationId: DEMO_ORG,
          demoAccessExpiresAt: Date.now() + 60_000,
        },
      },
      ...overrides,
    };
  }

  function deviceHeaders() {
    return { authorization: `Bearer ${deviceSecret}` };
  }

  function sessionHeaders() {
    return {
      ...deviceHeaders(),
      'x-terminal-session': sessionToken,
    };
  }

  it('admits both device-only and operator-session routes for a matching live demo actor', async () => {
    seedDevice();
    seedSession({ activeStaffProfileId: 'staff_1' });
    markDemo();
    h.resolveTenantActor.mockResolvedValue(validActor());

    expect((await withDeviceAuth(() => new Response('ok'))(req(deviceHeaders()))).status).toBe(200);
    expect((await withTerminalAuth(() => new Response('ok'))(req(sessionHeaders()))).status).toBe(
      200
    );
  });

  it('rejects demo credentials when the organization loses its demo flag', async () => {
    seedDevice();
    seedSession({ activeStaffProfileId: 'staff_1' });
    markDemo();
    h.store.orgs[0].isDemo = false;
    const handler = vi.fn(() => new Response('ok'));
    expect((await withDeviceAuth(handler)(req(deviceHeaders()))).status).toBe(401);
    expect((await withTerminalAuth(handler)(req(sessionHeaders()))).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects another persona device or staff session even within the same demo seat', async () => {
    seedDevice({ name: 'Demo cashier POS S1' });
    seedSession({ activeStaffProfileId: 'staff_1' });
    markDemo();
    h.resolveTenantActor.mockResolvedValue(validActor());
    const handler = vi.fn(() => new Response('ok'));
    expect((await withTerminalAuth(handler)(req(sessionHeaders()))).status).toBe(403);
    h.store.devices[0].name = 'Demo POS S1 Main';
    h.store.sessions[0].activeStaffProfileId = 'cashier_staff';
    expect((await withTerminalAuth(handler)(req(sessionHeaders()))).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('binds a waiter to its own device and active staff identity', async () => {
    seedDevice({ name: 'Demo waiter POS S1' });
    seedSession({ activeStaffProfileId: 'waiter_staff' });
    markDemo();
    const actor = validActor();
    actor.session.user.id = 'user_demo_restaurant_seat_1_waiter';
    actor.session.user.email = 'waiter.seat1@demo.devfathom.invalid';
    h.resolveTenantActor.mockResolvedValue(actor);
    h.findDemoStaff.mockResolvedValue([{ id: 'waiter_staff' }]);
    expect((await withTerminalAuth(() => new Response('ok'))(req(sessionHeaders()))).status).toBe(
      200
    );
    expect(h.findDemoStaff).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: actor.session.user.id,
          primaryBranchId: 'branch_1',
          user: expect.objectContaining({ role: 'EMPLOYEE', organizationRole: { key: 'server' } }),
        }),
      })
    );
  });

  it.each([
    ['missing actor', null],
    [
      'missing grant claim',
      validActor({
        session: {
          user: {
            id: 'user_demo_restaurant_seat_1_manager',
            email: 'manager.seat1@demo.devfathom.invalid',
            organizationId: ORG,
          },
        },
      }),
    ],
    [
      'expired grant claim',
      validActor({
        session: {
          user: {
            id: 'user_demo_restaurant_seat_1_manager',
            email: 'manager.seat1@demo.devfathom.invalid',
            organizationId: ORG,
            demoAccessExpiresAt: Date.now() - 1,
          },
        },
      }),
    ],
    [
      'wrong organization',
      validActor({ organization: { id: 'org_demo_restaurant_seat_2', isDemo: true } }),
    ],
  ])('rejects copied demo credentials for a %s', async (_label, actor) => {
    seedDevice();
    seedSession({ activeStaffProfileId: 'staff_1' });
    markDemo();
    h.resolveTenantActor.mockResolvedValue(actor);

    const device = await withDeviceAuth(() => new Response('ok'))(req(deviceHeaders()));
    const terminal = await withTerminalAuth(() => new Response('ok'))(req(sessionHeaders()));

    expect(device.status).toBe(401);
    expect(terminal.status).toBe(401);
  });

  it('does not require a tenant actor for ordinary device flows', async () => {
    seedDevice();
    seedSession({ activeStaffProfileId: 'staff_1' });

    expect((await withDeviceAuth(() => new Response('ok'))(req(deviceHeaders()))).status).toBe(200);
    expect((await withTerminalAuth(() => new Response('ok'))(req(sessionHeaders()))).status).toBe(
      200
    );
    expect(h.resolveTenantActor).not.toHaveBeenCalled();
  });
});

// Local helper to avoid importing next/server in the test just for a JSON body.
function NextJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Sanity: hashing helpers are the deterministic ones the store relies on.
describe('store seeding sanity', () => {
  it('device + session hashes are deterministic', () => {
    const { secret, secretHash } = generateDeviceSecret();
    expect(hashDeviceSecret(secret)).toBe(secretHash);
    const { token, tokenHash } = generateTerminalSessionToken();
    expect(hashTerminalSessionToken(token)).toBe(tokenHash);
  });
});
