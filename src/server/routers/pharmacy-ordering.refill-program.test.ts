import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-73: the refill program screen's procedures. Every one needs `pharmacy:orders`
// and the branch; reading a cycle's prescriptions also needs the dispensing grant.
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
vi.mock('@/lib/pharmacy/refill-subscriptions', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/refill-subscriptions')>()),
  listRefillProgram: vi.fn(async () => []),
  listSubscribableItems: vi.fn(async () => []),
  listRefillCyclePrescriptionCandidates: vi.fn(async () => []),
  listRefillCyclePharmacists: vi.fn(async () => []),
  createRefillSubscription: vi.fn(async () => ({ id: 'subscription-1' })),
  setRefillSubscriptionPaused: vi.fn(async () => ({ id: 'subscription-1' })),
  cancelRefillSubscription: vi.fn(async () => ({ id: 'subscription-1' })),
  verifyRefillCyclePharmacistPin: vi.fn(async () => null),
  approveRefillCycle: vi.fn(async () => ({ id: 'cycle-1' })),
}));

import {
  approveRefillCycle,
  cancelRefillSubscription,
  createRefillSubscription,
  listRefillCyclePharmacists,
  listRefillCyclePrescriptionCandidates,
  listRefillProgram,
  listSubscribableItems,
  setRefillSubscriptionPaused,
  verifyRefillCyclePharmacistPin,
} from '@/lib/pharmacy/refill-subscriptions';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { router, type TRPCContext } from '../trpc';
import { pharmacyOrderingRouter } from './pharmacy-ordering';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const app = router({ pharmacyOrdering: pharmacyOrderingRouter });
const ORDERS: Rule = { capability: 'pharmacy:orders', effect: 'ALLOW' };
const DISPENSE: Rule = { capability: 'pharmacy:dispense', effect: 'ALLOW' };

function fixture(rules: Rule[]) {
  const stored = {
    id: 'user-a',
    organizationId: 'org-a',
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    organizationRole: { permissions: rules },
    permissionOverrides: [],
  };
  const db = {
    user: {
      findUnique: vi.fn(async () => stored),
      findFirst: vi.fn(async () => stored),
      findMany: vi.fn(async () => []),
    },
    pharmacyBranch: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => ({ id }))
      ),
    },
    pharmacyBranchAssignment: {
      findFirst: vi.fn(async () => ({ id: 'assignment-a' })),
      findMany: vi.fn(async () => [{ branchId: 'branch-a' }]),
    },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  vi.mocked(withTenantDb).mockImplementation(async (_organizationId, run) =>
    (run as (tx: unknown) => Promise<unknown>)(db)
  );
  return app.createCaller({
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user-a', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-a' },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacyOrdering;
}

type Caller = ReturnType<typeof fixture>;
const branchId = 'branch-a';

const paths: Array<{ name: string; run: (caller: Caller) => Promise<unknown>; command: unknown }> =
  [
    {
      name: 'refillProgram',
      run: (caller) => caller.refillProgram({ branchId }),
      command: listRefillProgram,
    },
    {
      name: 'subscriptionCatalog',
      run: (caller) => caller.subscriptionCatalog({ branchId, search: 'met' }),
      command: listSubscribableItems,
    },
    {
      name: 'subscriptionCycleApprovers',
      run: (caller) => caller.subscriptionCycleApprovers({ branchId }),
      command: listRefillCyclePharmacists,
    },
    {
      name: 'subscriptionCyclePrescriptions',
      run: (caller) => caller.subscriptionCyclePrescriptions({ branchId, cycleId: 'cycle-1' }),
      command: listRefillCyclePrescriptionCandidates,
    },
    {
      name: 'createSubscription',
      run: (caller) =>
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
      command: createRefillSubscription,
    },
    {
      name: 'setSubscriptionStatus (pause)',
      run: (caller) =>
        caller.setSubscriptionStatus({
          branchId,
          subscriptionId: 'subscription-1',
          action: 'pause',
        }),
      command: setRefillSubscriptionPaused,
    },
    {
      name: 'setSubscriptionStatus (cancel)',
      run: (caller) =>
        caller.setSubscriptionStatus({
          branchId,
          subscriptionId: 'subscription-1',
          action: 'cancel',
        }),
      command: cancelRefillSubscription,
    },
  ];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DEV-73 refill program screen: permissions', () => {
  it.each(paths)('$name refuses a user without the customer orders right', async (path) => {
    const caller = fixture([{ capability: 'pharmacy:counter', effect: 'ALLOW' }]);
    await expect(path.run(caller)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(path.command).not.toHaveBeenCalled();
  });

  it.each(paths.filter((path) => path.name !== 'subscriptionCyclePrescriptions'))(
    '$name admits an orders member assigned to the branch',
    async (path) => {
      const caller = fixture([ORDERS]);
      await path.run(caller);
      expect(path.command).toHaveBeenCalledOnce();
    }
  );

  it("refuses an orders member without the dispensing grant a cycle's prescriptions", async () => {
    const caller = fixture([ORDERS]);
    await expect(
      caller.subscriptionCyclePrescriptions({ branchId, cycleId: 'cycle-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(listRefillCyclePrescriptionCandidates).not.toHaveBeenCalled();
  });

  it("shows a pharmacist the cycle's candidate prescriptions", async () => {
    const caller = fixture([ORDERS, DISPENSE]);
    await caller.subscriptionCyclePrescriptions({ branchId, cycleId: 'cycle-1' });
    expect(listRefillCyclePrescriptionCandidates).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-a', branchId, actorId: 'user-a' },
      'cycle-1'
    );
  });

  it('refuses a sign-off whose PIN does not verify a pharmacist, before any approval', async () => {
    const caller = fixture([ORDERS]);
    await expect(
      caller.approveSubscriptionCycle({
        branchId,
        cycleId: 'cycle-1',
        pharmacistPin: { staffProfileId: 'staff-1', pin: '7391' },
        prescriptionLineId: 'rx-line-1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(verifyRefillCyclePharmacistPin).toHaveBeenCalledOnce();
    expect(approveRefillCycle).not.toHaveBeenCalled();
  });

  it('refuses a sign-off that names no prescription, with no emergency exception', async () => {
    const caller = fixture([ORDERS, DISPENSE]);
    await expect(
      caller.approveSubscriptionCycle({
        branchId,
        cycleId: 'cycle-1',
        pharmacistPin: { staffProfileId: 'staff-1', pin: '7391' },
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(verifyRefillCyclePharmacistPin).not.toHaveBeenCalled();
    expect(approveRefillCycle).not.toHaveBeenCalled();
  });
});
