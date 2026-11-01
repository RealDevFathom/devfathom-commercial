import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(), branch: vi.fn(), solo: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async (original) => ({
  ...(await original<typeof import('@/lib/abac')>()),
  can: mocks.can,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  isAuditExcludedPath: () => true,
}));
vi.mock('@/lib/pharmacy/branch-assignment', () => ({ assertBranchAssignment: mocks.branch }));
vi.mock('@/lib/pharmacy/solo-approval', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/solo-approval')>()),
  soloOwnerEligible: mocks.solo,
}));

import { pharmacySalesRouter } from './pharmacy-sales';
import type { TRPCContext } from '../trpc';

function fixture(operatingMode: 'SOLO' | 'STAFFED' = 'SOLO') {
  const db = {
    pharmacyBranch: { findMany: vi.fn(async () => [{ id: 'branch' }]) },
    organization: { findFirst: vi.fn(async () => ({ pharmacyOperatingMode: operatingMode })) },
    user: {
      findMany: vi.fn(async () => [{ id: 'colleague', name: 'Colleague', email: 'c@x.invalid' }]),
    },
  };
  const ctx = {
    db,
    session: { user: { id: 'actor', organizationId: 'org', status: 'ACTIVE', role: 'EMPLOYEE' } },
    entitlements: { organizationId: 'org', enabledModules: ['pharmacy-counter'] },
    audit: { detail: {} },
    requestMeta: { ip: null, userAgent: null },
  } as unknown as TRPCContext;
  return { db, caller: pharmacySalesRouter.createCaller(ctx) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.branch.mockImplementation(async (_db, scope) => scope);
  mocks.solo.mockResolvedValue(false);
});

describe.each(['rxApprovers', 'approvalCheckers'] as const)('%s', (procedure) => {
  it('refuses a branch member without counter or dispense capability before listing colleagues', async () => {
    mocks.can.mockResolvedValue(false);
    const f = fixture();
    await expect(f.caller[procedure]({ branchId: 'branch' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.user.findMany).not.toHaveBeenCalled();
  });

  it('reports the configured operating mode separately from the approval path', async () => {
    mocks.can.mockResolvedValue(true);
    const f = fixture('SOLO');
    // A SOLO pharmacy whose roster no longer passes the sole-owner rule.
    mocks.solo.mockResolvedValue(false);
    await expect(f.caller[procedure]({ branchId: 'branch' })).resolves.toMatchObject({
      mode: 'STAFFED',
      operatingMode: 'SOLO',
      soloApprovalAllowed: false,
    });
  });
});

it('lists only system owner, owner-operator and manager roles as non-clinical checkers', async () => {
  mocks.can.mockResolvedValue(true);
  const f = fixture('STAFFED');
  await f.caller.approvalCheckers({ branchId: 'branch' });
  expect(f.db.user.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        organizationRole: { key: { in: ['owner', 'owner-operator', 'manager'] }, isSystem: true },
      }),
    })
  );
});
