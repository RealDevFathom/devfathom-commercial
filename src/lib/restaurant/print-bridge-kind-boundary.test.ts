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
    restaurantStaffProfile: { findMany: h.findDemoStaff },
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

import { withDeviceAuth, withTerminalAuth } from './terminal-auth';

const ORG = 'org_restaurant_test';

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

describe('print bridge device kind boundary', () => {
  it.each(['POS', 'KDS'])('retains default device access for %s', async (kind) => {
    seedDevice({ kind });
    const handler = vi.fn(() => new Response('ok'));
    expect(
      (await withDeviceAuth(handler)(req({ authorization: `Bearer ${deviceSecret}` }))).status
    ).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
  it('denies bridge terminal commands before check-in or handler', async () => {
    seedDevice({ kind: 'PRINT_BRIDGE' });
    const handler = vi.fn(() => new Response('ok'));
    expect(
      (await withDeviceAuth(handler)(req({ authorization: `Bearer ${deviceSecret}` }))).status
    ).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(h.store.devices[0].lastSeenAt).toBeNull();
  });
  it('admits the explicit bridge route opt-in', async () => {
    seedDevice({ kind: 'PRINT_BRIDGE' });
    const handler = vi.fn(() => new Response('ok'));
    expect(
      (
        await withDeviceAuth(handler, { allowedDeviceKinds: ['POS', 'KDS', 'PRINT_BRIDGE'] })(
          req({ authorization: `Bearer ${deviceSecret}` })
        )
      ).status
    ).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
  it('denies a bridge even with an otherwise live terminal session', async () => {
    seedDevice({ kind: 'PRINT_BRIDGE' });
    seedSession();
    const handler = vi.fn(() => new Response('ok'));
    expect(
      (
        await withTerminalAuth(handler)(
          req({ authorization: `Bearer ${deviceSecret}`, 'x-terminal-session': sessionToken })
        )
      ).status
    ).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(h.store.devices[0].lastSeenAt).toBeNull();
  });
});
