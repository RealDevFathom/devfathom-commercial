import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./scheduler', () => ({ enqueue: mocks.enqueue }));

import {
  chunkBusinessDateRange,
  businessDateCutoffUtc,
  computeItemMix,
  computeLoyaltyLiability,
  computeReconciledFinancials,
  enqueueInsightBackfill,
  rollupDay,
  rollupDayHandler,
} from './insight-rollups';

const D = (value: string) => new Prisma.Decimal(value);

describe('pure rollup calculations', () => {
  it('reconciles close-facing totals exactly with Decimal, including discounts', () => {
    const total = computeReconciledFinancials({
      bills: [
        {
          status: 'SETTLED',
          subtotal: D('100.00'),
          taxTotal: D('7.00'),
          serviceChargeTotal: D('3.00'),
          compTotal: D('10.00'),
          discountTotal: D('5.00'),
          grandTotal: D('85.00'),
        },
        {
          status: 'VOID',
          subtotal: D('9.99'),
          taxTotal: D('0'),
          serviceChargeTotal: D('0'),
          compTotal: D('0'),
          discountTotal: D('0'),
          grandTotal: D('9.99'),
        },
      ],
      tenders: [{ tipAmount: D('6.00') }],
      refunds: [{ amount: D('2.50') }],
      drawers: [],
    });
    expect(total.grossSales.toString()).toBe('100');
    expect(total.discountTotal.toString()).toBe('5');
    expect(total.netSales.toString()).toBe('85');
    expect(total.taxTotal.toString()).toBe('7');
    expect(total.serviceChargeTotal.toString()).toBe('3');
    expect(total.tipTotal.toString()).toBe('6');
    expect(total.refundTotal.toString()).toBe('2.5');
    expect(total.voidTotal.toString()).toBe('9.99');
  });

  it('projects deterministic product item mix from snapshot prices and non-voided inputs', () => {
    const result = computeItemMix([
      {
        productId: 'p2',
        unitPrice: D('5.00'),
        quantity: 1,
        modifiers: [],
        billLines: [],
      },
      {
        productId: 'p1',
        unitPrice: D('10.00'),
        quantity: 2,
        modifiers: [{ priceDelta: D('1.50') }],
        billLines: [{ compAmount: D('3.00') }],
      },
    ]);
    expect(result.map((row) => row.productId)).toEqual(['p1', 'p2']);
    expect(result[0]).toMatchObject({ quantity: 2 });
    expect(result[0]!.grossSales.toString()).toBe('23');
    expect(result[0]!.netSales.toString()).toBe('20');
  });

  it('counts only positive ledger balances at effective redemption value', () => {
    const liability = computeLoyaltyLiability(
      [
        { accountId: 'a', points: 100 },
        { accountId: 'a', points: -25 },
        { accountId: 'b', points: -50 },
      ],
      D('0.015')
    );
    expect(liability.toString()).toBe('1.13');
  });
});

function rollupDb(input?: { correction?: boolean; mismatch?: boolean }) {
  const close = {
    id: 'close_1',
    createdAt: new Date('2026-08-21T02:00:00.000Z'),
    supersedesCloseId: null,
    grossSales: D(input?.mismatch ? '11' : '10'),
    netSales: D('7'),
    taxTotal: D('0'),
    serviceChargeTotal: D('0'),
    tipTotal: D('0'),
    compTotal: D('2'),
    discountTotal: D('1'),
    refundTotal: D('3'),
    voidTotal: D('4'),
    cashExpected: D('0'),
    cashCounted: D('0'),
    cashVariance: D('0'),
  };
  const tip = input?.correction
    ? { ...close, id: 'close_2', supersedesCloseId: 'close_1', grossSales: D('10') }
    : close;
  const db = {
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db)),
    restaurantBranch: { findUnique: vi.fn(async () => ({ organizationId: 'org_1' })) },
    organization: { findUnique: vi.fn(async () => ({ timezone: 'Asia/Karachi' })) },
    restaurantDailyClose: {
      findMany: vi.fn(async () => (input?.correction ? [close, tip] : [tip])),
    },
    restaurantBill: {
      findMany: vi.fn(async () => [
        {
          status: 'SETTLED',
          subtotal: D('10'),
          taxTotal: D('0'),
          serviceChargeTotal: D('0'),
          compTotal: D('2'),
          discountTotal: D('1'),
          grandTotal: D('7'),
        },
        {
          status: 'VOID',
          subtotal: D('4'),
          taxTotal: D('0'),
          serviceChargeTotal: D('0'),
          compTotal: D('0'),
          discountTotal: D('0'),
          grandTotal: D('4'),
        },
      ]),
    },
    restaurantTender: { findMany: vi.fn(async () => []) },
    restaurantRefund: { findMany: vi.fn(async () => [{ amount: D('3') }]) },
    restaurantDrawerSession: { findMany: vi.fn(async () => []) },
    insightDailyRollup: {
      findFirst: vi.fn(async () => ({
        id: 'rollup_1',
        sourceDailyCloseId: 'close_1',
        projectionVersion: 2,
      })),
      upsert: vi.fn(async () => ({ id: 'rollup_1' })),
    },
    insightLoyaltyLiability: {
      findFirst: vi.fn(async () => ({ projectionVersion: 2 })),
      upsert: vi.fn(async () => ({ id: 'liability_1' })),
    },
    restaurantOrder: { findMany: vi.fn(async () => []) },
    loyaltyProgramVersion: { findFirst: vi.fn(async () => null) },
    loyaltyPointsEntry: { findMany: vi.fn(async () => []) },
    insightItemMixRollup: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  return db;
}

describe('rollupDay handler idempotency and correction', () => {
  it('pins the next organization-local midnight, including timezone offset', () => {
    expect(businessDateCutoffUtc('2026-08-20', 'Asia/Karachi').toISOString()).toBe(
      '2026-08-20T19:00:00.000Z'
    );
  });

  it('no-ops when current close source was already projected', async () => {
    const db = rollupDb();
    const result = await rollupDay(db as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-08-20',
    });
    expect(result.replayed).toBe(true);
    expect(db.insightDailyRollup.upsert).not.toHaveBeenCalled();
    expect(db.insightItemMixRollup.deleteMany).not.toHaveBeenCalled();
  });

  it('replaces projection against authoritative correction chain tip', async () => {
    const db = rollupDb({ correction: true });
    const result = await rollupDay(db as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-08-20',
    });
    expect(result).toMatchObject({ sourceDailyCloseId: 'close_2', replayed: false });
    expect(db.insightItemMixRollup.deleteMany).toHaveBeenCalledOnce();
    expect(db.insightDailyRollup.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ sourceDailyCloseId: 'close_2' }),
      })
    );
  });

  it('deliberately replaces an otherwise current projection when forced', async () => {
    const db = rollupDb();
    const result = await rollupDay(db as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-08-20',
      force: true,
    });
    expect(result.replayed).toBe(false);
    expect(db.insightDailyRollup.upsert).toHaveBeenCalledOnce();
    expect(db.insightLoyaltyLiability.upsert).toHaveBeenCalledOnce();
  });

  it('leaves loyalty liability stale on ordinary replay after a backdated ledger adjustment', async () => {
    const db = rollupDb();
    const ledger = [
      { accountId: 'account_1', points: 100, occurredAt: new Date('2026-08-20T17:00:00Z') },
    ];
    let persistedLiability = D('0');

    db.insightDailyRollup.findFirst.mockResolvedValueOnce(null).mockResolvedValue({
      id: 'rollup_1',
      sourceDailyCloseId: 'close_1',
      projectionVersion: 2,
    });
    db.insightLoyaltyLiability.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ projectionVersion: 2 });
    db.loyaltyProgramVersion.findFirst.mockResolvedValue({
      id: 'program_1',
      redemptionValue: D('0.015'),
    });
    db.loyaltyPointsEntry.findMany.mockImplementation(async ({ where }) =>
      ledger
        .filter((entry) => entry.occurredAt < where.occurredAt.lt)
        .map(({ accountId, points }) => ({ accountId, points }))
    );
    db.insightLoyaltyLiability.upsert.mockImplementation(async ({ update }) => {
      persistedLiability = update.liability;
      return { id: 'liability_1' };
    });

    const initial = await rollupDay(db as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-08-20',
    });
    expect(initial).toMatchObject({ sourceDailyCloseId: 'close_1', itemCount: 0, replayed: false });
    expect(persistedLiability.toString()).toBe('1.5');

    ledger.push({
      accountId: 'account_1',
      points: -40,
      occurredAt: new Date('2026-08-20T18:00:00Z'),
    });
    const rawLiability = computeLoyaltyLiability(ledger, D('0.015'));
    expect(rawLiability.toString()).toBe('0.9');

    const ordinaryReplay = await rollupDay(db as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-08-20',
    });
    expect(ordinaryReplay).toMatchObject({
      sourceDailyCloseId: 'close_1',
      itemCount: 0,
      replayed: true,
    });
    expect(persistedLiability.toString()).toBe('1.5');

    const forcedRebuild = await rollupDay(db as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-08-20',
      force: true,
    });
    expect(forcedRebuild).toMatchObject({
      sourceDailyCloseId: 'close_1',
      itemCount: 0,
      replayed: false,
    });
    expect(persistedLiability.toString()).toBe('0.9');
  });

  it('fails closed when raw facts do not exactly reconcile', async () => {
    const db = rollupDb({ mismatch: true });
    await expect(
      rollupDay(db as unknown as ScopedDb, {
        branchId: 'branch_1',
        businessDate: '2026-08-20',
      })
    ).rejects.toMatchObject({ reason: 'RECONCILIATION_FAILED' });
    expect(db.insightDailyRollup.upsert).not.toHaveBeenCalled();
  });

  it('strictly rejects unknown handler payload keys before touching DB', async () => {
    await expect(
      rollupDayHandler({
        db: {} as ScopedDb,
        job: { payload: { branchId: 'b', businessDate: '2026-08-20', extra: true } } as never,
      })
    ).rejects.toThrow();
  });
});

describe('inclusive backfill chunking', () => {
  beforeEach(() => {
    mocks.enqueue.mockReset();
    mocks.enqueue.mockResolvedValue({ job: { id: 'job' }, deduplicated: false });
  });

  it('splits an inclusive range into chunks no larger than 90 days', () => {
    expect(chunkBusinessDateRange('2026-01-01', '2026-04-01')).toEqual([
      { from: '2026-01-01', to: '2026-03-31' },
      { from: '2026-04-01', to: '2026-04-01' },
    ]);
  });

  it('enqueues a 90-day boundary once per day with request-scoped keys', async () => {
    const result = await enqueueInsightBackfill({} as ScopedDb, {
      branchId: 'branch_1',
      from: '2026-01-01',
      to: '2026-03-31',
      requestId: 'repair_1',
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.enqueued).toBe(90);
    expect(mocks.enqueue).toHaveBeenCalledTimes(90);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ idempotencyKey: expect.stringContaining('backfill:repair_1') })
    );
  });

  it('rejects 91 days before enqueuing any work', async () => {
    await expect(
      enqueueInsightBackfill({} as ScopedDb, {
        branchId: 'branch_1',
        from: '2026-01-01',
        to: '2026-04-01',
        requestId: 'repair_2',
      })
    ).rejects.toMatchObject({ reason: 'INVALID' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
