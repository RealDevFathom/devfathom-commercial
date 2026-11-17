import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  licensed: vi.fn(),
  annotateAudit: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  queryRaw: vi.fn(),
  managerGate: vi.fn(),
  setMembership: vi.fn(),
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
import { PharmacyLoyaltyError } from '@/lib/pharmacy/customer-loyalty';
import { pharmacyLoyaltyRouter } from './loyalty-router';

function caller(role = 'ADMIN') {
  const db = {
    $queryRaw: mocks.queryRaw,
    $transaction: (run: (tx: unknown) => unknown) => run(db),
    pharmacyLoyaltyProgramVersion: {
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
      create: mocks.create,
    },
  };
  return pharmacyLoyaltyRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: { id: 'user-a', organizationId: 'org-a', role, status: 'ACTIVE' },
    },
    entitlements: { organizationId: 'org-a', modules: [], enabledModules: ['pharmacy-crm'] },
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
  mocks.queryRaw.mockResolvedValue([]);
});

describe('DEV-764 enrol and deactivate a loyalty member', () => {
  const input = {
    branchId: 'branch-a',
    customerId: 'customer-a',
    active: false,
    reason: 'Asked to leave the programme',
  };
  beforeEach(() => {
    mocks.setMembership.mockResolvedValue({
      customer: { id: 'customer-a' },
      before: true,
      after: false,
      pointsBalance: 140,
      changed: true,
    });
  });

  it('lets the owner deactivate a member, and audits the change with its reason', async () => {
    await expect(caller('ADMIN').setMembership(input)).resolves.toEqual({
      loyaltyActive: false,
      changed: true,
    });
    expect(mocks.managerGate).not.toHaveBeenCalled();
    expect(mocks.setMembership).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-a', actorId: 'user-a', branchId: 'branch-a' },
      { customerId: 'customer-a', active: false, reason: 'Asked to leave the programme' }
    );
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacyLoyalty.deactivateMember',
        targetType: 'PharmacyCustomer',
        targetId: 'customer-a',
        changes: { loyaltyActive: { before: true, after: false } },
        metadata: expect.objectContaining({
          reason: 'Asked to leave the programme',
          authority: 'OWNER',
          pointsBalance: 140,
          branchId: 'branch-a',
        }),
      })
    );
  });

  it('lets a manager of the branch re-enrol a member through the manager gate', async () => {
    mocks.managerGate.mockResolvedValue({
      organizationId: 'org-a',
      branchId: 'branch-a',
      actorId: 'user-a',
    });
    mocks.setMembership.mockResolvedValue({
      customer: { id: 'customer-a' },
      before: false,
      after: true,
      pointsBalance: 140,
      changed: true,
    });
    await caller('MEMBER').setMembership({ ...input, active: true, reason: 'Rejoined' });
    expect(mocks.managerGate).toHaveBeenCalledWith(expect.anything(), 'branch-a');
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacyLoyalty.enrolMember',
        changes: { loyaltyActive: { before: false, after: true } },
        metadata: expect.objectContaining({ authority: 'MANAGER' }),
      })
    );
  });

  it('refuses a cashier, and a change without a reason, before any write', async () => {
    mocks.managerGate.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(caller('MEMBER').setMembership(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller('ADMIN').setMembership({ ...input, reason: 'no' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.setMembership).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('refuses without the CRM package', async () => {
    mocks.licensed.mockReturnValue(false);
    await expect(caller('ADMIN').setMembership(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.setMembership).not.toHaveBeenCalled();
  });

  it('says plainly when re-enrolment needs current loyalty consent', async () => {
    mocks.setMembership.mockRejectedValue(new PharmacyLoyaltyError('LOYALTY_CONSENT_REQUIRED'));
    await expect(
      caller('ADMIN').setMembership({ ...input, active: true, reason: 'Rejoined' })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('loyalty consent'),
    });
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('answers an unknown customer as not found', async () => {
    mocks.setMembership.mockRejectedValue(new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND'));
    await expect(caller('ADMIN').setMembership(input)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
