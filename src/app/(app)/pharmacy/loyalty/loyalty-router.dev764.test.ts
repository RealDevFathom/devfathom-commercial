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
  adjust: vi.fn(),
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
vi.mock('@/lib/pharmacy/customer-loyalty', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/customer-loyalty')>(
    '@/lib/pharmacy/customer-loyalty'
  )),
  adjustLoyaltyPoints: mocks.adjust,
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

const prior = {
  id: 'program-1',
  version: 1,
  earnMode: 'PERCENT_OF_SPEND',
  earnPoints: 100,
  perSpendMinor: 1_000_000,
  redemptionValueMinor: 100,
  expiryDays: 365,
  khataEarns: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.licensed.mockReturnValue(true);
  mocks.findFirst.mockResolvedValue(prior);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.create.mockImplementation(async ({ data }) => ({ id: 'program-2', ...data }));
});

describe('DEV-764 owner program settings', () => {
  it('saves redemption value, expiry and the khata switch as the next dated version', async () => {
    await caller().setEarnRate({
      option: 'percent-2',
      pointValue: '2.50',
      expiryDays: 90,
      khataEarns: true,
    });
    // 2% of spend at PKR 2.50 a point: 200 points per PKR 25,000.
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-a',
        version: 2,
        earnMode: 'PERCENT_OF_SPEND',
        earnPoints: 200,
        perSpendMinor: 2_500_000,
        redemptionValueMinor: 250,
        expiryDays: 90,
        khataEarns: true,
        actorId: 'user-a',
      },
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        changes: {
          earnRule: {
            before: expect.objectContaining({
              redemptionValueMinor: 100,
              expiryDays: 365,
              khataEarns: false,
            }),
            after: expect.objectContaining({
              redemptionValueMinor: 250,
              expiryDays: 90,
              khataEarns: true,
            }),
          },
        },
      })
    );
  });

  it('carries forward settings not sent, from the version read under the lock', async () => {
    await caller().setEarnRate({ option: 'step-1000' });
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        earnMode: 'POINTS_PER_SPEND_STEP',
        redemptionValueMinor: 100,
        expiryDays: 365,
        khataEarns: false,
      }),
    });
    expect(mocks.findFirst.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.queryRaw.mock.invocationCallOrder[0]!
    );
  });

  it('lets the owner switch expiry off again', async () => {
    await caller().setEarnRate({ option: 'step-1000', expiryDays: null });
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ expiryDays: null }),
    });
  });

  it.each([
    { option: 'percent-1', pointValue: '0' },
    { option: 'percent-1', pointValue: '1000.01' },
    // 1 point per PKR 1 is 100% back at PKR 1 a point, but 200% when a point is worth PKR 2.
    { option: 'custom-step', stepPoints: 1, stepRupees: 1, pointValue: '2' },
    { option: 'percent-1', expiryDays: 0 },
    { option: 'percent-1', expiryDays: 3651 },
  ])('refuses %j on the server before writing', async (input) => {
    await expect(caller().setEarnRate(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('DEV-764 manual adjustment authority', () => {
  const input = {
    branchId: 'branch-a',
    customerId: 'customer-a',
    points: -5,
    reason: 'Duplicate earn on receipt 7',
    idempotencyKey: 'adjust-key-1',
  };
  beforeEach(() => {
    mocks.adjust.mockResolvedValue({
      entry: { id: 'entry-a', points: -5, reason: 'Duplicate earn on receipt 7' },
      balanceBefore: 12,
      balanceAfter: 7,
      replayed: false,
    });
  });

  it('lets the owner adjust, and audits the change with its reason', async () => {
    await expect(caller('ADMIN').adjustPoints(input)).resolves.toEqual({
      entryId: 'entry-a',
      points: -5,
      balanceAfter: 7,
      replayed: false,
    });
    expect(mocks.managerGate).not.toHaveBeenCalled();
    expect(mocks.adjust).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-a', actorId: 'user-a', branchId: 'branch-a' },
      {
        customerId: 'customer-a',
        points: -5,
        reason: 'Duplicate earn on receipt 7',
        idempotencyKey: 'adjust-key-1',
      }
    );
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacyLoyalty.adjustPoints',
        targetId: 'entry-a',
        changes: { pointsBalance: { before: 12, after: 7 } },
        metadata: expect.objectContaining({
          reason: 'Duplicate earn on receipt 7',
          authority: 'OWNER',
          points: -5,
        }),
      })
    );
  });

  it('lets a manager of the branch adjust through the manager gate', async () => {
    mocks.managerGate.mockResolvedValue({
      organizationId: 'org-a',
      branchId: 'branch-a',
      actorId: 'user-a',
    });
    await caller('MEMBER').adjustPoints(input);
    expect(mocks.managerGate).toHaveBeenCalledWith(expect.anything(), 'branch-a');
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ metadata: expect.objectContaining({ authority: 'MANAGER' }) })
    );
  });

  it('refuses a cashier before any write', async () => {
    mocks.managerGate.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(caller('MEMBER').adjustPoints(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.adjust).not.toHaveBeenCalled();
  });

  it('refuses without the CRM package, and refuses a zero or unexplained adjustment', async () => {
    mocks.licensed.mockReturnValue(false);
    await expect(caller('ADMIN').adjustPoints(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.licensed.mockReturnValue(true);
    await expect(caller('ADMIN').adjustPoints({ ...input, points: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller('ADMIN').adjustPoints({ ...input, reason: 'no' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.adjust).not.toHaveBeenCalled();
  });

  it('says plainly when a removal would take the balance below zero', async () => {
    mocks.adjust.mockRejectedValue(new PharmacyLoyaltyError('ADJUSTMENT_EXCEEDS_BALANCE'));
    await expect(caller('ADMIN').adjustPoints(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'A removal cannot take the balance below zero.',
    });
    expect(mocks.annotateAudit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'pharmacyLoyalty.adjustPoints' })
    );
  });
});

describe('DEV-764 manager adjustment ceiling', () => {
  const input = {
    branchId: 'branch-a',
    customerId: 'customer-a',
    points: 600,
    reason: 'Points missed on several receipts',
    idempotencyKey: 'adjust-key-2',
  };
  beforeEach(() => {
    mocks.adjust.mockResolvedValue({
      entry: { id: 'entry-b', points: 600, reason: input.reason },
      balanceBefore: 0,
      balanceAfter: 600,
      replayed: false,
    });
    mocks.managerGate.mockResolvedValue({
      organizationId: 'org-a',
      branchId: 'branch-a',
      actorId: 'user-a',
    });
  });

  it('refuses a manager above the default ceiling of 500 points, before any write', async () => {
    await expect(caller('MEMBER').adjustPoints(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Adjustments above 500 points need the owner.',
    });
    await expect(caller('MEMBER').adjustPoints({ ...input, points: -501 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.adjust).not.toHaveBeenCalled();
  });

  it('lets a manager adjust up to the ceiling the owner set', async () => {
    mocks.findFirst.mockResolvedValue({ ...prior, managerAdjustLimitPoints: 1_000 });
    await expect(caller('MEMBER').adjustPoints(input)).resolves.toMatchObject({ points: 600 });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ authority: 'MANAGER', managerLimit: 1_000 }),
      })
    );
    mocks.findFirst.mockResolvedValue({ ...prior, managerAdjustLimitPoints: 0 });
    await expect(
      caller('MEMBER').adjustPoints({ ...input, points: 1, idempotencyKey: 'adjust-key-3' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets the owner adjust above the ceiling, and audits it', async () => {
    await expect(caller('ADMIN').adjustPoints(input)).resolves.toMatchObject({ points: 600 });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ authority: 'OWNER', managerLimit: 500 }),
      })
    );
  });

  it('saves the ceiling as part of the dated program version and carries it forward', async () => {
    await caller().setEarnRate({ option: 'percent-1', managerAdjustLimitPoints: 2_000 });
    expect(mocks.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ managerAdjustLimitPoints: 2_000 }),
    });
    mocks.findFirst.mockResolvedValue({ ...prior, managerAdjustLimitPoints: 2_000 });
    await caller().setEarnRate({ option: 'percent-2' });
    expect(mocks.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ managerAdjustLimitPoints: 2_000 }),
    });
    await expect(
      caller().setEarnRate({ option: 'percent-1', managerAdjustLimitPoints: 1_000_001 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('DEV-764 adjustment reads the ceiling under the program lock', () => {
  it('takes the shared program lock in the transaction before reading the ceiling and adjusting', async () => {
    mocks.adjust.mockResolvedValue({
      entry: { id: 'entry-c', points: 5, reason: 'Points missed on receipt 9' },
      balanceBefore: 0,
      balanceAfter: 5,
      replayed: false,
    });
    await caller('ADMIN').adjustPoints({
      branchId: 'branch-a',
      customerId: 'customer-a',
      points: 5,
      reason: 'Points missed on receipt 9',
      idempotencyKey: 'adjust-key-lock',
    });
    const lockIndex = mocks.queryRaw.mock.calls.findIndex((call) =>
      (call[0] as { strings: string[] }).strings.join('').includes('pg_advisory_xact_lock_shared')
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    const lockAt = mocks.queryRaw.mock.invocationCallOrder[lockIndex]!;
    expect(lockAt).toBeLessThan(mocks.findFirst.mock.invocationCallOrder[0]!);
    expect(lockAt).toBeLessThan(mocks.adjust.mock.invocationCallOrder[0]!);
  });
});
