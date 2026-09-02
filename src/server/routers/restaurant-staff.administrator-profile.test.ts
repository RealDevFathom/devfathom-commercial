/**
 * WHA-1181 — the tenant-side repair for an organization activated before its
 * administrator was provisioned a `RestaurantStaffProfile`: the check the
 * workspace shell renders its call to action from, and the mutation behind it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
  annotateAudit: vi.fn(),
  staffFindFirst: vi.fn(),
  staffCreate: vi.fn(),
  branchFindFirst: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import { restaurantStaffRouter } from './restaurant-staff';
import type { TRPCContext } from '../trpc';

const db = {
  restaurantStaffProfile: { findFirst: mocks.staffFindFirst, create: mocks.staffCreate },
  restaurantBranch: { findFirst: mocks.branchFindFirst },
};

function caller() {
  return restaurantStaffRouter.createCaller({
    db,
    entitlements: {
      enabledModules: ['restaurant-core'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: { 'restaurant.operators.max': 50 },
    },
    session: {
      expires: 'later',
      user: {
        id: 'user_admin',
        name: 'Restaurant Owner',
        email: 'owner@example.test',
        organizationId: 'org_1',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
      },
    },
    organization: { id: 'org_1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.staffFindFirst.mockResolvedValue(null);
  mocks.branchFindFirst.mockResolvedValue({ id: 'branch_default' });
  mocks.staffCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'staff_new',
    primaryBranchId: data.primaryBranchId,
  }));
});

describe('restaurantStaff.mySelfProfile', () => {
  it('reports the missing profile that makes every restaurant call answer 403', async () => {
    await expect(caller().mySelfProfile()).resolves.toEqual({ hasProfile: false, status: null });
    expect(mocks.staffFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_admin' } })
    );
  });

  it('reports a healthy workspace so the call to action never renders', async () => {
    mocks.staffFindFirst.mockResolvedValue({ id: 'staff_1', status: 'ACTIVE' });

    await expect(caller().mySelfProfile()).resolves.toEqual({
      hasProfile: true,
      status: 'ACTIVE',
    });
  });

  it('answers without a capability decision, since the caller may have no profile at all', async () => {
    await caller().mySelfProfile();
    expect(mocks.can).not.toHaveBeenCalled();
  });
});

describe('restaurantStaff.provisionMyProfile', () => {
  it('creates only the calling administrator’s own profile, against the default branch', async () => {
    const result = await caller().provisionMyProfile();

    expect(result).toEqual({
      created: true,
      staffProfileId: 'staff_new',
      primaryBranchId: 'branch_default',
    });
    expect(mocks.staffCreate).toHaveBeenCalledOnce();
    expect(mocks.staffCreate.mock.calls[0]![0].data).toMatchObject({
      organizationId: 'org_1',
      // The session's own id — a caller cannot name someone else.
      userId: 'user_admin',
      displayName: 'Restaurant Owner',
      primaryBranchId: 'branch_default',
      status: 'ACTIVE',
    });
  });

  it('audits the repair', async () => {
    await caller().provisionMyProfile();

    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'RestaurantStaffProfile',
        targetId: 'staff_new',
        metadata: { primaryBranchId: 'branch_default', selfProvisioned: true },
      })
    );
  });

  it('is idempotent: a second call writes nothing and audits nothing', async () => {
    mocks.staffFindFirst.mockResolvedValue({ id: 'staff_1', primaryBranchId: 'branch_default' });

    const result = await caller().provisionMyProfile();

    expect(result).toEqual({
      created: false,
      staffProfileId: 'staff_1',
      primaryBranchId: 'branch_default',
    });
    expect(mocks.staffCreate).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('is denied when the ABAC decision withholds staff:manage', async () => {
    mocks.can.mockResolvedValue(false);

    await expect(caller().provisionMyProfile()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.staffCreate).not.toHaveBeenCalled();
  });
});
