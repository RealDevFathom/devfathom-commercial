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
  store: { devices: [] as Row[], sessions: [] as Row[], orgs: [] as Row[] },
  rate: { ok: true },
}));

function findBy(rows: Row[], where: Record<string, unknown>): Row | null {
  return (
    rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null
  );
}

vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '203.0.113.5',
  rateLimit: () =>
    h.rate.ok
      ? { ok: true, retryAfter: 0, remaining: 1 }
      : { ok: false, retryAfter: 30, remaining: 0 },
}));

vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    restaurantRegisteredDevice: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        findBy(h.store.devices, where),
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = findBy(h.store.devices, where);
        if (row) Object.assign(row, data);
        return row;
      },
    },
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
  };
  return {
    withPlatformDb: (fn: (d: unknown) => unknown) => fn(db),
    withTenantDb: (_orgId: string, fn: (d: unknown) => unknown) => fn(db),
  };
});

import { hashDeviceSecret } from './devices';
import { hashTerminalSessionToken } from './terminal-session';
import { withDeviceAuth, withTerminalAuth } from './terminal-auth';

const ORG = 'org_rest';

let deviceSecret: string;
let sessionToken: string;

function seedDevice(overrides: Row = {}): void {
  h.store.orgs.push({ id: ORG, status: 'ACTIVE' });
  const gen = generateDeviceSecret();
  deviceSecret = gen.secret;
  h.store.devices.push({
    id: 'dev_1',
    organizationId: ORG,
    branchId: 'branch_1',
    deviceSecretHash: gen.secretHash,
    status: 'ACTIVE',
    revokedAt: null,
    lastSeenAt: null,
    ...overrides,
  });
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
  h.store.devices = [];
  h.store.sessions = [];
  h.store.orgs = [];
  h.rate.ok = true;
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

  it('returns 429 when the flood control trips', async () => {
    seedDevice();
    h.rate.ok = false;
    const handler = withDeviceAuth(() => new Response('ok'));
    expect((await handler(req({ authorization: `Bearer ${deviceSecret}` }))).status).toBe(429);
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
