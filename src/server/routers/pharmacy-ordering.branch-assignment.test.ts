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
  transitionCustomerOrder: vi.fn(async () => ({ id: 'order-1' })),
  startCustomerOrderCheckout: vi.fn(async () => ({ id: 'order-1' })),
  completeCustomerOrder: vi.fn(async () => ({ id: 'order-1' })),
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
  assigned: string[];
};

function fixture(member: Member) {
  const stored = {
    id: 'user-a',
    organizationId: 'org-a',
    role: member.role,
    status: 'ACTIVE',
    organizationRole: { ...(member.systemRole ?? {}), permissions: member.rules },
    permissionOverrides: [],
  };
  const db = {
    user: {
      findUnique: vi.fn(async () => stored),
      findFirst: vi.fn(async (args: { where: { id: string; organizationId: string } }) =>
        args.where.id === stored.id && args.where.organizationId === stored.organizationId
          ? stored
          : null
      ),
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
