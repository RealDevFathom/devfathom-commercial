import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => false),
  list: vi.fn(),
  staffCapabilities: vi.fn(async (): Promise<Set<string>> => new Set()),
  findDevice: vi.fn(),
  createCoAuthorization: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/restaurant/job-roles', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/job-roles')>(
    '@/lib/restaurant/job-roles'
  );
  return { ...actual, resolveStaffCapabilities: mocks.staffCapabilities };
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
    db: {
      restaurantRegisteredDevice: { findMany: mocks.list, findUnique: mocks.findDevice },
      restaurantStaffProfile: {
        findMany: vi.fn(async () => [
          {
            id: 'staff_acting',
            primaryBranchId: 'branch_1',
            jobRoles: [{ branchId: 'branch_1' }],
            directCapabilityGrants: [],
          },
        ]),
      },
      restaurantBranch: { findMany: vi.fn(async () => [{ id: 'branch_1' }]) },
      restaurantCoAuthorization: { create: mocks.createCoAuthorization },
    },
    entitlements: { enabledModules: ['restaurant-pos'], modules: [], organizationId: 'org_1' },
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
  mocks.staffCapabilities.mockReset();
  mocks.staffCapabilities.mockResolvedValue(new Set());
  mocks.findDevice.mockReset();
  mocks.findDevice.mockResolvedValue({
    id: 'device_1',
    branchId: 'branch_1',
    name: 'Front POS',
    status: 'ACTIVE',
    revokedAt: null,
  });
  mocks.createCoAuthorization.mockReset();
});

const revokeInput = {
  deviceId: 'device_1',
  approvingStaffProfileId: 'staff_approver',
  approvingType: 'PIN' as const,
  approvingSecret: '482913',
  reason: 'lost terminal',
};

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

  it('denies revocation to a branch actor with devices:manage but not devices:revoke', async () => {
    // Device administration is granted (procedure gate and branch role), but not
    // organization-wide configuration and not the dedicated revoke capability.
    mocks.can.mockImplementation(async (...args: unknown[]) => args[1] === 'devices:manage');
    mocks.staffCapabilities.mockResolvedValue(new Set(['devices:manage', 'coauth:approve']));

    await expect(caller().revoke(revokeInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.findDevice).not.toHaveBeenCalled();
    expect(mocks.createCoAuthorization).not.toHaveBeenCalled();
  });

  it('checks devices:revoke for the acting branch before looking up the device', async () => {
    mocks.can.mockImplementation(async (...args: unknown[]) => args[1] === 'devices:manage');
    mocks.staffCapabilities.mockResolvedValue(new Set(['devices:manage', 'devices:revoke']));
    mocks.findDevice.mockResolvedValue(null);

    await expect(caller().revoke(revokeInput)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mocks.staffCapabilities).toHaveBeenCalledWith(
      expect.anything(),
      'staff_acting',
      'branch_1'
    );
    expect(mocks.findDevice).toHaveBeenCalledWith({ where: { id: 'device_1' } });
    expect(mocks.createCoAuthorization).not.toHaveBeenCalled();
  });

  it.each([
    [new Set(['devices:manage']), false],
    [new Set(['devices:manage', 'devices:revoke']), true],
  ])('lists canRevoke from the branch devices:revoke scope (%o)', async (capabilities, canRevoke) => {
    mocks.can.mockImplementation(async (...args: unknown[]) => args[1] === 'devices:manage');
    mocks.staffCapabilities.mockResolvedValue(capabilities);
    mocks.list.mockResolvedValue([
      {
        id: 'device_1',
        name: 'Front POS',
        kind: 'POS',
        branchId: 'branch_1',
        branch: { id: 'branch_1', name: 'Downtown' },
        stationId: null,
        status: 'ACTIVE',
        lastSeenAt: null,
        revokedAt: null,
        createdAt: new Date('2026-08-18T07:00:00Z'),
      },
      {
        id: 'device_2',
        name: 'Old POS',
        kind: 'POS',
        branchId: 'branch_1',
        branch: { id: 'branch_1', name: 'Downtown' },
        stationId: null,
        status: 'REVOKED',
        lastSeenAt: null,
        revokedAt: new Date('2026-08-19T07:00:00Z'),
        createdAt: new Date('2026-08-18T07:00:00Z'),
      },
    ]);

    const devices = await caller().list();

    expect(devices.map((device) => [device.id, device.canRevoke])).toEqual([
      ['device_1', canRevoke],
      ['device_2', false],
    ]);
  });
});
