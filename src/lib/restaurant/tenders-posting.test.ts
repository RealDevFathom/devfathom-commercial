// No DB client: exercise the real command, money arithmetic, replay and ledger
// paths against in-memory delegates. DB rollback/RLS/concurrency require QA.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { finalizeBillSettlement } from './bills';
import { getOrderSettlementForBranch } from './checkout-routes';
import { closePreview } from './daily-close';
import { appendMovement, closeDrawerSession, foldExpectedCash } from './drawer-sessions';
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
vi.mock('./loyalty', async (original) => ({
  ...(await original<typeof import('./loyalty')>()),
  reverseLoyaltyForRefund: vi.fn(),
}));

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
};

function fixture() {
  let taxRate = D('0');
  const tenders: Tender[] = [];
  const payments: Record<string, unknown>[] = [];
  const paymentEvents: Record<string, unknown>[] = [];
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
      findFirst: vi.fn(async ({ where }: { where: Where }) =>
        matches({ id: 'order', branchId: 'branch' }, where)
          ? {
              id: 'order',
              branchId: 'branch',
              serviceChargePolicyVersion: null,
              deliveryFulfillment: null,
              items: [
                { id: 'item', status: 'SENT', unitPrice: D('4000'), quantity: 1, modifiers: [] },
              ],
            }
          : null
      ),
    },
    restaurantBill: {
      findUnique: vi.fn(async ({ where }: { where: Where }) => billsById.get(where.id!) ?? bill),
      findMany: vi.fn(async ({ where }: { where: Where }) => (matches(bill, where) ? [bill] : [])),
    },
    restaurantTender: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; bill: { branchId: string } } }) => {
        const row = tenders.find((tender) => tender.id === where.id);
        return row && where.bill.branchId === bill.branchId
          ? { ...row, paymentId: null, bill }
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
            rate: taxRate,
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
      aggregate: vi.fn(async () => ({ _sum: {} })),
      create: vi.fn(async () => ({ id: 'refund' })),
    },
    restaurantTaxTenderAllocationSnapshot: { findMany: vi.fn(async () => []) },
    restaurantTaxTransactionSnapshot: { findMany: vi.fn(async () => []) },
    restaurantCoAuthorization: { create: vi.fn(async () => ({ id: 'approval' })) },
    restaurantPayment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        payments.push(data);
        return { id: 'payment' };
      }),
    },
    restaurantPaymentEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        paymentEvents.push(data);
        return { id: 'event' };
      }),
    },
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
    payments,
    paymentEvents,
    movements,
    collect,
    closedDays,
    locks,
    billsById,
    linesByBill,
    defaultLine,
    setTaxRate: (rate: string) => {
      taxRate = D(rate);
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('collection posting and authoritative recorded balances (no DB)', () => {
  it('quotes and persists the real tax-inclusive CARD balance with exact decimal cents', async () => {
    const f = fixture();
    f.bill.subtotal = D('10.00');
    f.bill.compTotal = D('0');
    f.bill.grandTotal = D('10.00');
    f.defaultLine.unitPrice = D('10.00');
    f.defaultLine.lineSubtotal = D('10.00');
    f.defaultLine.compAmount = D('0');
    f.setTaxRate('0.08');

    const quote = await quoteOpenBillSettlement(f.db, f.bill.id, NOW, 'CARD');
    expect(quote?.taxTotal.toFixed(2)).toBe('0.80');
    expect(quote?.remainingDue.toFixed(2)).toBe('10.80');

    const result = await f.collect({
      tender: {
        type: 'CARD',
        amount: quote!.remainingDue,
        terminalConfirmation: {
          configId: 'config',
          branchId: 'branch',
          externalEventId: 'event',
          source: 'provider',
          externalReference: 'bill',
          providerRef: 'approval',
        },
      },
    });

    expect(result).toMatchObject({ settled: true });
    expect(result.remainingDue.toFixed(2)).toBe('0.00');
    expect(f.tenders).toHaveLength(1);
    expect(f.tenders[0]!.amount.toFixed(2)).toBe('10.80');
    expect((f.payments[0]!.amount as Prisma.Decimal).toFixed(2)).toBe('10.80');
    expect((f.paymentEvents[0]!.amount as Prisma.Decimal).toFixed(2)).toBe('10.80');
  });

  it('rejects a terminal approval when the locked CARD quote was repriced', async () => {
    const f = fixture();
    f.bill.subtotal = D('10.00');
    f.bill.compTotal = D('0');
    f.bill.grandTotal = D('10.00');
    f.defaultLine.unitPrice = D('10.00');
    f.defaultLine.lineSubtotal = D('10.00');
    f.defaultLine.compAmount = D('0');
    f.setTaxRate('0.08');
    const approved = await quoteOpenBillSettlement(f.db, f.bill.id, NOW, 'CARD');

    // The tax authority changes after webhook validation. applyTenderInTransaction
    // re-quotes only after acquiring its order and bill locks.
    f.setTaxRate('0.15');
    await expect(
      f.collect({
        tender: {
          type: 'CARD',
          amount: approved!.remainingDue,
          terminalConfirmation: {
            configId: 'config',
            branchId: 'branch',
            externalEventId: 'repriced-event',
            source: 'provider',
            externalReference: 'bill',
            providerRef: 'approval',
          },
        },
      })
    ).rejects.toMatchObject({ reason: 'TAX_SETTLEMENT_REPRICE_REQUIRED' });
    expect(f.locks).toEqual([
      'SELECT id FROM restaurant_orders WHERE id = ? FOR UPDATE',
      'SELECT id FROM restaurant_bills WHERE id = ? FOR UPDATE',
    ]);
    expect(f.tenders).toHaveLength(0);
  });

  it('collects a prior-day bill on the drawer date; reconciles sales and collections on their own days', async () => {
    const f = fixture();
    const result = await f.collect();
    expect(result.changeGiven?.toFixed(2)).toBe('140.00');
    expect(result.remainingDue.toFixed(2)).toBe('0.00');
    expect(f.bill.businessDate).toEqual(D1);
    expect(f.tenders[0].businessDate).toEqual(D2);
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

  it('leaves same-day posting unchanged', async () => {
    const f = fixture();
    f.bill.businessDate = D2;
    await f.collect();
    expect(f.tenders[0].businessDate).toEqual(D2);
    expect(f.raw.$executeRaw).toHaveBeenCalledTimes(1);
  });

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
    ]);
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
