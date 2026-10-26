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
  it('reconciles refund-aware close totals including delivery fee, tax, and service components', () => {
    const total = computeReconciledFinancials({
      bills: [
        {
          status: 'SETTLED',
          subtotal: D('100.00'),
          deliveryFeeTotal: D('12.00'),
          taxTotal: D('7.00'),
          serviceChargeTotal: D('3.00'),
          compTotal: D('10.00'),
          discountTotal: D('5.00'),
          grandTotal: D('85.00'),
        },
        {
          status: 'VOID',
          subtotal: D('9.99'),
          deliveryFeeTotal: D('4.00'),
          taxTotal: D('0'),
          serviceChargeTotal: D('0'),
          compTotal: D('0'),
          discountTotal: D('0'),
          grandTotal: D('9.99'),
        },
      ],
      tenders: [{ tipAmount: D('6.00') }],
      refunds: [
        {
          amount: D('2.50'),
          taxRefundAmount: D('0.50'),
          serviceChargeRefundAmount: D('0.25'),
          deliveryFeeRefundAmount: D('1.25'),
        },
        {
          amount: D('3.00'),
          taxRefundAmount: D('0.40'),
          serviceChargeRefundAmount: D('0.30'),
          deliveryFeeRefundAmount: D('0.80'),
        },
      ],
      drawers: [],
    });
    expect(total.grossSales.toString()).toBe('100');
    expect(total.deliveryFeeSales.toString()).toBe('12');
    expect(total.deliveryFeeRefunds.toString()).toBe('2.05');
    expect(total.discountTotal.toString()).toBe('5');
    expect(total.netSales.toString()).toBe('83');
    expect(total.taxTotal.toString()).toBe('6.1');
    expect(total.serviceChargeTotal.toString()).toBe('2.45');
    expect(total.tipTotal.toString()).toBe('6');
    expect(total.refundTotal.toString()).toBe('3.45');
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

function rollupDb(input?: { correction?: boolean; mismatch?: boolean; legacyNet?: boolean }) {
  const close = {
    id: 'close_1',
    createdAt: new Date('2026-08-21T02:00:00.000Z'),
    supersedesCloseId: null,
    grossSales: D(input?.mismatch ? '11' : '10'),
    deliveryFeeSales: D('2'),
    deliveryFeeRefunds: D('1'),
    netSales: D(input?.legacyNet ? '7' : '5.75'),
    taxTotal: D('0'),
    serviceChargeTotal: D('0'),
    tipTotal: D('0'),
    compTotal: D('2'),
    discountTotal: D('1'),
    refundTotal: D('2'),
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
          deliveryFeeTotal: D('2'),
          taxTotal: D('0.5'),
          serviceChargeTotal: D('0.25'),
          compTotal: D('2'),
          discountTotal: D('1'),
          grandTotal: D('7'),
        },
        {
          status: 'VOID',
          subtotal: D('4'),
          deliveryFeeTotal: D('0'),
          taxTotal: D('0'),
          serviceChargeTotal: D('0'),
          compTotal: D('0'),
          discountTotal: D('0'),
          grandTotal: D('4'),
        },
      ]),
    },
    restaurantTender: { findMany: vi.fn(async () => []) },
    restaurantRefund: {
      findMany: vi.fn(async () => [
        {
          amount: D('3'),
          taxRefundAmount: D('0.5'),
          serviceChargeRefundAmount: D('0.25'),
          deliveryFeeRefundAmount: D('1'),
        },
      ]),
    },
    restaurantDrawerSession: { findMany: vi.fn(async () => []) },
    insightDailyRollup: {
      findFirst: vi.fn<
        () => Promise<{
          id: string;
          sourceDailyCloseId: string;
          projectionVersion: number;
        } | null>
      >(async () => ({ id: 'rollup_1', sourceDailyCloseId: 'close_1', projectionVersion: 4 })),
      upsert: vi.fn(async () => ({ id: 'rollup_1' })),
    },
    insightLoyaltyLiability: {
      findFirst: vi.fn<
        () => Promise<{
          cutoffAt: Date;
          programVersionId: string | null;
          redemptionValue: Prisma.Decimal;
          positivePoints: bigint;
          signedPoints: bigint;
          liability: Prisma.Decimal;
          projectionVersion: number;
        } | null>
      >(async () => ({
        cutoffAt: new Date('2026-08-20T19:00:00.000Z'),
        programVersionId: null,
        redemptionValue: D('0'),
        positivePoints: BigInt(0),
        signedPoints: BigInt(0),
        liability: D('0'),
        projectionVersion: 4,
      })),
      upsert: vi.fn<(args?: { update: { liability: Prisma.Decimal } }) => Promise<{ id: string }>>(
        async () => ({ id: 'liability_1' })
      ),
    },
    restaurantOrder: { findMany: vi.fn(async () => []) },
    loyaltyProgramVersion: {
      findFirst: vi.fn<() => Promise<{ id: string; redemptionValue: Prisma.Decimal } | null>>(
        async () => null
      ),
    },
    $queryRaw: vi.fn<
      (query: Prisma.Sql) => Promise<Array<{ positivePoints: bigint; signedPoints: bigint }>>
    >(async () => [{ positivePoints: BigInt(0), signedPoints: BigInt(0) }]),
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

  it('accepts refund-aware close totals before replaying the current projection', async () => {
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

  it.each(['ADJUSTMENT', 'EXPIRY', 'REVERSAL'] as const)(
    'refreshes loyalty liability on ordinary replay after a backdated %s',
    async (kind) => {
      const db = rollupDb();
      const ledger: Array<{
        accountId: string;
        points: number;
        occurredAt: Date;
        kind: 'EARN' | 'ADJUSTMENT' | 'EXPIRY' | 'REVERSAL';
      }> = [
        {
          accountId: 'account_1',
          points: 100,
          occurredAt: new Date('2026-08-20T17:00:00Z'),
          kind: 'EARN',
        },
      ];
      let persistedLiability = D('0');

      db.insightDailyRollup.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: 'rollup_1', sourceDailyCloseId: 'close_1', projectionVersion: 4 });
      db.insightLoyaltyLiability.findFirst.mockResolvedValueOnce(null).mockResolvedValue({
        cutoffAt: new Date('2026-08-20T19:00:00.000Z'),
        programVersionId: 'program_1',
        redemptionValue: D('0.015'),
        positivePoints: BigInt(100),
        signedPoints: BigInt(100),
        liability: D('1.5'),
        projectionVersion: 4,
      });
      db.loyaltyProgramVersion.findFirst.mockResolvedValue({
        id: 'program_1',
        redemptionValue: D('0.015'),
      });
      db.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
        const cutoffAt = query.values[1] as Date;
        const balances = new Map<string, bigint>();
        for (const entry of ledger.filter((row) => row.occurredAt < cutoffAt)) {
          balances.set(
            entry.accountId,
            (balances.get(entry.accountId) ?? BigInt(0)) + BigInt(entry.points)
          );
        }
        return [
          {
            positivePoints: [...balances.values()].reduce(
              (total, balance) => total + (balance > 0 ? balance : BigInt(0)),
              BigInt(0)
            ),
            signedPoints: [...balances.values()].reduce(
              (total, balance) => total + balance,
              BigInt(0)
            ),
          },
        ];
      });
      db.insightLoyaltyLiability.upsert.mockImplementation(async (args) => {
        persistedLiability = args!.update.liability;
        return { id: 'liability_1' };
      });

      const initial = await rollupDay(db as unknown as ScopedDb, {
        branchId: 'branch_1',
        businessDate: '2026-08-20',
      });
      expect(initial).toMatchObject({
        sourceDailyCloseId: 'close_1',
        itemCount: 0,
        replayed: false,
      });
      expect(persistedLiability.toString()).toBe('1.5');

      ledger.push({
        accountId: 'account_1',
        points: -40,
        occurredAt: new Date('2026-08-20T18:00:00Z'),
        kind,
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
        replayed: false,
      });
      expect(persistedLiability.toString()).toBe('0.9');

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
    }
  );

  it('aggregates an arbitrarily large historical ledger into one scoped fingerprint row', async () => {
    const db = rollupDb();
    const returnedRowCounts: number[] = [];
    let historicalEntryCount = 1;
    db.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
      const rows = [
        {
          positivePoints: BigInt(historicalEntryCount),
          signedPoints: BigInt(historicalEntryCount),
        },
      ];
      returnedRowCounts.push(rows.length);
      expect(query.strings.join('?')).toContain('GROUP BY "accountId"');
      expect(query.strings.join('?')).toContain('SUM(GREATEST(balance, 0))');
      expect(query.values).toEqual(['org_1', new Date('2026-08-20T19:00:00.000Z')]);
      return rows;
    });

    await rollupDay(db as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-08-20',
      force: true,
    });
    historicalEntryCount = 10_001;
    await rollupDay(db as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-08-20',
      force: true,
    });

    expect(returnedRowCounts).toEqual([1, 1]);
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect('loyaltyPointsEntry' in db).toBe(false);
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

  it.each([true, false])(
    'normalizes legacy=%s and refreshes an existing v3 projection',
    async (legacyNet) => {
      const db = rollupDb({ legacyNet });
      db.insightDailyRollup.findFirst.mockResolvedValue({
        id: 'rollup_1',
        sourceDailyCloseId: 'close_1',
        projectionVersion: 3,
      });
      await rollupDay(db as unknown as ScopedDb, {
        branchId: 'branch_1',
        businessDate: '2026-08-20',
      });
      expect(db.insightDailyRollup.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ netSales: D('5.75') }),
          update: expect.objectContaining({ netSales: D('5.75') }),
        })
      );
      expect((await db.restaurantDailyClose.findMany())[0].netSales.toString()).toBe(
        legacyNet ? '7' : '5.75'
      );
    }
  );

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
