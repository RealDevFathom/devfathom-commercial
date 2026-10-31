import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  licensed: vi.fn(),
  branches: vi.fn(),
  customers: vi.fn(),
  history: vi.fn(),
  branch: vi.fn(),
  updateCustomers: vi.fn(),
  findCustomer: vi.fn(),
  annotateAudit: vi.fn(),
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
vi.mock('@/lib/pharmacy/customer-loyalty', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/customer-loyalty')>(
    '@/lib/pharmacy/customer-loyalty'
  )),
  listLoyaltyCustomers: mocks.customers,
  readLoyaltyHistory: mocks.history,
}));
import type { TRPCContext } from '@/server/trpc';
import { pharmacyLoyaltyRouter } from './loyalty-router';
function caller({
  organizationId = 'org-a',
  entitlementOrg = 'org-a',
  status = 'ACTIVE',
  session = true,
} = {}) {
  return pharmacyLoyaltyRouter.createCaller({
    db: {
      pharmacyBranch: { findMany: mocks.branches, findFirst: mocks.branch },
      pharmacyCustomer: { updateMany: mocks.updateCustomers, findFirst: mocks.findCustomer },
    },
    session: session
      ? { expires: 'later', user: { id: 'owner-a', organizationId, role: 'ADMIN', status } }
      : null,
    entitlements: { organizationId: entitlementOrg, modules: [], enabledModules: ['pharmacy-crm'] },
    organization: { id: 'org-a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.licensed.mockReturnValue(true);
  mocks.branches.mockResolvedValue([]);
  mocks.customers.mockResolvedValue({ customers: [], hasMore: false });
  mocks.history.mockResolvedValue({ entries: [] });
  mocks.branch.mockResolvedValue({ id: 'branch-a' });
  mocks.updateCustomers.mockResolvedValue({ count: 1 });
  mocks.findCustomer.mockResolvedValue({ id: 'customer-a', preferredLanguage: 'en' });
});
describe('ordinary loyalty router visibility', () => {
  it('hands trusted scope and requested page to history', async () => {
    await caller().history({ branchId: 'branch-a', customerId: 'customer-a', page: 2 });
    expect(mocks.history).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-a', actorId: 'owner-a', branchId: 'branch-a' },
      'customer-a',
      2
    );
  });
  it('lists only current tenant active branches', async () => {
    await caller().branches();
    expect(mocks.branches).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', active: true },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  });
  it('denies missing capability before customer reads', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().customers({ branchId: 'branch-a' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.customers).not.toHaveBeenCalled();
  });
  it('denies missing CRM entitlement', async () => {
    mocks.licensed.mockReturnValue(false);
    await expect(caller().branches()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branches).not.toHaveBeenCalled();
  });
  it.each([{ organizationId: 'org-b' }, { entitlementOrg: 'org-b' }])(
    'denies mismatched tenant identities %j',
    async (options) => {
      await expect(caller(options).branches()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.branches).not.toHaveBeenCalled();
    }
  );
  it.each([{ session: false }, { status: 'INACTIVE' }])(
    'denies unusable session %j',
    async (options) => {
      await expect(caller(options).branches()).rejects.toThrow();
      expect(mocks.branches).not.toHaveBeenCalled();
    }
  );
  it('rejects caller-supplied organization scope', async () => {
    await expect(
      caller().history({
        branchId: 'branch-a',
        customerId: 'customer-a',
        organizationId: 'org-b',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it('persists only a validated language for an active customer in the authorized tenant', async () => {
    await expect(
      caller().setReminderLanguage({
        branchId: 'branch-a',
        customerId: 'customer-a',
        preferredLanguage: 'ur',
      })
    ).resolves.toEqual({ preferredLanguage: 'ur' });
    expect(mocks.updateCustomers).toHaveBeenCalledWith({
      where: { id: 'customer-a', organizationId: 'org-a', active: true },
      data: { preferredLanguage: 'ur' },
    });
    expect(mocks.findCustomer).toHaveBeenCalledWith({
      where: { id: 'customer-a', organizationId: 'org-a', active: true },
      select: { id: true, preferredLanguage: true },
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacyCustomer.setReminderLanguage',
        targetType: 'PharmacyCustomer',
        targetId: 'customer-a',
        changes: { preferredLanguage: { before: 'en', after: 'ur' } },
      })
    );
    await expect(
      caller().setReminderLanguage({
        branchId: 'branch-a',
        customerId: 'customer-a',
        preferredLanguage: 'fr',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('does not update a customer when the requested branch is inactive or unavailable', async () => {
    mocks.branch.mockResolvedValue(null);

    await expect(
      caller().setReminderLanguage({
        branchId: 'branch-a',
        customerId: 'customer-a',
        preferredLanguage: 'ur',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.updateCustomers).not.toHaveBeenCalled();
  });

  it('reports an inactive or unavailable customer without claiming the preference was saved', async () => {
    mocks.updateCustomers.mockResolvedValue({ count: 0 });

    await expect(
      caller().setReminderLanguage({
        branchId: 'branch-a',
        customerId: 'customer-a',
        preferredLanguage: 'ur',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('does not update or audit a customer outside the authorized tenant', async () => {
    mocks.findCustomer.mockResolvedValue(null);

    await expect(
      caller().setReminderLanguage({
        branchId: 'branch-a',
        customerId: 'customer-b',
        preferredLanguage: 'ur',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.updateCustomers).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });
});
