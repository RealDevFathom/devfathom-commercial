// @vitest-environment node
/**
 * DEV-957 phase 1: the enrolled counter browser's device credential is a
 * host-only httpOnly cookie. The counter route accepts it only on a request
 * whose Origin is exactly this site, never without Origin, and never together
 * with an Authorization header; the bearer path keeps working unchanged. The
 * bind route that sets the cookie needs the enrolment authority again and sets
 * it httpOnly, SameSite=Strict and scoped to the counter API.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const ORG = 'org_dev957';
const BRANCH = 'branch_dev957';
const DEVICE = 'device_dev957';
const ACTOR = 'user_dev957';
const SECRET = `pcd_${'b'.repeat(43)}`;
const ORIGIN = 'https://tenant.test';

const state = vi.hoisted(() => ({
  role: 'ADMIN' as string,
  grants: new Set<string>(),
  support: null as unknown,
}));
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  resolveBySecret: vi.fn(),
  issueOfflineSnapshot: vi.fn(),
  auditCreate: vi.fn(async () => ({})),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: vi.fn(async () => ({
    organization: { id: ORG },
    session: { user: { id: ACTOR, role: state.role, organizationId: ORG } },
    support: state.support,
  })),
}));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: vi.fn(async () => ({})),
  hasModule: vi.fn(() => true),
}));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string; role?: string }) => user,
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ ok: true }),
  clientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/pharmacy/offline-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/offline-devices')>()),
  resolvePharmacyCounterBySecret: mocks.resolveBySecret,
}));
vi.mock('@/lib/pharmacy/offline-snapshots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/offline-snapshots')>()),
  issueOfflineSnapshot: mocks.issueOfflineSnapshot,
}));
vi.mock('@/lib/pharmacy/manual-payment-settings', () => ({
  readManualPaymentSettings: vi.fn(async () => ({ settings: {}, revision: 0 })),
}));

const fakeDb = {
  $queryRaw: vi.fn(async () => []),
  pharmacyBranch: { findFirst: vi.fn(async () => ({ id: BRANCH })) },
  user: {
    findUnique: vi.fn(async () => ({
      status: 'ACTIVE',
      organizationId: ORG,
      organizationRole: { permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }] },
      permissionOverrides: [],
    })),
  },
  pharmacyBranchAssignment: { findFirst: vi.fn(async () => ({ branchId: BRANCH })) },
  pharmacyInventoryLot: { findMany: vi.fn(async () => []) },
  medicine: { findMany: vi.fn(async () => []) },
  pharmacyDeviceLotQuota: { findMany: vi.fn(async () => []) },
  pharmacyTaxProfileVersion: { findMany: vi.fn(async () => []) },
  auditLog: { create: mocks.auditCreate },
};
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_org: string, work: (db: unknown) => Promise<unknown>) =>
    work(fakeDb)
  ),
}));

let route: typeof import('./pharmacy-offline');
let bind: typeof import('./pharmacy-offline-bind');
beforeAll(async () => {
  route = await import('./pharmacy-offline');
  bind = await import('./pharmacy-offline-bind');
});

beforeEach(() => {
  vi.clearAllMocks();
  state.role = 'ADMIN';
  state.support = null;
  state.grants = new Set(['admin:access', 'pharmacy:orders', 'pharmacy:counter']);
  mocks.can.mockImplementation(async (_subject: unknown, action: string) =>
    state.grants.has(action)
  );
  mocks.resolveBySecret.mockResolvedValue({
    id: DEVICE,
    name: 'Front counter',
    branchId: BRANCH,
    organizationId: ORG,
    status: 'ACTIVE',
    revokedAt: null,
    // DEV-957 phase 2: the device row now carries its credential expiry.
    secretExpiresAt: new Date(Date.now() + 30 * 86_400_000),
  });
  mocks.issueOfflineSnapshot.mockImplementation(async (_db, _scope, input: { kind: string }) => ({
    kind: input.kind,
  }));
});

const cookie = `df_pharmacy_counter_device=${encodeURIComponent(SECRET)}`;

function counter(
  operation: 'establish' | 'snapshot' | 'approval-proof',
  headers: Record<string, string>,
  method = 'POST'
) {
  return route.pharmacyCounterRoute(operation)(
    new Request(`${ORIGIN}/api/pharmacy/counter/${operation}`, {
      method,
      headers,
      body: method === 'POST' ? '{}' : undefined,
    })
  );
}

describe('DEV-957 counter route: cookie credential', () => {
  it('accepts the cookie on an exact same-origin request and binds the session to the device', async () => {
    const established = await counter('establish', { cookie, origin: ORIGIN });
    expect(established.status).toBe(201);
    const { sessionToken, device } = await established.json();
    expect(device).toEqual({ id: DEVICE, branchId: BRANCH, organizationId: ORG });
    expect(mocks.resolveBySecret).toHaveBeenCalledWith(fakeDb, SECRET);
    const snapshot = await counter('snapshot', {
      cookie,
      origin: ORIGIN,
      'x-terminal-session': sessionToken,
    });
    expect(snapshot.status).toBe(200);
  });

  it('issues a short-lived approval proof only with the device credential and its session', async () => {
    const { validApprovalDeviceProof } = await import('@/lib/pharmacy/counter-terminal-session');
    const { sessionToken } = await (await counter('establish', { cookie, origin: ORIGIN })).json();
    const headers = { origin: ORIGIN, 'x-terminal-session': sessionToken };
    expect((await counter('approval-proof', headers)).status).toBe(401);
    const result = await counter('approval-proof', { ...headers, cookie });
    expect(result.status).toBe(200);
    const { proof } = await result.json();
    expect(validApprovalDeviceProof(sessionToken, proof)).toBe(true);
    expect(validApprovalDeviceProof('other-session', proof)).toBe(false);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect(validApprovalDeviceProof(sessionToken, proof)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1); // the original session opening
  });

  it('refuses the cookie from another origin', async () => {
    const response = await counter('establish', { cookie, origin: 'https://evil.test' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'origin_denied' });
    expect(mocks.resolveBySecret).not.toHaveBeenCalled();
  });

  it('refuses the cookie without an Origin header', async () => {
    const response = await counter('establish', { cookie });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'origin_denied' });
    expect(mocks.resolveBySecret).not.toHaveBeenCalled();
  });

  it('refuses the cookie from a malformed Origin and on a GET', async () => {
    expect((await counter('establish', { cookie, origin: 'null' })).status).toBe(403);
    expect((await counter('establish', { cookie, origin: ORIGIN }, 'GET')).status).toBe(403);
  });

  it('refuses a request carrying both the cookie and an Authorization header', async () => {
    const response = await counter('establish', {
      cookie,
      origin: ORIGIN,
      authorization: `Bearer ${SECRET}`,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized_device' });
    expect(mocks.resolveBySecret).not.toHaveBeenCalled();
  });

  it('accepts the public origin when the server sees its own bind address, and nothing else', async () => {
    const behindProxy = (origin: string) =>
      route.pharmacyCounterRoute('establish')(
        new Request('http://localhost:4331/api/pharmacy/counter/establish', {
          method: 'POST',
          headers: {
            cookie,
            origin,
            'x-forwarded-host': 'tenant.example',
            'x-forwarded-proto': 'https',
          },
          body: '{}',
        })
      );
    expect((await behindProxy('https://tenant.example')).status).toBe(201);
    expect((await behindProxy('https://evil.example')).status).toBe(403);
    expect((await behindProxy('http://tenant.example')).status).toBe(403);
  });

  it('DEV-957 phase 2: ignores a forged X-Forwarded-Host on a request to the public host', async () => {
    const forged = (origin: string) =>
      route.pharmacyCounterRoute('establish')(
        new Request('https://tenant.test/api/pharmacy/counter/establish', {
          method: 'POST',
          headers: { host: 'tenant.test', cookie, origin, 'x-forwarded-host': 'evil.example' },
          body: '{}',
        })
      );
    const refused = await forged('https://evil.example');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'origin_denied' });
    expect(mocks.resolveBySecret).not.toHaveBeenCalled();
    expect((await forged(ORIGIN)).status).toBe(201);
  });

  it('keeps the bearer path working without an Origin header', async () => {
    const response = await counter('establish', { authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(201);
  });

  it('refuses a malformed cookie or bearer value', async () => {
    expect(
      (
        await counter('establish', {
          cookie: 'df_pharmacy_counter_device=pcd_short',
          origin: ORIGIN,
        })
      ).status
    ).toBe(401);
    expect((await counter('establish', { authorization: 'Basic abc' })).status).toBe(401);
    expect((await counter('establish', {})).status).toBe(401);
  });
});

function bindRequest(
  headers: Record<string, string>,
  body: unknown = { secret: SECRET },
  method = 'POST'
) {
  return new Request(`${ORIGIN}/api/pharmacy/counter/bind`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

describe('DEV-957 bind route: setting the device cookie', () => {
  it('sets a host-only, httpOnly, SameSite=Strict, Secure cookie scoped to the counter API', async () => {
    const response = await bind.bindPharmacyCounterBrowser(bindRequest({ origin: ORIGIN }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      device: { id: DEVICE, name: 'Front counter', branchId: BRANCH, organizationId: ORG },
    });
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`df_pharmacy_counter_device=${SECRET}`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/Path=\/api\/pharmacy\/counter/);
    expect(setCookie).not.toMatch(/Domain=/i);
    // The response body never echoes the secret.
    expect(
      JSON.stringify(
        await bind.bindPharmacyCounterBrowser(bindRequest({ origin: ORIGIN })).then((r) => r.json())
      )
    ).not.toContain(SECRET);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'pharmacyOffline.bindCounterBrowser',
          targetId: DEVICE,
          metadata: { branchId: BRANCH, deviceId: DEVICE },
        }),
      })
    );
    expect(JSON.stringify(mocks.auditCreate.mock.calls)).not.toContain(SECRET);
  });

  it('refuses another origin, no origin, and a second credential channel', async () => {
    const headerSets: Array<Record<string, string>> = [
      { origin: 'https://evil.test' },
      {},
      { origin: ORIGIN, authorization: `Bearer ${SECRET}` },
    ];
    for (const headers of headerSets) {
      const response = await bind.bindPharmacyCounterBrowser(bindRequest(headers));
      expect(response.status, JSON.stringify(headers)).toBeGreaterThanOrEqual(401);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(mocks.resolveBySecret).not.toHaveBeenCalled();
  });

  it('refuses a cashier, a support session and a branch the manager is not assigned to', async () => {
    state.grants = new Set(['pharmacy:orders', 'pharmacy:counter']);
    let response = await bind.bindPharmacyCounterBrowser(bindRequest({ origin: ORIGIN }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });

    state.grants = new Set(['admin:access']);
    state.support = { id: 'support' };
    response = await bind.bindPharmacyCounterBrowser(bindRequest({ origin: ORIGIN }));
    expect(response.status).toBe(401);

    state.support = null;
    state.role = 'EMPLOYEE';
    fakeDb.pharmacyBranchAssignment.findFirst.mockResolvedValueOnce(null as never);
    response = await bind.bindPharmacyCounterBrowser(bindRequest({ origin: ORIGIN }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'branch_forbidden' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("refuses another tenant's, a revoked and a malformed secret", async () => {
    mocks.resolveBySecret.mockResolvedValueOnce(null); // RLS hides other tenants' rows
    expect((await bind.bindPharmacyCounterBrowser(bindRequest({ origin: ORIGIN }))).status).toBe(
      401
    );
    mocks.resolveBySecret.mockResolvedValueOnce({
      id: DEVICE,
      name: 'x',
      branchId: BRANCH,
      organizationId: 'org_other',
      status: 'ACTIVE',
      revokedAt: null,
      // DEV-957 phase 2: the device row now carries its credential expiry.
      secretExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    expect((await bind.bindPharmacyCounterBrowser(bindRequest({ origin: ORIGIN }))).status).toBe(
      401
    );
    mocks.resolveBySecret.mockResolvedValueOnce({
      id: DEVICE,
      name: 'x',
      branchId: BRANCH,
      organizationId: ORG,
      status: 'REVOKED',
      revokedAt: new Date(),
    });
    expect((await bind.bindPharmacyCounterBrowser(bindRequest({ origin: ORIGIN }))).status).toBe(
      401
    );
    const malformed = await bind.bindPharmacyCounterBrowser(
      bindRequest({ origin: ORIGIN }, { secret: 'pcd_short' })
    );
    expect(malformed.status).toBe(400);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('clears the cookie only for this exact origin', async () => {
    const cleared = await bind.unbindPharmacyCounterBrowser(
      bindRequest({ origin: ORIGIN }, null, 'DELETE')
    );
    expect(cleared.status).toBe(200);
    expect(cleared.headers.get('set-cookie')).toMatch(/df_pharmacy_counter_device=;/);
    expect(cleared.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
    const foreign = await bind.unbindPharmacyCounterBrowser(
      bindRequest({ origin: 'https://evil.test' }, null, 'DELETE')
    );
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('set-cookie')).toBeNull();
  });
});
