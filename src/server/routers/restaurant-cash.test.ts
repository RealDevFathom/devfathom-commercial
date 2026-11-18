/**
 * M5-L3 router — capability gating/wiring, strict inputs, the C12 cash read model
 * (drawer sessions + movement ledgers, daily closes + correction chains) and
 * money-as-string serialization. Runs the REAL router against a hand-rolled
 * in-memory db; the ABAC decision, entitlement check and audit writer are mocked
 * (platform middleware). The pure `foldExpectedCash`/`resolveChainTip` helpers run
 * for real, so the derived expected cash and tip flags are exercised end to end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import { Prisma } from '@/generated/prisma/client';

const D = (v: string) => new Prisma.Decimal(v);

const mocks = vi.hoisted(() => ({
  can: vi.fn<(subject: unknown, action: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
  drawerFindMany: vi.fn(),
  drawerFindUnique: vi.fn(),
  closeFindMany: vi.fn(),
  closeFindUnique: vi.fn(),
  requireBranchScope: vi.fn<(ctx: unknown, branchId: string) => Promise<void>>(
    async () => undefined
  ),
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
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/restaurant-branch-scope', () => ({
  requireRestaurantBranchScope: mocks.requireBranchScope,
}));

import { restaurantCashRouter } from './restaurant-cash';
import type { TRPCContext } from '../trpc';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const db = {
  restaurantDrawerSession: { findMany: mocks.drawerFindMany, findUnique: mocks.drawerFindUnique },
  restaurantDailyClose: { findMany: mocks.closeFindMany, findUnique: mocks.closeFindUnique },
} as unknown as ScopedDb;

function caller() {
  return restaurantCashRouter.createCaller({
    db,
    entitlements: {
      enabledModules: ['restaurant-pos'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'user_gm', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.drawerFindMany.mockResolvedValue([]);
  mocks.closeFindMany.mockResolvedValue([]);
});

describe('drawer session reads (C12)', () => {
  it('lists sessions with string-serialized money, movement count and a cursor', async () => {
    const row = (id: string) => ({
      id,
      branchId: 'b1',
      deviceId: 'dev_1',
      staffProfileId: 'op_1',
      businessDate: new Date('2026-08-19T00:00:00.000Z'),
      status: 'CLOSED',
      openedAt: new Date(),
      closedAt: new Date(),
      openingFloat: D('100.00'),
      expectedCash: D('130.00'),
      countedCash: D('129.50'),
      variance: D('-0.50'),
      _count: { movements: 4 },
    });
    mocks.drawerFindMany.mockResolvedValue([row('s1'), row('s2'), row('s3')]);
    const result = await caller().listDrawerSessions({ branchId: 'b1', limit: 2 });
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].openingFloat).toBe('100.00');
    expect(result.sessions[0].variance).toBe('-0.50');
    expect(typeof result.sessions[0].expectedCash).toBe('string');
    expect(result.sessions[0].businessDate).toBe('2026-08-19');
    expect(result.sessions[0].movementCount).toBe(4);
    expect(result.nextCursor).toBe('s2');
  });

  it('leaves an open session expected/counted null in the list', async () => {
    mocks.drawerFindMany.mockResolvedValue([
      {
        id: 's1',
        branchId: 'b1',
        deviceId: 'dev_1',
        staffProfileId: 'op_1',
        businessDate: new Date('2026-08-19T00:00:00.000Z'),
        status: 'OPEN',
        openedAt: new Date(),
        closedAt: null,
        openingFloat: D('50.00'),
        expectedCash: null,
        countedCash: null,
        variance: null,
        _count: { movements: 1 },
      },
    ]);
    const result = await caller().listDrawerSessions({ branchId: 'b1' });
    expect(result.sessions[0].expectedCash).toBeNull();
    expect(result.sessions[0].countedCash).toBeNull();
    expect(result.nextCursor).toBeNull();
  });

  it('derives expected cash from the movement ledger and computes variance', async () => {
    mocks.drawerFindUnique.mockResolvedValue({
      id: 's1',
      branchId: 'b1',
      deviceId: 'dev_1',
      staffProfileId: 'op_1',
      businessDate: new Date('2026-08-19T00:00:00.000Z'),
      status: 'CLOSED',
      openedAt: new Date(),
      closedAt: new Date(),
      openingFloat: D('100.00'),
      countedCash: D('110.00'),
      movements: [
        {
          id: 'm1',
          kind: 'OPENING_FLOAT',
          amount: D('100.00'),
          reason: null,
          tenderId: null,
          refundId: null,
          staffProfileId: 'op_1',
          deviceId: 'dev_1',
          createdAt: new Date(),
        },
        {
          id: 'm2',
          kind: 'CASH_SALE',
          amount: D('30.00'),
          reason: null,
          tenderId: 't1',
          refundId: null,
          staffProfileId: 'op_1',
          deviceId: 'dev_1',
          createdAt: new Date(),
        },
        {
          id: 'm3',
          kind: 'CASH_REFUND',
          amount: D('5.00'),
          reason: null,
          tenderId: null,
          refundId: 'r1',
          staffProfileId: 'op_1',
          deviceId: 'dev_1',
          createdAt: new Date(),
        },
        {
          id: 'm4',
          kind: 'PAID_IN',
          amount: D('10.00'),
          reason: 'float top-up',
          tenderId: null,
          refundId: null,
          staffProfileId: 'op_1',
          deviceId: 'dev_1',
          createdAt: new Date(),
        },
        {
          id: 'm5',
          kind: 'PAID_OUT',
          amount: D('4.00'),
          reason: 'supplies',
          tenderId: null,
          refundId: null,
          staffProfileId: 'op_1',
          deviceId: 'dev_1',
          createdAt: new Date(),
        },
        {
          id: 'm6',
          kind: 'DROP',
          amount: D('20.00'),
          reason: 'safe drop',
          tenderId: null,
          refundId: null,
          staffProfileId: 'op_1',
          deviceId: 'dev_1',
          createdAt: new Date(),
        },
        {
          id: 'm7',
          kind: 'CLOSING_COUNT',
          amount: D('110.00'),
          reason: null,
          tenderId: null,
          refundId: null,
          staffProfileId: 'op_1',
          deviceId: 'dev_1',
          createdAt: new Date(),
        },
      ],
    });
    const result = await caller().getDrawerSession({ drawerSessionId: 's1' });
    // 100 + 30 - 5 + 10 - 4 - 20 = 111 (CLOSING_COUNT excluded from the fold)
    expect(result.expectedCash).toBe('111.00');
    expect(result.countedCash).toBe('110.00');
    expect(result.variance).toBe('-1.00');
    expect(result.movements).toHaveLength(7);
    expect(result.movements[1].amount).toBe('30.00');
    expect(mocks.requireBranchScope).toHaveBeenCalledWith(expect.anything(), 'b1');
  });

  it('throws NOT_FOUND for a missing drawer session', async () => {
    mocks.drawerFindUnique.mockResolvedValue(null);
    await expect(caller().getDrawerSession({ drawerSessionId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('daily close reads (C12)', () => {
  it('groups closes into per-date correction chains and flags the tip', async () => {
    mocks.closeFindMany.mockResolvedValue([
      {
        id: 'c1',
        businessDate: new Date('2026-08-19T00:00:00.000Z'),
        supersedesCloseId: null,
        correctionReason: null,
        createdAt: new Date('2026-08-19T20:00:00Z'),
        grossSales: D('500.00'),
        netSales: D('480.00'),
        refundTotal: D('0.00'),
        cashVariance: D('0.00'),
      },
      {
        id: 'c2',
        businessDate: new Date('2026-08-19T00:00:00.000Z'),
        supersedesCloseId: 'c1',
        correctionReason: 'miscount',
        createdAt: new Date('2026-08-19T22:00:00Z'),
        grossSales: D('500.00'),
        netSales: D('480.00'),
        refundTotal: D('12.00'),
        cashVariance: D('-1.00'),
      },
    ]);
    const result = await caller().listDailyCloses({ branchId: 'b1' });
    expect(result.chains).toHaveLength(1);
    const chain = result.chains[0];
    expect(chain.businessDate).toBe('2026-08-19');
    expect(chain.tipCloseId).toBe('c2');
    expect(chain.closes.find((c) => c.id === 'c1')!.isTip).toBe(false);
    expect(chain.closes.find((c) => c.id === 'c2')!.isTip).toBe(true);
    expect(chain.closes[1].refundTotal).toBe('12.00');
  });

  const manualCardFixture = (() => {
    const row = {
      count: 2,
      amount: '41.00',
      tipAmount: '0.00',
      refundCount: 0,
      refundAmount: '0.00',
      tipRefundAmount: '0.00',
      netAmount: '41.00',
      netTipAmount: '0.00',
    };
    return { ...row, cashiers: [{ ...row, staffProfileId: 'st1', displayName: 'Amina' }] };
  })();

  it('serializes every close total as a string with tender totals and drawer variances', async () => {
    mocks.closeFindUnique.mockResolvedValue({
      id: 'c1',
      branchId: 'b1',
      businessDate: new Date('2026-08-19T00:00:00.000Z'),
      supersedesCloseId: null,
      correctionReason: null,
      coAuthorizationId: null,
      cutByStaffProfileId: 'mgr_1',
      deviceId: 'dev_1',
      createdAt: new Date(),
      grossSales: D('500.00'),
      netSales: D('480.00'),
      taxTotal: D('0.00'),
      serviceChargeTotal: D('0.00'),
      tipTotal: D('15.00'),
      compTotal: D('20.00'),
      discountTotal: D('0.00'),
      refundTotal: D('0.00'),
      voidTotal: D('7.50'),
      cashExpected: D('300.00'),
      cashCounted: D('299.00'),
      cashVariance: D('-1.00'),
      manualCardSummary: manualCardFixture,
      tenderTotals: [
        { tenderType: 'CASH', amount: D('200.00'), tipAmount: D('5.00'), count: 3 },
        { tenderType: 'CARD', amount: D('280.00'), tipAmount: D('10.00'), count: 4 },
      ],
    });
    mocks.closeFindMany.mockResolvedValue([
      {
        id: 'c1',
        supersedesCloseId: null,
        correctionReason: null,
        cutByStaffProfileId: 'mgr_1',
        createdAt: new Date(),
      },
    ]);
    mocks.drawerFindMany.mockResolvedValue([
      {
        id: 's1',
        deviceId: 'dev_1',
        staffProfileId: 'op_1',
        status: 'CLOSED',
        openingFloat: D('100.00'),
        expectedCash: D('300.00'),
        countedCash: D('299.00'),
        variance: D('-1.00'),
      },
    ]);
    const result = await caller().getDailyClose({ dailyCloseId: 'c1' });
    expect(result.close.totals.grossSales).toBe('500.00');
    expect(result.close.totals.tipTotal).toBe('15.00');
    expect(result.close.totals.compTotal).toBe('20.00');
    expect(result.close.totals.voidTotal).toBe('7.50');
    expect(result.close.totals.cashVariance).toBe('-1.00');
    expect(result.close.isTip).toBe(true);
    expect(result.manualCardSummary).toEqual(manualCardFixture);
    expect(result.tenderTotals).toHaveLength(2);
    expect(result.tenderTotals[0]).toMatchObject({
      tenderType: 'CASH',
      amount: '200.00',
      count: 3,
    });
    expect(result.drawerVariances[0]).toMatchObject({ drawerSessionId: 's1', variance: '-1.00' });
    expect(result.chain[0].isTip).toBe(true);
    expect(mocks.requireBranchScope).toHaveBeenCalledWith(expect.anything(), 'b1');
  });

  it('throws NOT_FOUND for a missing daily close', async () => {
    mocks.closeFindUnique.mockResolvedValue(null);
    await expect(caller().getDailyClose({ dailyCloseId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('capability gating + strict inputs', () => {
  it('guards every list by its exact branch', async () => {
    await caller().listDrawerSessions({ branchId: 'b1' });
    await caller().listDailyCloses({ branchId: 'b2' });
    expect(mocks.can.mock.calls.some((c) => c[1] === 'money:read')).toBe(true);
    expect(mocks.requireBranchScope.mock.calls.map((call) => call[1])).toEqual(['b1', 'b2']);
  });

  it('denies direct IDs before fetching drawer or close detail', async () => {
    mocks.requireBranchScope.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    mocks.drawerFindUnique.mockResolvedValue({ branchId: 'blocked' });
    await expect(
      caller().getDrawerSession({ drawerSessionId: 'drawer-blocked' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.drawerFindUnique).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.requireBranchScope.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    mocks.closeFindUnique.mockResolvedValue({ branchId: 'blocked' });
    await expect(caller().getDailyClose({ dailyCloseId: 'close-blocked' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.closeFindUnique).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown input fields (strict)', async () => {
    await expect(
      // @ts-expect-error — surplus field must be rejected, never stripped
      caller().listDrawerSessions({ branchId: 'b1', surplus: true })
    ).rejects.toBeDefined();
  });
});
