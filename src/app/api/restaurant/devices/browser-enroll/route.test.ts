import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  enrollDevice: vi.fn(),
  recordAudit: vi.fn(),
  branchFindUnique: vi.fn(),
  stationFindFirst: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string }) => ({ id: user.id }),
}));
vi.mock('@/lib/auth/session-state', () => ({
  evaluateSessionUser: () => ({ ok: true }),
}));
vi.mock('@/lib/http-origin', () => ({
  publicRequestOrigin: () => 'https://tenant.test',
}));
vi.mock('@/lib/restaurant/devices', () => ({ enrollDevice: mocks.enrollDevice }));
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  TERMINAL_DEVICE_COOKIE: 'devfathom-terminal',
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (_organizationId: string, callback: (db: unknown) => unknown) =>
    callback({
      restaurantBranch: { findUnique: mocks.branchFindUnique },
      restaurantKitchenStation: { findFirst: mocks.stationFindFirst },
    }),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: async () => ({
    organization: { id: 'org_1' },
    support: null,
    session: {
      expires: 'later',
      user: {
        id: 'user_admin',
        name: 'Admin User',
        email: 'admin@example.test',
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationId: 'org_1',
      },
    },
  }),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => '203.0.113.8',
  recordAudit: mocks.recordAudit,
}));

import { POST } from './route';

const rawSecret = `rdk_${'a'.repeat(43)}`;

function request() {
  const form = new FormData();
  form.set('name', 'Kitchen screen');
  form.set('branchId', 'branch_1');
  form.set('kind', 'KDS');
  form.set('stationId', 'station_1');
  form.set('confirmation', 'confirmed');
  return new Request('https://tenant.test/api/restaurant/devices/browser-enroll', {
    method: 'POST',
    headers: { origin: 'https://tenant.test', 'user-agent': 'route-test' },
    body: form,
  });
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  mocks.can.mockClear();
  mocks.recordAudit.mockClear();
  mocks.branchFindUnique.mockResolvedValue({ id: 'branch_1', name: 'Downtown' });
  mocks.stationFindFirst.mockResolvedValue({ id: 'station_1', name: 'Expo' });
  mocks.enrollDevice.mockResolvedValue({
    secret: rawSecret,
    device: {
      id: 'device_1',
      name: 'Kitchen screen',
      branchId: 'branch_1',
      kind: 'KDS',
      stationId: 'station_1',
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST browser enrollment', () => {
  it('uses production-safe cookies, returns no secret body, and audits metadata only', async () => {
    const response = await POST(request());
    const cookies = response.headers.getSetCookie();

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://tenant.test/kds');
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^devfathom-terminal=.*; Path=\/; Expires=.*; Max-Age=15552000; Secure; HttpOnly; SameSite=strict$/
        ),
        expect.stringMatching(
          /^__Secure-authjs\.session-token=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Secure; HttpOnly; SameSite=lax$/
        ),
      ])
    );
    expect(cookies.find((cookie) => cookie.startsWith('authjs.session-token='))).not.toContain(
      'Secure'
    );
    expect(await response.text()).toBe('');

    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_1',
        actorId: 'user_admin',
        outcome: 'SUCCESS',
        targetId: 'device_1',
        metadata: {
          deviceId: 'device_1',
          branchId: 'branch_1',
          kind: 'KDS',
          stationId: 'station_1',
        },
      })
    );
    expect(JSON.stringify(mocks.recordAudit.mock.calls)).not.toContain(rawSecret);
    expect(JSON.stringify(mocks.recordAudit.mock.calls)).not.toContain('cookie');
  });
});
