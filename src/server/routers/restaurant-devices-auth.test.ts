import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => false),
  list: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { restaurantDevicesRouter } from './restaurant-devices';

function caller() {
  return restaurantDevicesRouter.createCaller({
    db: { restaurantRegisteredDevice: { findMany: mocks.list } },
    entitlements: { enabledModules: ['restaurant-pos'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user_admin', role: 'ADMIN', status: 'ACTIVE' },
    },
    organization: { id: 'org_1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  mocks.can.mockReset();
  mocks.can.mockResolvedValue(false);
  mocks.list.mockReset();
});

describe('restaurant device capability boundary', () => {
  it('denies an administrator who lacks devices:manage before reading devices', async () => {
    await expect(caller().list()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_admin' }),
      'devices:manage',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('requires devices:revoke before attempting a device revocation', async () => {
    await expect(
      caller().revoke({
        deviceId: 'device_1',
        approvingStaffProfileId: 'staff_approver',
        approvingType: 'PIN',
        approvingSecret: '1234',
        reason: 'lost device',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_admin' }),
      'devices:revoke',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
  });
});
