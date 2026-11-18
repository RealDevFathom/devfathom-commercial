import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  licensed: vi.fn(),
  annotateAudit: vi.fn(),
  managerGate: vi.fn(),
  setMembership: vi.fn(),
  assignments: vi.fn(),
  branch: vi.fn(),
  customer: vi.fn(),
  aggregate: vi.fn(),
  count: vi.fn(),
  entries: vi.fn(),
  reconciliations: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.licensed,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
}));
vi.mock('@/server/routers/pharmacy-sales', () => ({
  requireDrawerManagerAccess: mocks.managerGate,
}));
vi.mock('@/lib/pharmacy/loyalty-membership', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/loyalty-membership')>(
    '@/lib/pharmacy/loyalty-membership'
  )),
  setLoyaltyMembership: mocks.setMembership,
}));
import type { TRPCContext } from '@/server/trpc';
import { pharmacyLoyaltyRouter } from './loyalty-router';

function caller(role: 'ADMIN' | 'MEMBER', userId = role === 'ADMIN' ? 'owner-a' : 'manager-a') {
  const db = {
    $transaction: (run: (tx: unknown) => unknown) => run(db),
    pharmacyBranchAssignment: { findMany: mocks.assignments },
    pharmacyBranch: { findFirst: mocks.branch },
    pharmacyCustomer: { findFirst: mocks.customer },
    pharmacyLoyaltyPointsEntry: {
      aggregate: mocks.aggregate,
      count: mocks.count,
      findMany: mocks.entries,
    },
    pharmacyLoyaltyBalanceReconciliation: { findMany: mocks.reconciliations },
  };
  return pharmacyLoyaltyRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: { id: userId, organizationId: 'org-a', role, status: 'ACTIVE' },
    },
    entitlements: { organizationId: 'org-a', modules: [], enabledModules: ['pharmacy-crm'] },
    organization: { id: 'org-a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const deactivate = {
  branchId: 'branch-a',
  customerId: 'customer-a',
  active: false,
  reason: 'Asked to leave the programme',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.licensed.mockReturnValue(true);
  mocks.managerGate.mockResolvedValue({
    organizationId: 'org-a',
    branchId: 'branch-a',
    actorId: 'manager-a',
  });
  mocks.assignments.mockResolvedValue([{ branchId: 'branch-a' }, { branchId: 'branch-c' }]);
  mocks.branch.mockResolvedValue({ id: 'branch-a' });
  mocks.customer.mockResolvedValue({ id: 'customer-a', displayName: 'Retail customer' });
  mocks.aggregate.mockResolvedValue({ _sum: { points: 300 } });
  mocks.count.mockResolvedValue(1);
  mocks.entries.mockResolvedValue([{ id: 'entry-a', branchId: 'branch-a', points: 100 }]);
  mocks.reconciliations.mockResolvedValue([]);
});

describe('DEV-909 only the owner deactivates a loyalty member', () => {
  it('refuses a manager of the branch before the manager gate, any write or any audit', async () => {
    await expect(caller('MEMBER').setMembership(deactivate)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only the owner may deactivate a member for the whole organisation.',
    });
    expect(mocks.managerGate).not.toHaveBeenCalled();
    expect(mocks.setMembership).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('refuses a session administrator who has lost owner access', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller('ADMIN').setMembership(deactivate)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.setMembership).not.toHaveBeenCalled();
  });

  it('lets the owner deactivate a member and records it in the audit log', async () => {
    mocks.setMembership.mockResolvedValue({
      customer: { id: 'customer-a' },
      before: true,
      after: false,
      pointsBalance: 300,
      changed: true,
    });
    await expect(caller('ADMIN').setMembership(deactivate)).resolves.toEqual({
      loyaltyActive: false,
      changed: true,
    });
    expect(mocks.setMembership).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-a', actorId: 'owner-a', branchId: 'branch-a' },
      { customerId: 'customer-a', active: false, reason: 'Asked to leave the programme' }
    );
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacyLoyalty.deactivateMember',
        targetId: 'customer-a',
        changes: { loyaltyActive: { before: true, after: false } },
        metadata: expect.objectContaining({ authority: 'OWNER', reason: deactivate.reason }),
      })
    );
  });

  it('still lets a manager of the branch enrol a customer', async () => {
    mocks.setMembership.mockResolvedValue({
      customer: { id: 'customer-a' },
      before: false,
      after: true,
      pointsBalance: 0,
      changed: true,
    });
    await expect(
      caller('MEMBER').setMembership({ ...deactivate, active: true, reason: 'Joined today' })
    ).resolves.toEqual({ loyaltyActive: true, changed: true });
    expect(mocks.managerGate).toHaveBeenCalledWith(expect.anything(), 'branch-a');
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacyLoyalty.enrolMember',
        metadata: expect.objectContaining({ authority: 'MANAGER' }),
      })
    );
  });
});

describe('DEV-909 a branch manager reads history for their branches only', () => {
  const read = { branchId: 'branch-a', customerId: 'customer-a' };
  const listed = (extra: object = {}) => ({
    organizationId: 'org-a',
    customerId: 'customer-a',
    ...extra,
    NOT: { kind: 'EXPIRY', points: 0 },
  });

  it('shows the manager the shared balance with entries from their assigned branches', async () => {
    const history = await caller('MEMBER').history(read);
    expect(history.pointsBalance).toBe(300);
    expect(mocks.managerGate).toHaveBeenCalledWith(expect.anything(), 'branch-a');
    expect(mocks.assignments).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        userId: 'manager-a',
        active: true,
        branch: { organizationId: 'org-a', active: true },
      },
      select: { branchId: true },
    });
    // The balance is the one organization-wide balance.
    expect(mocks.aggregate).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', customerId: 'customer-a' },
      _sum: { points: true },
    });
    const mine = { branchId: { in: ['branch-a', 'branch-c'] } };
    expect(mocks.count).toHaveBeenCalledWith({ where: listed(mine) });
    expect(mocks.entries).toHaveBeenCalledWith(expect.objectContaining({ where: listed(mine) }));
    expect(mocks.reconciliations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', customerId: 'customer-a', ...mine },
      })
    );
  });

  it('shows the owner every branch', async () => {
    await caller('ADMIN').history(read);
    expect(mocks.managerGate).not.toHaveBeenCalled();
    expect(mocks.assignments).not.toHaveBeenCalled();
    expect(mocks.count).toHaveBeenCalledWith({ where: listed() });
    expect(mocks.entries).toHaveBeenCalledWith(expect.objectContaining({ where: listed() }));
  });

  it('refuses a cashier, or a manager of another branch, before any ledger read', async () => {
    mocks.managerGate.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(caller('MEMBER').history(read)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.assignments).not.toHaveBeenCalled();
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(mocks.aggregate).not.toHaveBeenCalled();
    expect(mocks.entries).not.toHaveBeenCalled();
  });
});
