/**
 * M5-L2 bill read router — capability gating on `money:read`, strict inputs, the
 * C12 read model (listBills / getBill / getOrderSettlement) and money-as-string
 * serialization. Runs the REAL router against a hand-rolled in-memory db; the ABAC
 * decision, entitlement check and audit writer are mocked, and the settlement
 * predicate is stubbed so router tests assert wiring/serialization, not the command
 * internals (covered by `bills.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import { Prisma } from '@/generated/prisma/client';

const D = (v: string) => new Prisma.Decimal(v);

const mocks = vi.hoisted(() => ({
  can: vi.fn<(subject: unknown, action: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
  annotateAudit: vi.fn(),
  billFindMany: vi.fn(),
  billFindUnique: vi.fn(),
  orderFindUnique: vi.fn(async () => ({ branchId: 'b1' })),
  evaluateOrderSettlement: vi.fn(),
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
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/restaurant/bills', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/restaurant/bills')>('@/lib/restaurant/bills');
  return { ...actual, evaluateOrderSettlement: mocks.evaluateOrderSettlement };
});
vi.mock('@/server/restaurant-branch-scope', () => ({
  requireRestaurantBranchScope: mocks.requireBranchScope,
}));

import { restaurantBillsRouter } from './restaurant-bills';
import type { TRPCContext } from '../trpc';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const db = {
  restaurantBill: { findMany: mocks.billFindMany, findUnique: mocks.billFindUnique },
  restaurantOrder: { findUnique: mocks.orderFindUnique },
} as unknown as ScopedDb;

function caller() {
  return restaurantBillsRouter.createCaller({
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

function billRow(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    orderId: 'o1',
    branchId: 'b1',
    businessDate: new Date('2026-08-19T00:00:00.000Z'),
    status: 'SETTLED',
    splitKind: 'NONE',
    fractionNumerator: null,
    fractionDenominator: null,
    subtotal: D('26.00'),
    taxTotal: D('0'),
    serviceChargeTotal: D('0'),
    compTotal: D('0'),
    roundingAdjustment: D('0'),
    grandTotal: D('26.00'),
    receiptNumber: 5,
    settledAt: new Date('2026-08-19T18:00:00.000Z'),
    createdAt: new Date('2026-08-19T17:00:00.000Z'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.billFindMany.mockResolvedValue([]);
});

describe('read model (C12)', () => {
  it('lists bills with string-serialized money and a pagination cursor', async () => {
    mocks.billFindMany.mockResolvedValue([billRow('a'), billRow('b'), billRow('c')]);
    const result = await caller().listBills({ branchId: 'b1', limit: 2 });
    expect(result.bills).toHaveLength(2);
    expect(result.nextCursor).toBe('b');
    expect(result.bills[0].grandTotal).toBe('26');
    expect(typeof result.bills[0].grandTotal).toBe('string');
    expect(result.bills[0].businessDate).toBe('2026-08-19');
  });

  it('gets a bill with lines, comps, tender + refund summaries and receipt number', async () => {
    mocks.billFindUnique.mockResolvedValue({
      ...billRow('a', {
        subtotal: D('23.00'),
        taxTotal: D('1.00'),
        serviceChargeTotal: D('2.00'),
        compTotal: D('4.00'),
        grandTotal: D('22.00'),
      }),
      openerStaffProfileId: 'staff_1',
      deviceId: 'dev_1',
      voidReason: null,
      voidCoAuthorizationId: null,
      lines: [
        {
          id: 'l1',
          orderItemId: 'i1',
          name: 'Burger',
          quantity: 1,
          unitPrice: D('12.50'),
          lineSubtotal: D('12.50'),
          taxAmount: D('0'),
          serviceChargeAmount: D('0'),
          compAmount: D('0'),
          lineTotal: D('12.50'),
          compReason: null,
          compCoAuthorizationId: null,
        },
        {
          id: 'l2',
          orderItemId: 'i2',
          name: 'Fries',
          quantity: 1,
          unitPrice: D('4.00'),
          lineSubtotal: D('4.00'),
          taxAmount: D('0'),
          serviceChargeAmount: D('0'),
          compAmount: D('4.00'),
          lineTotal: D('0'),
          compReason: 'burnt',
          compCoAuthorizationId: 'coauth_1',
        },
      ],
      tenders: [
        {
          id: 't1',
          type: 'CARD',
          amount: D('20.00'),
          tipAmount: D('3.00'),
          cashReceived: null,
          changeGiven: null,
          paymentId: 'pay_1',
          createdAt: new Date(),
        },
        {
          id: 't2',
          type: 'CASH',
          amount: D('2.00'),
          tipAmount: D('0'),
          cashReceived: D('5.00'),
          changeGiven: D('3.00'),
          paymentId: null,
          createdAt: new Date(),
        },
      ],
      refunds: [
        {
          id: 'r1',
          originalTenderId: 't1',
          amount: D('5.00'),
          tipRefundAmount: D('0'),
          serviceChargeRefundAmount: D('0.75'),
          taxRefundAmount: D('0.50'),
          kind: 'REFUND',
          reason: 'overcharge',
          businessDate: new Date('2026-08-20T00:00:00.000Z'),
          createdAt: new Date(),
        },
      ],
    });

    const bill = await caller().getBill({ billId: 'a' });
    expect(bill).not.toBeNull();
    expect(bill!.lines).toHaveLength(2);
    expect(bill!.lines[1].compAmount).toBe('4');
    expect(bill!.lines[1].lineTotal).toBe('0');
    expect(bill!.lines[1].compReason).toBe('burnt');
    expect(bill!.tenderSummary).toEqual({ count: 2, amount: '22', tipAmount: '3' });
    expect(bill!.refundSummary).toEqual({
      count: 1,
      amount: '5',
      tipRefundAmount: '0',
      serviceChargeRefundAmount: '0.75',
      taxRefundAmount: '0.5',
      netServiceChargeAmount: '1.25',
    });
    expect(bill!.netCollected).toBe('17'); // 22 tendered − 5 refunded
    expect(bill!.receiptNumber).toBe(5);
    expect(bill!.tenders[1].changeGiven).toBe('3');
    expect(mocks.requireBranchScope).toHaveBeenCalledWith(expect.anything(), 'b1');
  });

  it('returns null for a missing bill', async () => {
    mocks.billFindUnique.mockResolvedValue(null);
    expect(await caller().getBill({ billId: 'nope' })).toBeNull();
  });

  it('serializes the per-order settlement state', async () => {
    mocks.evaluateOrderSettlement.mockResolvedValue({
      orderId: 'o1',
      settled: false,
      blocker: 'BILLS_OPEN',
      derivedOrderTotal: D('26.00'),
      accountedTotal: D('26.00'),
      unbilledItemIds: [],
      bills: [
        {
          id: 'a',
          status: 'OPEN',
          splitKind: 'NONE',
          grandTotal: D('26.00'),
          compTotal: D('0'),
          receiptNumber: null,
        },
      ],
    });
    const s = await caller().getOrderSettlement({ orderId: 'o1' });
    expect(s.settled).toBe(false);
    expect(s.blocker).toBe('BILLS_OPEN');
    expect(s.derivedOrderTotal).toBe('26');
    expect(s.accountedTotal).toBe('26');
    expect(s.bills[0].grandTotal).toBe('26');
    expect(mocks.requireBranchScope).toHaveBeenCalledWith(expect.anything(), 'b1');
  });
});

describe('capability gating + strict inputs', () => {
  it('guards every list by its exact branch', async () => {
    await caller().listBills({ branchId: 'b1' });
    expect(mocks.can.mock.calls.some((c) => c[1] === 'money:read')).toBe(true);
    expect(mocks.requireBranchScope.mock.calls.map((call) => call[1])).toEqual(['b1']);
  });

  it('denies direct IDs before fetching bill or settlement detail', async () => {
    mocks.requireBranchScope.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    mocks.billFindUnique.mockResolvedValue({ branchId: 'blocked' });
    await expect(caller().getBill({ billId: 'bill-blocked' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.billFindUnique).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.requireBranchScope.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    mocks.orderFindUnique.mockResolvedValue({ branchId: 'blocked' });
    await expect(caller().getOrderSettlement({ orderId: 'order-blocked' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.orderFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.billFindMany).not.toHaveBeenCalled();
  });

  it('denies a caller without money:read', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().listBills({ branchId: 'b1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('rejects unknown input fields (.strict())', async () => {
    await expect(
      // @ts-expect-error unknown field must be rejected, never stripped
      caller().listBills({ branchId: 'b1', bogus: true })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
