import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-845: `pharmacy:orders` says what a staff member may do; the branch
// assignment says where. Every branch-scoped staff procedure refuses a branch
// the caller is not actively assigned to, before any ordering or refill
// command runs. A tenant admin or owner keeps every active branch; a solo
// owner assigned to the branch is unaffected.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(),
  withTenantDb: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/customer-delivery', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/customer-delivery')>()),
  recordDeliveryCommand: vi.fn(async () => ({ replayed: false })),
}));
vi.mock('@/lib/pharmacy/customer-ordering', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/customer-ordering')>()),
  listStaffCustomerOrders: vi.fn(async () => []),
  placeCustomerOrder: vi.fn(async () => ({ id: 'order-1' })),
  transitionCustomerOrder: vi.fn(async () => ({ id: 'order-1' })),
  startCustomerOrderCheckout: vi.fn(async () => ({ id: 'order-1' })),
  completeCustomerOrder: vi.fn(async () => ({ id: 'order-1' })),
}));
vi.mock('@/lib/pharmacy/customer-portal', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/customer-portal')>()),
  mintPortalLink: vi.fn(async () => ({ url: 'https://portal.invalid/link' })),
  listPortalQueue: vi.fn(async () => []),
  decidePortalRequest: vi.fn(async () => ({ id: 'request-1' })),
  confirmPortalKhataPayment: vi.fn(async () => ({ receiptReference: 'KP-1' })),
}));
vi.mock('@/lib/pharmacy/refill-subscriptions', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/refill-subscriptions')>()),
  listRefillSubscriptions: vi.fn(async () => []),
  createRefillSubscription: vi.fn(async () => ({ id: 'subscription-1' })),
  setRefillSubscriptionPaused: vi.fn(async () => ({ id: 'subscription-1' })),
  cancelRefillSubscription: vi.fn(async () => ({ id: 'subscription-1' })),
  openRefillCycle: vi.fn(async () => ({ id: 'cycle-1' })),
  listDueRefillSubscriptionIds: vi.fn(async () => []),
  verifyRefillCyclePharmacistPin: vi.fn(async () => ({ approvedByUserId: 'user-a' })),
  approveRefillCycle: vi.fn(async () => ({ id: 'cycle-1' })),
  releaseRefillCycle: vi.fn(async () => ({ id: 'cycle-1' })),
  startRefillCycleCheckout: vi.fn(async () => ({ id: 'cycle-1' })),
}));

import { annotateAudit } from '@/server/audit';
import { recordDeliveryCommand } from '@/lib/pharmacy/customer-delivery';
import {
  completeCustomerOrder,
  listStaffCustomerOrders,
  placeCustomerOrder,
  startCustomerOrderCheckout,
  transitionCustomerOrder,
} from '@/lib/pharmacy/customer-ordering';
import {
  createRefillSubscription,
  listDueRefillSubscriptionIds,
  listRefillSubscriptions,
  openRefillCycle,
  releaseRefillCycle,
  setRefillSubscriptionPaused,
  startRefillCycleCheckout,
  verifyRefillCyclePharmacistPin,
} from '@/lib/pharmacy/refill-subscriptions';
import {
  confirmPortalKhataPayment,
  decidePortalRequest,
  listPortalQueue,
  mintPortalLink,
} from '@/lib/pharmacy/customer-portal';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { router, type TRPCContext } from '../trpc';
import { pharmacyOrderingRouter } from './pharmacy-ordering';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const app = router({ pharmacyOrdering: pharmacyOrderingRouter });
const ORDERS: Rule = { capability: 'pharmacy:orders', effect: 'ALLOW' };
const OUTSIDE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };

type Member = {
  role: 'EMPLOYEE' | 'ADMIN';
  rules: Rule[];
  systemRole?: { key: string; isSystem: boolean };
  overrides?: Rule[];
  assigned: string[];
};

function fixture(member: Member) {
  const stored = {
    id: 'user-a',
    organizationId: 'org-a',
    role: member.role,
    status: 'ACTIVE',
    organizationRole: { ...(member.systemRole ?? {}), permissions: member.rules },
    permissionOverrides: member.overrides ?? [],
  };
  const db = {
    user: {
      findUnique: vi.fn(async () => stored),
      findFirst: vi.fn(async (args: { where: { id: string; organizationId: string } }) =>
        args.where.id === stored.id && args.where.organizationId === stored.organizationId
          ? stored
          : null
      ),
      findMany: vi.fn(async () => [{ id: 'runner-1', name: 'Runner' }]),
    },
    pharmacyCustomer: {
      findMany: vi.fn(async () => [
        { id: 'customer-1', displayName: 'Customer', phoneLast4: '4567' },
      ]),
    },
    pharmacyBranch: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => ({ id }))
      ),
    },
    pharmacyBranchAssignment: {
      findFirst: vi.fn(async (args: { where: { branchId: string; userId: string } }) =>
        args.where.userId === 'user-a' && member.assigned.includes(args.where.branchId)
          ? { id: `assignment-${args.where.branchId}` }
          : null
      ),
      findMany: vi.fn(async (args: { where: { userId: string } }) =>
        args.where.userId === 'user-a' ? member.assigned.map((branchId) => ({ branchId })) : []
      ),
    },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  vi.mocked(withTenantDb).mockImplementation(async (_organizationId, run) =>
    (run as (tx: unknown) => Promise<unknown>)(db)
  );
  const caller = app.createCaller({
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user-a', role: member.role, status: 'ACTIVE', organizationId: 'org-a' },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacyOrdering;
  return { db, caller };
}

type Caller = ReturnType<typeof fixture>['caller'];
type StaffPath = {
  name: string;
  run: (caller: Caller, branchId: string) => Promise<unknown>;
  command: () => unknown;
};

const staffPaths: StaffPath[] = [
  {
    name: 'deliveryCommand',
    run: (caller, branchId) =>
      caller.deliveryCommand({
        branchId,
        orderId: 'order-1',
        action: 'REMIT',
        amountMinor: 1500,
        reference: 'Rider handover',
        requestKey: 'remit-1',
        deviceId: 'counter-device',
        businessDate: new Date('2026-11-14T00:00:00.000Z'),
      }),
    command: () => recordDeliveryCommand,
  },
  {
    name: 'staffQueue',
    run: (caller, branchId) => caller.staffQueue({ branchId }),
    command: () => listStaffCustomerOrders,
  },
  {
    name: 'transition',
    run: (caller, branchId) =>
      caller.transition({ branchId, orderId: 'order-1', action: 'accept' }),
    command: () => transitionCustomerOrder,
  },
  {
    name: 'startCheckout',
    run: (caller, branchId) => caller.startCheckout({ branchId, orderId: 'order-1' }),
    command: () => startCustomerOrderCheckout,
  },
  {
    name: 'complete',
    run: (caller, branchId) => caller.complete({ branchId, orderId: 'order-1' }),
    command: () => completeCustomerOrder,
  },
  {
    name: 'subscriptions',
    run: (caller, branchId) => caller.subscriptions({ branchId }),
    command: () => listRefillSubscriptions,
  },
  {
    name: 'createSubscription',
    run: (caller, branchId) =>
      caller.createSubscription({
        branchId,
        customerId: 'customer-1',
        medicineId: 'medicine-1',
        presentationId: 'presentation-1',
        packLevelId: 'pack-1',
        packsPerCycle: 1,
        fulfillment: 'COLLECT',
        paymentMode: 'PREPAY',
        firstDueAt: new Date('2026-12-01T00:00:00.000Z'),
      }),
    command: () => createRefillSubscription,
  },
  {
    name: 'setSubscriptionStatus',
    run: (caller, branchId) =>
      caller.setSubscriptionStatus({ branchId, subscriptionId: 'subscription-1', action: 'pause' }),
    command: () => setRefillSubscriptionPaused,
  },
  {
    name: 'openSubscriptionCycle',
    run: (caller, branchId) =>
      caller.openSubscriptionCycle({ branchId, subscriptionId: 'subscription-1' }),
    command: () => openRefillCycle,
  },
  {
    name: 'openDueSubscriptionCycles',
    run: (caller, branchId) => caller.openDueSubscriptionCycles({ branchId }),
    command: () => listDueRefillSubscriptionIds,
  },
  {
    name: 'approveSubscriptionCycle',
    run: (caller, branchId) =>
      caller.approveSubscriptionCycle({
        branchId,
        cycleId: 'cycle-1',
        pharmacistPin: { staffProfileId: 'staff-1', pin: '7391' },
      }),
    command: () => verifyRefillCyclePharmacistPin,
  },
  {
    name: 'releaseSubscriptionCycle',
    run: (caller, branchId) => caller.releaseSubscriptionCycle({ branchId, cycleId: 'cycle-1' }),
    command: () => releaseRefillCycle,
  },
  {
    name: 'startSubscriptionCycleCheckout',
    run: (caller, branchId) =>
      caller.startSubscriptionCycleCheckout({ branchId, cycleId: 'cycle-1' }),
    command: () => startRefillCycleCheckout,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DEV-845 pharmacyOrdering staff procedures: branch assignment', () => {
  it.each(staffPaths)('$name refuses an orders member not assigned to the branch', async (path) => {
    const { caller, db } = fixture({ role: 'EMPLOYEE', rules: [ORDERS], assigned: ['branch-b'] });
    await expect(path.run(caller, 'branch-a')).rejects.toMatchObject(OUTSIDE);
    expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          branchId: 'branch-a',
          userId: 'user-a',
          active: true,
        }),
      })
    );
    expect(path.command()).not.toHaveBeenCalled();
  });

  it.each(staffPaths)('$name admits an orders member assigned to the branch', async (path) => {
    const { caller } = fixture({ role: 'EMPLOYEE', rules: [ORDERS], assigned: ['branch-a'] });
    await path.run(caller, 'branch-a');
    expect(path.command()).toHaveBeenCalledOnce();
    expect(annotateAudit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          reason: 'tenant-admin-orders-access-without-branch-assignment',
        }),
      })
    );
  });

  it.each(staffPaths)('$name admits a tenant admin at any branch and audits it', async (path) => {
    const { caller } = fixture({ role: 'ADMIN', rules: [ORDERS], assigned: [] });
    await path.run(caller, 'branch-a');
    expect(path.command()).toHaveBeenCalledOnce();
    expect(annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'PharmacyBranch',
        targetId: 'branch-a',
        metadata: expect.objectContaining({
          reason: 'tenant-admin-orders-access-without-branch-assignment',
        }),
      })
    );
  });

  it.each(staffPaths)('$name admits the system owner at any branch', async (path) => {
    const { caller } = fixture({
      role: 'EMPLOYEE',
      rules: [{ capability: '*', effect: 'ALLOW' }],
      systemRole: { key: 'owner', isSystem: true },
      assigned: [],
    });
    await path.run(caller, 'branch-a');
    expect(path.command()).toHaveBeenCalledOnce();
  });

  it('admits a solo owner assigned to the branch on the assignment alone', async () => {
    const { caller, db } = fixture({
      role: 'ADMIN',
      rules: [{ capability: '*', effect: 'ALLOW' }],
      systemRole: { key: 'owner', isSystem: true },
      assigned: ['branch-a'],
    });
    await caller.staffQueue({ branchId: 'branch-a' });
    expect(listStaffCustomerOrders).toHaveBeenCalledOnce();
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(annotateAudit).not.toHaveBeenCalled();
  });

  it('refuses an owner-operator template holder outside the branch', async () => {
    const { caller } = fixture({
      role: 'EMPLOYEE',
      rules: [{ capability: 'pharmacy:*', effect: 'ALLOW' }],
      systemRole: { key: 'owner-operator', isSystem: true },
      assigned: ['branch-b'],
    });
    await expect(caller.staffQueue({ branchId: 'branch-a' })).rejects.toMatchObject(OUTSIDE);
    expect(listStaffCustomerOrders).not.toHaveBeenCalled();
  });
});

const ORDER_LINE = {
  medicineId: 'medicine-1',
  presentationId: 'presentation-1',
  packLevelId: 'pack-1',
  saleUnit: 'PACK' as const,
  quantity: 1,
};
const placeFor = (caller: Caller, customerId?: string) =>
  caller.place({
    branchId: 'branch-a',
    ...(customerId ? { customerId } : {}),
    fulfillment: 'COLLECT',
    intendedPaymentMethod: 'CASH',
    lines: [ORDER_LINE],
  });

describe('DEV-845 pharmacyOrdering.place on behalf of a customer', () => {
  it('refuses a staff member ordering for a customer at a branch they are not assigned to', async () => {
    const { caller } = fixture({ role: 'EMPLOYEE', rules: [ORDERS], assigned: ['branch-b'] });
    await expect(placeFor(caller, 'customer-1')).rejects.toMatchObject(OUTSIDE);
    expect(placeCustomerOrder).not.toHaveBeenCalled();
  });

  it('admits a staff member ordering for a customer at their assigned branch', async () => {
    const { caller } = fixture({ role: 'EMPLOYEE', rules: [ORDERS], assigned: ['branch-a'] });
    await expect(placeFor(caller, 'customer-1')).resolves.toEqual({ id: 'order-1' });
    expect(placeCustomerOrder).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' },
      expect.objectContaining({ customerId: 'customer-1', staff: true })
    );
  });

  it('keeps a customer ordering for themselves free of the staff boundary', async () => {
    const { caller, db } = fixture({ role: 'EMPLOYEE', rules: [], assigned: [] });
    await expect(placeFor(caller)).resolves.toEqual({ id: 'order-1' });
    expect(placeCustomerOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ branchId: 'branch-a' }),
      expect.objectContaining({ staff: false })
    );
    expect(db.pharmacyBranchAssignment.findFirst).not.toHaveBeenCalled();
  });
});

describe('DEV-845 tenant-wide access yields to an explicit DENY', () => {
  it.each([
    {
      label: 'a user override',
      overrides: [{ capability: 'reports:financial', effect: 'DENY' as const }],
      rules: [ORDERS],
    },
    {
      label: 'a role rule',
      overrides: [],
      rules: [ORDERS, { capability: 'pharmacy:refund', effect: 'DENY' as const }],
    },
  ])('refuses an unassigned tenant admin with a DENY on $label', async ({ overrides, rules }) => {
    const { caller } = fixture({ role: 'ADMIN', rules, overrides, assigned: [] });
    await expect(caller.staffQueue({ branchId: 'branch-a' })).rejects.toMatchObject(OUTSIDE);
    expect(listStaffCustomerOrders).not.toHaveBeenCalled();
    expect(annotateAudit).not.toHaveBeenCalled();
  });

  it('still admits a tenant admin with a DENY at a branch they are assigned to', async () => {
    const { caller } = fixture({
      role: 'ADMIN',
      rules: [ORDERS],
      overrides: [{ capability: 'reports:financial', effect: 'DENY' }],
      assigned: ['branch-a'],
    });
    await caller.staffQueue({ branchId: 'branch-a' });
    expect(listStaffCustomerOrders).toHaveBeenCalledOnce();
  });
});

describe('DEV-845 runners and customers are scoped to assigned branches', () => {
  it('returns nothing to an orders member with no active assignment', async () => {
    const { caller, db } = fixture({ role: 'EMPLOYEE', rules: [ORDERS], assigned: [] });
    await expect(caller.runners()).resolves.toEqual([]);
    await expect(caller.customers()).resolves.toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.pharmacyCustomer.findMany).not.toHaveBeenCalled();
  });

  it('limits an assigned member to runners and customers of their branches', async () => {
    const { caller, db } = fixture({ role: 'EMPLOYEE', rules: [ORDERS], assigned: ['branch-a'] });
    await caller.runners();
    await caller.customers();
    const atBranch = { some: { organizationId: 'org-a', branchId: { in: ['branch-a'] } } };
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          pharmacyBranchAssignments: {
            some: { organizationId: 'org-a', active: true, branchId: { in: ['branch-a'] } },
          },
        }),
      })
    );
    expect(db.pharmacyCustomer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          active: true,
          OR: [{ orders: atBranch }, { sales: atBranch }, { refillSubscriptions: atBranch }],
        },
      })
    );
  });

  it.each([
    { label: 'a tenant admin', role: 'ADMIN' as const, rules: [ORDERS] },
    {
      label: 'the system owner',
      role: 'EMPLOYEE' as const,
      rules: [{ capability: '*', effect: 'ALLOW' as const }],
      systemRole: { key: 'owner', isSystem: true },
    },
  ])('gives $label the whole organization', async ({ role, rules, systemRole }) => {
    const { caller, db } = fixture({ role, rules, systemRole, assigned: [] });
    await caller.runners();
    await caller.customers();
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', organizationRoleId: { not: null }, status: 'ACTIVE' },
      })
    );
    expect(db.pharmacyCustomer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a', active: true } })
    );
  });

  it('scopes a tenant admin with an explicit DENY to their assigned branches', async () => {
    const { caller, db } = fixture({
      role: 'ADMIN',
      rules: [ORDERS],
      overrides: [{ capability: 'reports:financial', effect: 'DENY' }],
      assigned: [],
    });
    await expect(caller.customers()).resolves.toEqual([]);
    expect(db.pharmacyCustomer.findMany).not.toHaveBeenCalled();
  });
});

// DEV-845: the DEV-15 customer-portal staff procedures take the same boundary.
const PORTAL_STAFF: Rule[] = [
  ORDERS,
  { capability: 'pharmacy:counter', effect: 'ALLOW' },
  { capability: 'pharmacy:dispense', effect: 'ALLOW' },
];
const portalPaths: StaffPath[] = [
  {
    name: 'portalLink',
    run: (caller, branchId) => caller.portalLink({ branchId, customerId: 'customer-1' }),
    command: () => mintPortalLink,
  },
  {
    name: 'portalQueue',
    run: (caller, branchId) => caller.portalQueue({ branchId }),
    command: () => listPortalQueue,
  },
  {
    name: 'portalDecide',
    run: (caller, branchId) =>
      caller.portalDecide({ branchId, requestId: 'request-1', decision: 'VERIFY' }),
    command: () => decidePortalRequest,
  },
  {
    name: 'portalConfirmPayment',
    run: (caller, branchId) => caller.portalConfirmPayment({ branchId, requestId: 'request-1' }),
    command: () => confirmPortalKhataPayment,
  },
];

describe('DEV-845 pharmacyOrdering portal staff procedures: branch assignment', () => {
  it.each(portalPaths)('$name refuses a staff member not assigned to the branch', async (path) => {
    const { caller } = fixture({ role: 'EMPLOYEE', rules: PORTAL_STAFF, assigned: ['branch-b'] });
    await expect(path.run(caller, 'branch-a')).rejects.toMatchObject(OUTSIDE);
    expect(path.command()).not.toHaveBeenCalled();
  });

  it.each(portalPaths)('$name admits a staff member assigned to the branch', async (path) => {
    const { caller } = fixture({ role: 'EMPLOYEE', rules: PORTAL_STAFF, assigned: ['branch-a'] });
    await path.run(caller, 'branch-a');
    expect(path.command()).toHaveBeenCalledOnce();
  });

  it.each(portalPaths)('$name admits a tenant admin at any branch and audits it', async (path) => {
    const { caller } = fixture({ role: 'ADMIN', rules: PORTAL_STAFF, assigned: [] });
    await path.run(caller, 'branch-a');
    expect(path.command()).toHaveBeenCalledOnce();
    expect(annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetId: 'branch-a',
        metadata: expect.objectContaining({
          reason: 'tenant-admin-orders-access-without-branch-assignment',
        }),
      })
    );
  });

  it.each(portalPaths)('$name admits the system owner at any branch', async (path) => {
    const { caller } = fixture({
      role: 'EMPLOYEE',
      rules: [{ capability: '*', effect: 'ALLOW' }],
      systemRole: { key: 'owner', isSystem: true },
      assigned: [],
    });
    await path.run(caller, 'branch-a');
    expect(path.command()).toHaveBeenCalledOnce();
  });

  it.each(portalPaths)(
    '$name refuses an unassigned tenant admin with an explicit DENY',
    async (path) => {
      const { caller } = fixture({
        role: 'ADMIN',
        rules: PORTAL_STAFF,
        overrides: [{ capability: 'reports:financial', effect: 'DENY' }],
        assigned: [],
      });
      await expect(path.run(caller, 'branch-a')).rejects.toMatchObject(OUTSIDE);
      expect(path.command()).not.toHaveBeenCalled();
    }
  );
});
