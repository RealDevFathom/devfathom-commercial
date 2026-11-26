import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  enrollDevice: vi.fn(),
  resolveOrganizationEntitlements: vi.fn(),
  recordAudit: vi.fn(),
  branchFindUnique: vi.fn(),
  stationFindFirst: vi.fn(),
  resolveCapabilityBranchAuthorization: vi.fn(),
  support: null as null | { platformUserId: string },
  isDemo: false,
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
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: mocks.resolveOrganizationEntitlements,
}));
vi.mock('@/lib/restaurant/commercial-limits', () => ({
  CommercialLimitError: class CommercialLimitError extends Error {},
  enrollDeviceWithinCommercialLimits: mocks.enrollDevice,
}));
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  TERMINAL_DEVICE_COOKIE: 'devfathom-terminal',
}));
vi.mock('@/lib/restaurant/staff-branch-authorization', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/restaurant/staff-branch-authorization')
  >('@/lib/restaurant/staff-branch-authorization');
  return {
    ...actual,
    resolveCapabilityBranchAuthorization: mocks.resolveCapabilityBranchAuthorization,
  };
});
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (_organizationId: string, callback: (db: unknown) => unknown) =>
    callback({
      restaurantBranch: { findUnique: mocks.branchFindUnique },
      restaurantKitchenStation: { findFirst: mocks.stationFindFirst },
    }),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: async () => ({
    organization: { id: 'org_1', isDemo: mocks.isDemo },
    support: mocks.support,
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

import { SUPPORT_SESSION_REFUSED_MESSAGE } from '@/lib/tenancy/support-session-rule';
import { POST } from './route';

const rawSecret = `rdk_${'a'.repeat(43)}`;

function request(cookie?: string) {
  const form = new FormData();
  form.set('name', 'Kitchen screen');
  form.set('branchId', 'branch_1');
  form.set('kind', 'KDS');
  form.set('stationId', 'station_1');
  form.set('confirmation', 'confirmed');
  return new Request('https://tenant.test/api/restaurant/devices/browser-enroll', {
    method: 'POST',
    headers: {
      origin: 'https://tenant.test',
      'user-agent': 'route-test',
      ...(cookie ? { cookie } : {}),
    },
    body: form,
  });
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  mocks.can.mockClear();
  mocks.enrollDevice.mockClear();
  mocks.resolveOrganizationEntitlements.mockReset();
  mocks.resolveOrganizationEntitlements.mockResolvedValue({
    limits: { 'pos.registeredDevices.max': 10, 'pos.terminals.max': 10 },
  });
  mocks.recordAudit.mockClear();
  mocks.support = null;
  mocks.isDemo = false;
  mocks.branchFindUnique.mockClear();
  mocks.branchFindUnique.mockResolvedValue({ id: 'branch_1', name: 'Downtown' });
  mocks.stationFindFirst.mockResolvedValue({ id: 'station_1', name: 'Expo' });
  mocks.resolveCapabilityBranchAuthorization.mockResolvedValue({
    actorStaffProfileId: 'staff_manager_a',
    actorBranchIds: ['branch_1'],
    organizationWide: false,
    branchIds: ['branch_1'],
  });
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

  it('rejects support impersonation before authorization, device creation, or success audit', async () => {
    mocks.support = { platformUserId: 'platform_support_1' };

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: SUPPORT_SESSION_REFUSED_MESSAGE,
    });
    expect(mocks.can).not.toHaveBeenCalled();
    expect(mocks.enrollDevice).not.toHaveBeenCalled();
    // DEV-1053: no success entry; the refusal itself is recorded, naming the operator.
    expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_1',
        actorId: 'user_admin',
        source: 'REST_API',
        action: 'restaurant.devices.browserEnroll',
        outcome: 'FAILURE',
        statusCode: 403,
        metadata: expect.objectContaining({
          supportSessionRefused: true,
          platformUserId: 'platform_support_1',
          actingAsTenantUserId: 'user_admin',
        }),
      })
    );
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('rejects manual device enrollment for a demo organization', async () => {
    mocks.isDemo = true;

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Not available in demo.' });
    expect(mocks.can).not.toHaveBeenCalled();
    expect(mocks.enrollDevice).not.toHaveBeenCalled();
  });

  it('denies a Branch A manager attempting to enroll a device at Branch B', async () => {
    mocks.resolveCapabilityBranchAuthorization.mockResolvedValue({
      actorStaffProfileId: 'staff_manager_a',
      actorBranchIds: ['branch_a'],
      organizationWide: false,
      branchIds: ['branch_a'],
    });

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Device-management permission is required.',
    });

    expect(mocks.resolveCapabilityBranchAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'user_admin' }),
      'devices:manage',
      { organizationId: 'org_1' }
    );
    expect(mocks.branchFindUnique).not.toHaveBeenCalled();
    expect(mocks.enrollDevice).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it('keeps local terminal and normal Auth.js cookies non-Secure', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    const response = await POST(request());
    const cookies = response.headers.getSetCookie();
    const terminalCookie = cookies.find((cookie) => cookie.startsWith('devfathom-terminal='));
    const localAuthDeletion = cookies.find((cookie) => cookie.startsWith('authjs.session-token='));
    const secureAuthDeletion = cookies.find((cookie) =>
      cookie.startsWith('__Secure-authjs.session-token=')
    );

    expect(terminalCookie).toContain('HttpOnly');
    expect(terminalCookie).toContain('SameSite=strict');
    expect(terminalCookie).not.toContain('Secure');
    expect(localAuthDeletion).toContain('Max-Age=0');
    expect(localAuthDeletion).not.toContain('Secure');
    expect(secureAuthDeletion).toContain('Secure');
  });

  it('expires every Auth.js session cookie chunk supplied by the enrolling browser', async () => {
    const response = await POST(
      request(
        'authjs.session-token.0=local-first; authjs.session-token.1=local-second; ' +
          '__Secure-authjs.session-token.0=secure-first; ' +
          '__Secure-authjs.session-token.12=secure-last; authjs.session-token.1=duplicate; ' +
          'authjs.session-token.invalid=preserved; authjs.session-token.2; ' +
          'unrelated-cookie=preserved'
      )
    );
    const cookies = response.headers.getSetCookie();

    for (const name of [
      'authjs.session-token.0',
      'authjs.session-token.1',
      '__Secure-authjs.session-token.0',
      '__Secure-authjs.session-token.12',
    ]) {
      const deletion = cookies.find((cookie) => cookie.startsWith(`${name}=`));
      expect(deletion).toContain('Max-Age=0');
      expect(deletion).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
      expect(deletion?.includes('Secure')).toBe(name.startsWith('__Secure-'));
    }
    expect(cookies.filter((cookie) => cookie.startsWith('authjs.session-token.1='))).toHaveLength(
      1
    );
    expect(cookies.some((cookie) => cookie.startsWith('authjs.session-token.invalid='))).toBe(
      false
    );
    expect(cookies.some((cookie) => cookie.startsWith('authjs.session-token.2='))).toBe(false);
    expect(cookies.some((cookie) => cookie.startsWith('unrelated-cookie='))).toBe(false);
  });
});
