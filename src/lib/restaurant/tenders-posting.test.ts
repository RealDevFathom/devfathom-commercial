// No DB client: exercise the real command, money arithmetic, replay and ledger
// paths against in-memory delegates. DB rollback/RLS/concurrency require QA.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type RestaurantPayment } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { finalizeBillSettlement } from './bills';
import { getOrderSettlementForBranch } from './checkout-routes';
import { closePreview } from './daily-close';
import { appendMovement, closeDrawerSession, foldExpectedCash } from './drawer-sessions';
import { reverseLoyaltyForRefund } from './loyalty';
import { refundTender } from './refunds';
import {
  applyTenderInTransaction,
  quoteOpenBillSettlement,
  type ApplyTenderInput,
} from './tenders';

vi.mock('./bills', async (original) => ({
  ...(await original<typeof import('./bills')>()),
  finalizeBillSettlement: vi.fn(),
}));
vi.mock('./loyalty', () => ({
  reverseLoyaltyForRefund: vi.fn(),
  earnLoyaltyForClosedOrder: vi.fn(),
}));
vi.mock('./inventory', () => ({ postOrderRecipeConsumption: vi.fn() }));
vi.mock('./outbox', () => ({ appendOrderEvent: vi.fn() }));

const D = (value: string) => new Prisma.Decimal(value);
const D1 = new Date('2026-09-10T00:00:00Z');
const D2 = new Date('2026-09-11T00:00:00Z');
const NOW = new Date('2026-09-11T12:00:00Z');
const actor = { staffProfileId: 'operator', deviceId: 'device', idempotencyKey: 'collect' };
type Where = {
  id?: string;
  branchId?: string;
  deviceId?: string;
  orderId?: string;
  billId?: string;
  businessDate?: Date;
  status?: string;
};
type Tender = {
  id: string;
  billId: string;
  type: 'CASH' | 'CARD' | 'OTHER';
  amount: Prisma.Decimal;
  tipAmount: Prisma.Decimal;
  businessDate: Date;
  createdAt: Date;
  paymentId?: string | null;
};

function fixture() {
  const tenders: Tender[] = [];
  const movements = [{ kind: 'OPENING_FLOAT' as const, amount: D('100') }] as Array<{
    kind: Parameters<typeof foldExpectedCash>[0][number]['kind'];
    amount: Prisma.Decimal;
    tenderId?: string;
  }>;
  const bill = {
    id: 'bill',
    organizationId: 'tenant',
    orderId: 'order',
    branchId: 'branch',
    businessDate: D1,
    status: 'OPEN',
    splitKind: 'NONE',
    fractionNumerator: null,
    fractionDenominator: null,
    subtotal: D('4000'),
    compTotal: D('140'),
    discountTotal: D('0'),
    grandTotal: D('3860'),
    taxTotal: D('0'),
    serviceChargeTotal: D('0'),
    deliveryFeeTotal: D('0'),
    roundingAdjustment: D('0'),
    receiptNumber: null as number | null,
    lines: [{ orderItemId: 'item' }],
    tenders,
  };
  // The register summary re-quotes each OPEN bill by id (QA-143), so bills and their
  // lines resolve from id-keyed registries; unregistered ids fall back to the base bill.
  const defaultLine = {
    id: 'line',
    billId: 'bill',
    orderItemId: 'item',
    name: 'Item',
    quantity: 1,
    unitPrice: D('4000'),
    lineSubtotal: D('4000'),
    compAmount: D('140'),
    orderItem: { modifiers: [] },
  };
  const billsById = new Map<string, typeof bill>([[bill.id, bill]]);
  const linesByBill = new Map<string, (typeof defaultLine)[]>([[bill.id, [defaultLine]]]);
  const drawer = {
    id: 'drawer',
    branchId: 'branch',
    deviceId: 'device',
    businessDate: D2,
    status: 'OPEN',
    countedCash: null as Prisma.Decimal | null,
    device: { branchId: 'branch' },
    movements,
  };
  // Refund rows a test seeds directly (e.g. legacy refunds against an OPEN bill).
  const refunds: Array<{ billId: string; originalTenderId: string; amount: Prisma.Decimal }> = [];
  const closedDays = new Set<number>();
  const locks: string[] = [];
  const keys = new Map<string, Record<string, unknown>>();
  const matches = (row: object, where: Where) =>
    Object.entries(where).every(([key, value]) => {
      const actual = (row as Record<string, unknown>)[key];
      return value instanceof Date
        ? actual instanceof Date && actual.getTime() === value.getTime()
        : actual === value;
    });
  // Same synthetic zero-rate profile as tenders.test.ts, no external tax authority.
  const effective = {
    effectiveFrom: new Date('2026-08-01T00:00:00Z'),
    effectiveTo: null,
    status: 'PUBLISHED',
    approvalReference: 'SYNTHETIC_TEST_APPROVAL',
    approvedAt: D1,
  };
  const raw = {
    $transaction: vi.fn(async (work: (tx: ScopedDb) => Promise<unknown>) => work(db)),
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
      locks.push(sql.join('?'));
      return [{ id: 'locked' }];
    }),
    $executeRaw: vi.fn(async (_sql: TemplateStringsArray, key: string) => {
      locks.push(key);
      return 1;
    }),
    restaurantMoneyIdempotencyKey: {
      findUnique: vi.fn(
        async ({ where }: { where: { deviceId_key: { deviceId: string; key: string } } }) =>
          keys.get(`${where.deviceId_key.deviceId}:${where.deviceId_key.key}`) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        keys.set(`${data.deviceId}:${data.key}`, {
          ...data,
          resultRef: null,
          resultPayload: null,
          completedAt: null,
        });
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { deviceId: string; key: string };
          data: Record<string, unknown>;
        }) => {
          Object.assign(keys.get(`${where.deviceId}:${where.key}`)!, data);
          return { count: 1 };
        }
      ),
    },
    restaurantOrder: {
      findUnique: vi.fn(async ({ where }: { where: Where }) =>
        where.id === 'order'
          ? {
              id: 'order',
              branchId: 'branch',
              status: 'PAYMENT_PENDING',
              channel: 'DINE_IN',
              items: [{ id: 'item', status: 'SERVED' }],
            }
          : null
      ),
      findFirst: vi.fn(async ({ where }: { where: Where }) =>
        matches({ id: 'order', branchId: 'branch' }, where)
          ? {
              id: 'order',
              branchId: 'branch',
              serviceChargePolicyVersion: null,
              deliveryFulfillment: null,
              items: [
                {
                  id: 'item',
                  status: 'SENT',
                  remakeOfItemId: null,
                  unitPrice: D('4000'),
                  quantity: 1,
                  modifiers: [],
                },
              ],
            }
          : null
      ),
      update: vi.fn(async () => undefined),
      count: vi.fn(async () => 0),
    },
    restaurantOrderTable: { updateMany: vi.fn(async () => ({ count: 1 })) },
    restaurantBill: {
      findUnique: vi.fn(async ({ where }: { where: Where }) => billsById.get(where.id!) ?? bill),
      findMany: vi.fn(async ({ where }: { where: Where }) => (matches(bill, where) ? [bill] : [])),
      // Respects every filter (including `status`), so a refund status guard is real.
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const row = billsById.get(where.id!);
        return row && matches(row, where) ? row : null;
      }),
    },
    restaurantTender: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; bill: { branchId: string } } }) => {
        const row = tenders.find((tender) => tender.id === where.id);
        return row && where.bill.branchId === bill.branchId
          ? { ...row, paymentId: row.paymentId ?? null, bill }
          : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Where & { bill?: { branchId: string } } }) => {
        const { bill: scope, ...fields } = where;
        return scope && scope.branchId !== bill.branchId
          ? []
          : tenders.filter((row) => matches(row, fields));
      }),
      create: vi.fn(async ({ data }: { data: Omit<Tender, 'id' | 'createdAt'> }) => {
        const row = { ...data, id: `tender-${tenders.length + 1}`, createdAt: NOW };
        tenders.push(row);
        return row;
      }),
    },
    restaurantRegisteredDevice: {
      findFirst: vi.fn(async ({ where }: { where: Where }) =>
        matches({ id: 'device', branchId: 'branch', revokedAt: null }, where)
          ? { branchId: 'branch', branch: { timezone: 'Asia/Karachi', businessDayCutoff: '04:00' } }
          : null
      ),
    },
    restaurantBranch: {
      findUnique: vi.fn(async () => ({
        organizationId: 'tenant',
        timezone: 'Asia/Karachi',
        businessDayCutoff: '04:00',
      })),
    },
    restaurantDailyClose: {
      findFirst: vi.fn(async ({ where }: { where: { businessDate: Date } }) =>
        closedDays.has(where.businessDate.getTime()) ? { id: 'close' } : null
      ),
      findMany: vi.fn(async () => []),
    },
    restaurantDrawerSession: {
      findFirst: vi.fn(async ({ where }: { where: Where }) =>
        matches(drawer, where) ? drawer : null
      ),
      findUnique: vi.fn(async () => drawer),
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        matches(drawer, where) ? [drawer] : []
      ),
      update: vi.fn(async ({ data }: { data: Partial<typeof drawer> }) =>
        Object.assign(drawer, data)
      ),
    },
    restaurantDrawerMovement: {
      create: vi.fn(async ({ data }: { data: (typeof movements)[number] }) => {
        movements.push(data);
        return { id: `movement-${movements.length}` };
      }),
    },
    organization: { findUnique: vi.fn(async () => ({ currency: 'PKR' })) },
    restaurantTaxProfileVersion: {
      findMany: vi.fn(async () => [
        {
          id: 'profile',
          ...effective,
          rules: ['CASH', 'CARD', 'OTHER'].map((paymentCategory) => ({
            id: `rule-${paymentCategory}`,
            profileVersionId: 'profile',
            paymentCategory,
            priceMode: 'EXCLUSIVE',
            rate: D('0'),
            ...effective,
            officialSource: { expiresAt: new Date('2027-08-01T00:00:00Z') },
          })),
        },
      ]),
    },
    restaurantBillLine: {
      findMany: vi.fn(async ({ where }: { where: { billId: string | { in: string[] } } }) => {
        if (typeof where.billId === 'string') {
          return linesByBill.get(where.billId) ?? [defaultLine];
        }
        return where.billId.in.flatMap((billId) =>
          (linesByBill.get(billId) ?? []).map((line) => ({ ...line, billId }))
        );
      }),
    },
    restaurantPromotionBillApplicationSnapshot: { findMany: vi.fn(async () => []) },
    restaurantRefund: {
      findMany: vi.fn(async () => []),
      aggregate: vi.fn(
        async ({ where }: { where: { billId?: string; originalTenderId?: string } }) => {
          const rows = refunds.filter((row) =>
            where.billId
              ? row.billId === where.billId
              : row.originalTenderId === where.originalTenderId
          );
          return {
            _sum:
              rows.length === 0
                ? {}
                : { amount: rows.reduce((total, row) => total.plus(row.amount), D('0')) },
          };
        }
      ),
      create: vi.fn(async () => ({ id: 'refund' })),
    },
    restaurantTaxTenderAllocationSnapshot: { findMany: vi.fn(async () => []) },
    restaurantTaxRefundAllocation: { create: vi.fn(async () => ({ id: 'tax-refund' })) },
    restaurantTaxTransactionSnapshot: { findMany: vi.fn(async () => []) },
    restaurantCoAuthorization: { create: vi.fn(async () => ({ id: 'approval' })) },
    restaurantPayment: {
      create: vi.fn(async () => ({ id: 'payment' })),
      findUnique: vi.fn(
        async (): Promise<Pick<RestaurantPayment, 'id' | 'provider' | 'providerRef'> | null> => ({
          id: 'payment',
          provider: 'TERMINAL',
          providerRef: 'terminal-payment',
        })
      ),
      update: vi.fn(),
    },
    restaurantPaymentEvent: { create: vi.fn(async () => ({ id: 'event' })) },
    restaurantTerminalReconciliation: { create: vi.fn(async () => ({ id: 'reconciliation' })) },
  };
  const db = raw as unknown as ScopedDb;
  vi.mocked(finalizeBillSettlement).mockImplementation(async (_tx, input) => {
    bill.status = 'SETTLED';
    bill.receiptNumber = 1;
    return { receiptNumber: 1, alreadySettled: false, ...input } as never;
  });
  const collect = (overrides: Partial<ApplyTenderInput> = {}) =>
    applyTenderInTransaction(db, {
      billId: bill.id,
      branchId: bill.branchId,
      actor,
      now: NOW,
      tender: { type: 'CASH', amount: '3860', cashReceived: '4000' },
      ...overrides,
    });
  return {
    db,
    raw,
    bill,
    drawer,
    tenders,
    movements,
    collect,
    closedDays,
    locks,
    billsById,
    linesByBill,
    defaultLine,
    refunds,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('collection posting and authoritative recorded balances (no DB)', () => {
  it('closes the order and releases its table as part of the final tender transaction', async () => {
    const f = fixture();

    await expect(f.collect()).resolves.toMatchObject({ settled: true });

    expect(f.raw.restaurantOrder.update).toHaveBeenCalledWith({
      where: { id: 'order' },
      data: { status: 'CLOSED', closedAt: NOW },
    });
    expect(f.raw.restaurantOrderTable.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'order', active: true },
      data: { active: false, unlinkedAt: NOW },
    });
  });

  it('does not close or release the table for a partial tender', async () => {
    const f = fixture();

    await expect(
      f.collect({ tender: { type: 'CASH', amount: '1000', cashReceived: '1000' } })
    ).resolves.toMatchObject({ settled: false });

    expect(f.raw.restaurantOrder.update).not.toHaveBeenCalled();
    expect(f.raw.restaurantOrderTable.updateMany).not.toHaveBeenCalled();
  });

  it('collects a prior-day bill on the drawer date; reconciles sales and collections on their own days', async () => {
    const f = fixture();
    const result = await f.collect();
    expect(result.changeGiven?.toFixed(2)).toBe('140.00');
    expect(result.remainingDue.toFixed(2)).toBe('0.00');
    expect(f.bill.businessDate).toEqual(D1);
    expect(f.tenders[0].businessDate).toEqual(D2);
    expect(f.locks.filter((key) => key.startsWith('tenant:'))).toEqual([
      'tenant:branch:2026-09-10',
      'tenant:branch:2026-09-11',
      'tenant:branch:2026-09-11', // The drawer append independently guards its day.
    ]);
    expect(f.movements.filter((row) => row.kind === 'CASH_SALE')).toMatchObject([
      { tenderId: result.tenderId, amount: D('3860') },
    ]);
    const oldDay = await closePreview(f.db, { branchId: 'branch', businessDate: '2026-09-10' });
    const today = await closePreview(f.db, { branchId: 'branch', businessDate: '2026-09-11' });
    expect(oldDay.netSales.toFixed(2)).toBe('3860.00');
    expect(oldDay.tenderTotals).toEqual([]);
    expect(today.netSales.toFixed(2)).toBe('0.00');
    expect(today.tenderTotals.find((row) => row.tenderType === 'CASH')?.amount.toFixed(2)).toBe(
      '3860.00'
    );
    expect(today.cashExpected.toFixed(2)).toBe('3960.00');
    const closed = await closeDrawerSession(f.db, {
      drawerSessionId: 'drawer',
      countedCash: '3960',
      actor: { ...actor, idempotencyKey: 'close' },
    });
    expect(closed.variance.toFixed(2)).toBe('0.00');
    const lock = f.raw.$queryRaw.mock.invocationCallOrder.at(-2)!;
    expect(lock).toBeLessThan(
      f.raw.restaurantDrawerSession.findFirst.mock.invocationCallOrder.at(-1)!
    );
  });

  it('returns partial principal balance without subtracting comps twice or counting cash received', async () => {
    const f = fixture();
    expect(
      (await getOrderSettlementForBranch(f.db, 'order', 'branch'))?.bills[0].remainingDue
    ).toBe('3860.00');
    await f.collect({ tender: { type: 'CASH', amount: '1000.10', cashReceived: '1100' } });
    const summary = await getOrderSettlementForBranch(f.db, 'order', 'branch');
    expect(summary?.bills[0]).toMatchObject({
      grandTotal: '3860.00',
      compTotal: '140.00',
      remainingDue: '2859.90',
    });
    await f.collect({
      actor: { ...actor, idempotencyKey: 'finish' },
      tender: { type: 'CASH', amount: '2859.90', cashReceived: '3000' },
    });
    expect(
      (await getOrderSettlementForBranch(f.db, 'order', 'branch'))?.bills[0].remainingDue
    ).toBe('0.00');
  });

  it('keeps split-bill balances separate and returns zero for a fully comped bill', async () => {
    const f = fixture();
    const partialTender = {
      id: 'paid',
      billId: 'partial',
      type: 'OTHER' as const,
      amount: D('0.01'),
      tipAmount: D('0'),
      businessDate: D1,
      createdAt: NOW,
    };
    // Two live OPEN bills: one partially paid (0.01 of 3860), one fully comped (nets 0).
    // Each is re-quoted by id, so register its own bill row, lines and tenders (QA-143).
    f.billsById.set('partial', { ...f.bill, id: 'partial' });
    f.billsById.set('comped', {
      ...f.bill,
      id: 'comped',
      compTotal: D('4000'),
      grandTotal: D('0'),
    });
    f.linesByBill.set('partial', [f.defaultLine]);
    f.linesByBill.set('comped', [{ ...f.defaultLine, compAmount: D('4000') }]);
    f.tenders.push(partialTender);
    f.raw.restaurantBill.findMany.mockResolvedValue([
      { ...f.bill, id: 'partial', tenders: [partialTender] },
      { ...f.bill, id: 'comped', compTotal: D('4000'), grandTotal: D('0'), tenders: [] },
    ]);
    expect(
      (await getOrderSettlementForBranch(f.db, 'order', 'branch'))?.bills.map(
        (bill) => bill.remainingDue
      )
    ).toEqual(['3859.99', '0.00']);
  });

  it.each(['CASH', 'CARD', 'OTHER'] as const)(
    'leaves same-day %s posting unchanged and guards the drawer append for cash',
    async (type) => {
      const f = fixture();
      f.bill.businessDate = D2;
      await f.collect({
        tender:
          type === 'CASH'
            ? { type, amount: '3860', cashReceived: '4000' }
            : { type, amount: '3860' },
      });
      expect(f.tenders[0].businessDate).toEqual(D2);
      // The tender deduplicates bill/posting days; a cash movement then takes
      // the same transaction-scoped lock again through its own day guard.
      expect(f.raw.$executeRaw).toHaveBeenCalledTimes(type === 'CASH' ? 2 : 1);
      expect(f.locks.filter((key) => key.startsWith('tenant:'))).toEqual(
        type === 'CASH'
          ? ['tenant:branch:2026-09-11', 'tenant:branch:2026-09-11']
          : ['tenant:branch:2026-09-11']
      );
    }
  );

  it.each(['CARD', 'OTHER'] as const)(
    'posts next-day %s principal and tip on processing date',
    async (type) => {
      const f = fixture();
      await f.collect({ tender: { type, amount: '1000', tipAmount: '10' } });
      expect(f.tenders[0]).toMatchObject({
        businessDate: D2,
        amount: D('1000'),
        tipAmount: D('10'),
      });
      expect(
        (await getOrderSettlementForBranch(f.db, 'order', 'branch'))?.bills[0].remainingDue
      ).toBe('2860.00');
      expect(f.movements).toHaveLength(1);
    }
  );

  it('replays after day and drawer close without another tender or movement; changed payload conflicts', async () => {
    const f = fixture();
    const first = await f.collect();
    f.drawer.status = 'CLOSED';
    f.closedDays.add(D2.getTime());
    const replay = await f.collect({ now: new Date('2026-09-12T12:00:00Z') });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(f.tenders).toHaveLength(1);
    expect(f.movements).toHaveLength(2);
    await expect(
      f.collect({ tender: { type: 'CASH', amount: '1', cashReceived: '1' } })
    ).rejects.toMatchObject({ name: 'MoneyIdempotencyError' });
  });

  it('reverses on collection day even for a prior-day bill; refund replay leaves the drawer unchanged', async () => {
    const f = fixture();
    const collected = await f.collect();
    const input = {
      originalTenderId: collected.tenderId,
      amount: '3860',
      kind: 'VOID_REVERSAL' as const,
      reason: 'Synthetic reversal',
      approvingStaffProfileId: 'manager',
      actor: { ...actor, idempotencyKey: 'refund' },
      branchId: 'branch',
      now: NOW,
    };
    const reversed = await refundTender(f.db, input);
    expect(reversed.businessDate).toEqual(D2);
    expect(foldExpectedCash(f.movements).toFixed(2)).toBe('100.00');
    f.drawer.status = 'CLOSED';
    f.closedDays.add(D2.getTime());
    expect(await refundTender(f.db, { ...input, now: new Date('2026-09-12T12:00:00Z') })).toEqual({
      ...reversed,
      replayed: true,
    });
    expect(f.raw.restaurantRefund.create).toHaveBeenCalledTimes(1);
    expect(f.movements.filter((row) => row.kind === 'CASH_REFUND')).toHaveLength(1);
    expect(
      (await getOrderSettlementForBranch(f.db, 'order', 'branch'))?.bills[0].remainingDue
    ).toBe('0.00');
  });

  it('refuses a refund into a closed processing day before approval and ledger writes', async () => {
    const f = fixture();
    const collected = await f.collect();
    f.closedDays.add(D2.getTime());
    await expect(
      refundTender(f.db, {
        originalTenderId: collected.tenderId,
        amount: '3860',
        reason: 'Synthetic refund',
        approvingStaffProfileId: 'manager',
        actor: { ...actor, idempotencyKey: 'refund' },
        now: NOW,
      })
    ).rejects.toMatchObject({ reason: 'CLOSE_EXISTS' });
    expect(f.raw.restaurantCoAuthorization.create).not.toHaveBeenCalled();
    expect(f.raw.restaurantRefund.create).not.toHaveBeenCalled();
    expect(f.movements).toHaveLength(2);
  });

  it('refuses to refund a partial tender on an OPEN bill under the bill lock, before any write', async () => {
    const f = fixture();
    const partial = await f.collect({
      tender: { type: 'CASH', amount: '1000', cashReceived: '1000' },
    });
    expect(partial.settled).toBe(false);
    expect(f.bill.status).toBe('OPEN');
    const idempotencyClaims = f.raw.restaurantMoneyIdempotencyKey.create.mock.calls.length;
    const movements = f.movements.length;
    const locksBefore = f.locks.length;

    await expect(
      refundTender(f.db, {
        originalTenderId: partial.tenderId,
        amount: '1000',
        reason: 'Refund before settlement',
        approvingStaffProfileId: 'manager',
        actor: { ...actor, idempotencyKey: 'open-bill-refund' },
        branchId: 'branch',
        now: NOW,
      })
    ).rejects.toMatchObject({ name: 'RefundError', reason: 'BILL_NOT_SETTLED' });

    // The status is read under the bill row lock, not from the unlocked tender load.
    expect(f.locks.slice(locksBefore).some((sql) => sql.includes('restaurant_bills'))).toBe(true);
    const lockOrder = f.raw.$queryRaw.mock.invocationCallOrder.at(-1)!;
    expect(f.raw.restaurantBill.findFirst).toHaveBeenCalledWith({
      where: { id: 'bill', status: 'SETTLED' },
      select: { id: true },
    });
    expect(f.raw.restaurantBill.findFirst.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(
      lockOrder
    );
    expect(f.raw.restaurantMoneyIdempotencyKey.create).toHaveBeenCalledTimes(idempotencyClaims);
    expect(f.raw.restaurantCoAuthorization.create).not.toHaveBeenCalled();
    expect(f.raw.restaurantRefund.create).not.toHaveBeenCalled();
    expect(f.raw.restaurantTaxRefundAllocation.create).not.toHaveBeenCalled();
    expect(reverseLoyaltyForRefund).not.toHaveBeenCalled();
    expect(f.movements).toHaveLength(movements);

    // The rest of the bill is still owed in full; settlement still needs 2860.
    const final = await f.collect({
      actor: { ...actor, idempotencyKey: 'final' },
      tender: { type: 'CASH', amount: '2860', cashReceived: '2860' },
    });
    expect(final.settled).toBe(true);
  });

  it('does not count refunded principal toward settlement, so a bill cannot settle short', async () => {
    const f = fixture();
    const partial = await f.collect({
      tender: { type: 'CASH', amount: '1000', cashReceived: '1000' },
    });
    // A legacy refund recorded against the still-OPEN bill returned the 1000.
    f.refunds.push({ billId: 'bill', originalTenderId: partial.tenderId, amount: D('1000') });

    const next = await f.collect({
      actor: { ...actor, idempotencyKey: 'remaining' },
      tender: { type: 'CASH', amount: '2860', cashReceived: '2860' },
    });
    expect(next.settled).toBe(false);
    expect(next.remainingDue.toFixed(2)).toBe('1000.00');
    expect(f.bill.status).toBe('OPEN');
    expect(finalizeBillSettlement).not.toHaveBeenCalled();
    await expect(
      f.collect({
        actor: { ...actor, idempotencyKey: 'over' },
        tender: { type: 'CASH', amount: '1000.01', cashReceived: '1000.01' },
      })
    ).rejects.toMatchObject({ reason: 'OVER_TENDER' });
    const final = await f.collect({
      actor: { ...actor, idempotencyKey: 'final' },
      tender: { type: 'CASH', amount: '1000', cashReceived: '1000' },
    });
    expect(final.settled).toBe(true);
  });

  it.each([
    ['REFUND', '1000'],
    ['VOID_REVERSAL', '3860'],
  ] as const)(
    'rejects a terminal card %s instead of recording a MOCK reversal',
    async (kind, amount) => {
      const f = fixture();
      const collected = await f.collect({
        tender: {
          type: 'CARD',
          amount: '3860',
          terminalConfirmation: {
            configId: 'terminal-config',
            branchId: 'branch',
            externalEventId: 'terminal-event',
            source: 'WEBHOOK',
            externalReference: 'terminal-payment',
            providerRef: 'terminal-provider-ref',
          },
        },
      });
      const writesBeforeRefund = {
        idempotency: f.raw.restaurantMoneyIdempotencyKey.create.mock.calls.length,
        paymentEvents: f.raw.restaurantPaymentEvent.create.mock.calls.length,
        reconciliations: f.raw.restaurantTerminalReconciliation.create.mock.calls.length,
        movements: f.raw.restaurantDrawerMovement.create.mock.calls.length,
      };

      await expect(
        refundTender(f.db, {
          originalTenderId: collected.tenderId,
          amount,
          kind,
          reason: 'Terminal refund regression',
          approvingStaffProfileId: 'manager',
          actor: { ...actor, idempotencyKey: 'terminal-refund' },
          now: NOW,
        })
      ).rejects.toMatchObject({ reason: 'UNSUPPORTED_PAYMENT_PROVIDER' });

      expect(f.raw.restaurantPayment.findUnique).toHaveBeenCalledWith({
        where: { id: 'payment' },
        select: { id: true, provider: true, providerRef: true },
      });
      expect(f.raw.restaurantMoneyIdempotencyKey.create).toHaveBeenCalledTimes(
        writesBeforeRefund.idempotency
      );
      expect(f.raw.restaurantRefund.create).not.toHaveBeenCalled();
      expect(f.raw.restaurantCoAuthorization.create).not.toHaveBeenCalled();
      expect(f.raw.restaurantTaxRefundAllocation.create).not.toHaveBeenCalled();
      expect(reverseLoyaltyForRefund).not.toHaveBeenCalled();
      expect(f.raw.restaurantPaymentEvent.create).toHaveBeenCalledTimes(
        writesBeforeRefund.paymentEvents
      );
      expect(f.raw.restaurantPayment.update).not.toHaveBeenCalled();
      expect(f.raw.restaurantTerminalReconciliation.create).toHaveBeenCalledTimes(
        writesBeforeRefund.reconciliations
      );
      expect(f.raw.restaurantDrawerMovement.create).toHaveBeenCalledTimes(
        writesBeforeRefund.movements
      );
    }
  );

  it('continues to refund card payments through their stored MOCK provider', async () => {
    const f = fixture();
    f.raw.restaurantPayment.findUnique.mockResolvedValueOnce({
      id: 'payment',
      provider: 'MOCK',
      providerRef: 'mock-payment',
    });
    const collected = await f.collect({ tender: { type: 'CARD', amount: '3860' } });
    const paymentEventsBeforeRefund = f.raw.restaurantPaymentEvent.create.mock.calls.length;

    const result = await refundTender(f.db, {
      originalTenderId: collected.tenderId,
      amount: '1000',
      reason: 'Supported provider regression',
      approvingStaffProfileId: 'manager',
      actor: { ...actor, idempotencyKey: 'mock-refund' },
      now: NOW,
    });

    expect(result).toMatchObject({
      paymentId: 'payment',
      paymentStatus: 'PARTIALLY_REFUNDED',
      replayed: false,
    });
    expect(f.raw.restaurantPaymentEvent.create).toHaveBeenCalledTimes(
      paymentEventsBeforeRefund + 1
    );
    expect(f.raw.restaurantPayment.update).toHaveBeenCalledWith({
      where: { id: 'payment' },
      data: { status: 'PARTIALLY_REFUNDED' },
    });
  });

  it.each(['missing payment link', 'deleted payment'] as const)(
    'rejects a card refund with a %s before claiming idempotency or writing refund records',
    async (failure) => {
      const f = fixture();
      const collected = await f.collect({ tender: { type: 'CARD', amount: '3860' } });
      if (failure === 'missing payment link') {
        f.tenders[0].paymentId = null;
      } else {
        f.raw.restaurantPayment.findUnique.mockResolvedValueOnce(null);
      }
      const idempotencyClaimsBeforeRefund =
        f.raw.restaurantMoneyIdempotencyKey.create.mock.calls.length;
      const paymentEventsBeforeRefund = f.raw.restaurantPaymentEvent.create.mock.calls.length;

      await expect(
        refundTender(f.db, {
          originalTenderId: collected.tenderId,
          amount: '1000',
          reason: 'Missing payment regression',
          approvingStaffProfileId: 'manager',
          actor: { ...actor, idempotencyKey: 'missing-payment-refund' },
          now: NOW,
        })
      ).rejects.toMatchObject({ reason: 'PAYMENT_NOT_FOUND' });

      if (failure === 'missing payment link') {
        expect(f.raw.restaurantPayment.findUnique).not.toHaveBeenCalled();
      } else {
        expect(f.raw.restaurantPayment.findUnique).toHaveBeenCalledWith({
          where: { id: 'payment' },
          select: { id: true, provider: true, providerRef: true },
        });
      }
      expect(f.raw.restaurantMoneyIdempotencyKey.create).toHaveBeenCalledTimes(
        idempotencyClaimsBeforeRefund
      );
      expect(f.raw.restaurantRefund.create).not.toHaveBeenCalled();
      expect(f.raw.restaurantCoAuthorization.create).not.toHaveBeenCalled();
      expect(f.raw.restaurantTaxRefundAllocation.create).not.toHaveBeenCalled();
      expect(reverseLoyaltyForRefund).not.toHaveBeenCalled();
      expect(f.raw.restaurantPaymentEvent.create).toHaveBeenCalledTimes(paymentEventsBeforeRefund);
      expect(f.raw.restaurantPayment.update).not.toHaveBeenCalled();
      expect(f.raw.restaurantTerminalReconciliation.create).not.toHaveBeenCalled();
      expect(f.raw.restaurantDrawerMovement.create).not.toHaveBeenCalled();
    }
  );

  it.each([D1, D2])(
    'rejects a closed bill or collection day %s before tender writes',
    async (day) => {
      const f = fixture();
      f.closedDays.add(day.getTime());
      await expect(f.collect()).rejects.toMatchObject({ reason: 'CLOSE_EXISTS' });
      expect(f.tenders).toHaveLength(0);
      expect(f.movements).toHaveLength(1);
    }
  );

  it('uses branch timezone and cutoff, locking bill and posting dates in order', async () => {
    const f = fixture();
    f.drawer.businessDate = D1;
    await f.collect({ now: new Date('2026-09-10T22:30:00Z') }); // 03:30 local, before 04:00 cutoff
    expect(f.tenders[0].businessDate).toEqual(D1);
    expect(f.locks.filter((key) => key.startsWith('tenant:'))).toEqual([
      'tenant:branch:2026-09-10',
      'tenant:branch:2026-09-10', // Drawer guard uses the same cutoff-resolved day.
    ]);
  });

  it.each(['CASH_SALE', 'CASH_REFUND', 'PAID_IN', 'PAID_OUT', 'DROP', 'CLOSING_COUNT'] as const)(
    'rejects a direct %s movement on a closed drawer day before locking or writing the drawer',
    async (kind) => {
      const f = fixture();
      f.closedDays.add(D2.getTime());
      await expect(
        appendMovement(f.db, {
          drawerSessionId: 'drawer',
          kind,
          amount: '1',
          staffProfileId: 'operator',
          deviceId: 'device',
        })
      ).rejects.toMatchObject({ reason: 'CLOSE_EXISTS' });
      expect(f.locks).toEqual(['tenant:branch:2026-09-11']);
      expect(f.raw.$queryRaw).not.toHaveBeenCalled();
      expect(f.raw.restaurantDrawerMovement.create).not.toHaveBeenCalled();
      expect(f.movements).toHaveLength(1);
    }
  );

  it('rejects a drawer close on a financially closed day before changing its ledger or counts', async () => {
    const f = fixture();
    f.closedDays.add(D2.getTime());
    await expect(
      closeDrawerSession(f.db, {
        drawerSessionId: 'drawer',
        countedCash: '100',
        actor: { ...actor, idempotencyKey: 'close' },
      })
    ).rejects.toMatchObject({ reason: 'CLOSE_EXISTS' });
    expect(f.raw.$queryRaw).not.toHaveBeenCalled();
    expect(f.raw.restaurantDrawerMovement.create).not.toHaveBeenCalled();
    expect(f.raw.restaurantDrawerSession.update).not.toHaveBeenCalled();
    expect(f.drawer.status).toBe('OPEN');
    expect(f.movements).toHaveLength(1);
  });

  it.each(['branch', 'device', 'stale', 'closed'])(
    'rejects a %s-mismatched drawer',
    async (kind) => {
      const f = fixture();
      if (kind === 'branch') f.drawer.branchId = 'foreign';
      if (kind === 'device') f.drawer.deviceId = 'foreign';
      if (kind === 'stale') f.drawer.businessDate = D1;
      if (kind === 'closed') f.drawer.status = 'CLOSED';
      await expect(f.collect()).rejects.toMatchObject({ reason: 'DRAWER_NOT_OPEN' });
      expect(f.tenders).toHaveLength(0);
    }
  );

  it('rejects a foreign actor branch and hides cross-branch summary', async () => {
    const f = fixture();
    await expect(f.collect({ branchId: 'foreign' })).rejects.toMatchObject({
      reason: 'BILL_NOT_FOUND',
    });
    expect(await getOrderSettlementForBranch(f.db, 'order', 'foreign')).toBeNull();
    expect(f.tenders).toHaveLength(0);
  });

  it('rejects an unavailable/revoked device even without a caller-supplied branch', async () => {
    const f = fixture();
    await expect(
      f.collect({ branchId: undefined, actor: { ...actor, deviceId: 'foreign' } })
    ).rejects.toMatchObject({ reason: 'BILL_NOT_FOUND' });
    expect(f.tenders).toHaveLength(0);
  });

  it('rechecks OPEN under the drawer lock before appending any movement', async () => {
    const f = fixture();
    f.raw.$queryRaw.mockImplementationOnce(async () => {
      f.drawer.status = 'CLOSED';
      return [];
    });
    await expect(
      appendMovement(f.db, {
        drawerSessionId: 'drawer',
        kind: 'CASH_SALE',
        amount: '1',
        staffProfileId: 'operator',
        deviceId: 'device',
      })
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_OPEN' });
    expect(f.movements).toHaveLength(1);
  });
});

describe('DEV-773 fractional settlement tax evidence (no DB)', () => {
  it('quotes, settles and fully refunds a taxed fractional bill with exact frozen tax', async () => {
    const f = fixture();
    // Order net 20.00, 10% exclusive tax, cut into two equal fractional bills.
    Object.assign(f.bill, {
      splitKind: 'FRACTIONAL',
      fractionNumerator: 1,
      fractionDenominator: 2,
      subtotal: D('10'),
      compTotal: D('0'),
      grandTotal: D('10'),
      lines: [],
    });
    f.linesByBill.set('bill', []);
    Object.assign(f.raw, {
      restaurantOrderItem: {
        findMany: vi.fn(async () => [
          { id: 'item', quantity: 1, unitPrice: D('20'), modifiers: [] },
        ]),
      },
    });
    const findBills = f.raw.restaurantBill.findMany.getMockImplementation()!;
    f.raw.restaurantBill.findMany.mockImplementation(
      async ({ where }: { where: Where & { splitKind?: string } }) =>
        where.splitKind === 'FRACTIONAL'
          ? ([
              { id: 'bill', fractionNumerator: 1 },
              { id: 'bill-2', fractionNumerator: 1 },
            ] as never)
          : findBills({ where })
    );
    const [profile] = await f.raw.restaurantTaxProfileVersion.findMany();
    f.raw.restaurantTaxProfileVersion.findMany.mockResolvedValue([
      { ...profile!, rules: profile!.rules.map((rule) => ({ ...rule, rate: D('0.10') })) },
    ]);
    const frozen: Array<{
      id: string;
      cents: bigint;
      snapshotId: string;
      rateBucketSnapshotId: string;
      paymentCategory: string;
      originalTenderId: string;
      rateBucket: { billLineId: string | null; unitOrdinal: number | null };
      refundAllocations: Array<{ cents: bigint }>;
    }> = [];
    vi.mocked(finalizeBillSettlement).mockImplementation(async (_tx, input) => {
      for (const [index, row] of (input.tenderTaxAllocations ?? []).entries()) {
        frozen.push({
          id: `allocation-${index}`,
          cents: BigInt(row.cents),
          snapshotId: 'snapshot',
          rateBucketSnapshotId: `bucket-${index}`,
          paymentCategory: row.paymentCategory,
          originalTenderId: row.originalTenderId,
          rateBucket: { billLineId: null, unitOrdinal: row.bucket.unitOrdinal ?? null },
          refundAllocations: [],
        });
      }
      f.bill.status = 'SETTLED';
      return { receiptNumber: 1, alreadySettled: false } as never;
    });
    f.raw.restaurantTaxTenderAllocationSnapshot.findMany.mockImplementation((async ({
      where,
    }: {
      where: { originalTenderId: string };
    }) => frozen.filter((row) => row.originalTenderId === where.originalTenderId)) as never);

    const quote = await quoteOpenBillSettlement(f.db, 'bill', NOW);
    expect(quote?.tax.toFixed(2)).toBe('1.00');
    expect(quote?.remainingDue.toFixed(2)).toBe('11.00');
    const collected = await f.collect({
      tender: { type: 'OTHER', amount: quote!.remainingDue.toFixed(2) },
    });
    expect(collected.settled).toBe(true);
    const settlement = vi.mocked(finalizeBillSettlement).mock.calls[0]![1];
    // The real settlement guards (totals, fractional evidence, bucket/tender tax
    // reconciliation and tender ownership) accept the input up to the first write.
    const persistenceReached = 'settlement validation passed; persistence reached';
    const actual = await vi.importActual<typeof import('./bills')>('./bills');
    await expect(
      actual.finalizeBillSettlement(
        {
          restaurantBill: { findUnique: vi.fn(async () => ({ ...f.bill, status: 'OPEN' })) },
          restaurantTender: {
            findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
              f.tenders.filter((tender) => where.id.in.includes(tender.id))
            ),
          },
          $queryRaw: vi.fn(async () => {
            throw new Error(persistenceReached);
          }),
        } as unknown as ScopedDb,
        settlement
      )
    ).rejects.toThrow(persistenceReached);
    expect(settlement.taxTotal.toFixed(2)).toBe('1.00');
    expect(settlement.lines.flatMap((line) => line.buckets)).toHaveLength(1);
    expect(settlement.tenderTaxAllocations).toEqual([
      {
        originalTenderId: collected.tenderId,
        paymentCategory: 'OTHER',
        bucket: {
          allocationKind: 'FRACTIONAL_MERCHANDISE',
          sourceOrderItemId: 'item',
          unitOrdinal: 0,
          ruleVersionId: 'rule-OTHER',
          paymentCategory: 'OTHER',
        },
        cents: 100,
      },
    ]);

    await refundTender(f.db, {
      originalTenderId: collected.tenderId,
      amount: '11.00',
      reason: 'Synthetic full refund',
      approvingStaffProfileId: 'manager',
      actor: { ...actor, idempotencyKey: 'refund-fractional' },
      branchId: 'branch',
      now: NOW,
    });
    const refund = f.raw.restaurantRefund.create.mock.calls[0] as unknown as [
      { data: { amount: Prisma.Decimal; taxRefundAmount: Prisma.Decimal } },
    ];
    expect(refund[0].data.amount.toFixed(2)).toBe('11.00');
    expect(refund[0].data.taxRefundAmount.toFixed(2)).toBe('1.00');
    expect(f.raw.restaurantTaxRefundAllocation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        originalTenderId: collected.tenderId,
        originalTenderAllocationId: 'allocation-0',
        cents: BigInt(100),
      }),
    });
  });
});
