import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./scheduler', () => ({ enqueue: mocks.enqueue }));

import {
  chunkBusinessDateRange,
  computeItemMix,
  computeLoyaltyLiability,
  computeReconciledFinancials,
  enqueueInsightBackfill,
  enqueueInsightRollup,
  MAX_BACKFILL_TOTAL_DAYS,
  rollupDay,
  rollupDayHandler,
} from './insight-rollups';
import { exportInsightReports } from './insights';

const D = (value: string) => new Prisma.Decimal(value);

type DailyRollupLookup = {
  id: string;
  sourceDailyCloseId: string;
  loyaltyLiabilityRollupId: string | null;
} | null;
type LoyaltyProgramLookup = { redemptionValue: Prisma.Decimal } | null;
type LoyaltyEntryQuery = { where: { occurredAt: { lt: Date } } };
type LiabilityUpsertArgs = { update: { liability: Prisma.Decimal } };

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
    organization: { findUnique: vi.fn(async () => ({ timezone: 'UTC' })) },
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
      findFirst: vi.fn(async (): Promise<DailyRollupLookup> => ({
        id: 'rollup_1',
        sourceDailyCloseId: 'close_1',
        loyaltyLiabilityRollupId: 'liability_1',
      })),
      update: vi.fn(async () => ({ id: 'rollup_1' })),
      upsert: vi.fn(async () => ({ id: 'rollup_1' })),
    },
    restaurantOrder: { findMany: vi.fn(async () => []) },
    loyaltyProgramVersion: {
      findFirst: vi.fn(async (): Promise<LoyaltyProgramLookup> => null),
    },
    loyaltyPointsEntry: {
      findMany: vi.fn(
        async (_args: LoyaltyEntryQuery) => [] as Array<{ accountId: string; points: number }>
      ),
    },
    insightLoyaltyLiabilityRollup: {
      upsert: vi.fn(async (_args: LiabilityUpsertArgs) => ({ id: 'liability_1' })),
    },
    insightItemMixRollup: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  return db;
}

describe('rollupDay handler idempotency and correction', () => {
  it('no-ops when current close source was already projected', async () => {
    const db = rollupDb();
    const result = await rollupDay(db as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-08-20',
    });
    expect(result.replayed).toBe(true);
    expect(db.insightLoyaltyLiabilityRollup.upsert).toHaveBeenCalledOnce();
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

  it('fails closed on reconciliation mismatch and recovers after the raw facts are corrected', async () => {
    const db = rollupDb({ mismatch: true });
    await expect(
      rollupDay(db as unknown as ScopedDb, {
        branchId: 'branch_1',
        businessDate: '2026-08-20',
      })
    ).rejects.toMatchObject({
      reason: 'RECONCILIATION_FAILED',
      message: 'Daily close reconciliation failed for grossSales.',
    });
    expect(db.insightLoyaltyLiabilityRollup.upsert).not.toHaveBeenCalled();
    expect(db.insightDailyRollup.upsert).not.toHaveBeenCalled();

    const [close] = await db.restaurantDailyClose.findMany();
    db.restaurantDailyClose.findMany.mockResolvedValue([{ ...close!, grossSales: D('10') }]);
    db.insightDailyRollup.findFirst.mockResolvedValue(null);
    await expect(
      rollupDay(db as unknown as ScopedDb, {
        branchId: 'branch_1',
        businessDate: '2026-08-20',
      })
    ).resolves.toMatchObject({ replayed: false });
    expect(db.insightLoyaltyLiabilityRollup.upsert).toHaveBeenCalledOnce();
    expect(db.insightDailyRollup.upsert).toHaveBeenCalledOnce();
  });

  it('uses the next organization-local day boundary and excludes later ledger activity', async () => {
    const db = rollupDb();
    db.organization.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
    db.loyaltyProgramVersion.findFirst.mockResolvedValue({ redemptionValue: D('0.015') });
    const ledger = [
      { accountId: 'a', points: 100, occurredAt: new Date('2026-03-08T20:00:00.000Z') },
      { accountId: 'a', points: -25, occurredAt: new Date('2026-03-09T03:59:59.999Z') },
      { accountId: 'b', points: -50, occurredAt: new Date('2026-03-08T22:00:00.000Z') },
      { accountId: 'a', points: 1_000, occurredAt: new Date('2026-03-09T04:00:00.000Z') },
    ];
    db.loyaltyPointsEntry.findMany.mockImplementation(
      async ({ where }: { where: { occurredAt: { lt: Date } } }) =>
        ledger
          .filter((entry) => entry.occurredAt < where.occurredAt.lt)
          .map(({ accountId, points }) => ({ accountId, points }))
    );

    await rollupDay(db as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-03-08',
    });
    const firstLiability = db.insightLoyaltyLiabilityRollup.upsert.mock.calls
      .at(-1)![0]
      .update.liability.toString();
    const exportedLiability = async (liability: string) =>
      (
        await exportInsightReports(
          {
            insightDailyRollup: {
              findMany: vi.fn(async () => [
                {
                  id: 'rollup_1',
                  branchId: 'branch_1',
                  businessDate: new Date('2026-03-08T00:00:00.000Z'),
                  sourceDailyCloseId: 'close_1',
                  orderCount: 0,
                  coverCount: 0,
                  grossSales: D('10'),
                  netSales: D('7'),
                  compTotal: D('2'),
                  refundTotal: D('3'),
                  voidTotal: D('4'),
                  drawerVariance: D('0'),
                  loyaltyLiability: D('999'),
                  loyaltyLiabilityFact: { liability: D(liability) },
                  computedAt: new Date('2026-03-09T04:00:00.000Z'),
                  createdAt: new Date('2026-03-09T04:00:00.000Z'),
                  updatedAt: new Date('2026-03-09T04:00:00.000Z'),
                  branch: { name: 'Main', timezone: 'America/New_York' },
                  sourceDailyClose: { supersededBy: [] },
                },
              ]),
            },
          } as unknown as ScopedDb,
          'financial',
          { branchId: 'branch_1', from: '2026-03-08', to: '2026-03-08' }
        )
      ).content;
    const firstExport = await exportedLiability(firstLiability);
    ledger.push({
      accountId: 'a',
      points: 9_000,
      occurredAt: new Date('2026-08-24T00:00:00.000Z'),
    });
    await rollupDay(db as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-03-08',
    });
    const secondLiability = db.insightLoyaltyLiabilityRollup.upsert.mock.calls
      .at(-1)![0]
      .update.liability.toString();
    const secondExport = await exportedLiability(secondLiability);

    expect([firstLiability, secondLiability]).toEqual(['1.13', '1.13']);
    expect(secondExport).toBe(firstExport);
    expect(db.loyaltyPointsEntry.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { occurredAt: { lt: new Date('2026-03-09T04:00:00.000Z') } },
      })
    );
    expect(db.loyaltyProgramVersion.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { effectiveFrom: { lt: new Date('2026-03-09T04:00:00.000Z') } },
      })
    );
    // Hand-computed raw ledger: max(100 - 25, 0) + max(-50, 0) = 75; 75 * .015 = 1.125 -> 1.13.
    expect(secondExport.split('\n')[1]!.split(',').at(-1)).toBe('1.13');
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
  const backfillDb = () => {
    const db = {
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db)),
      $queryRaw: vi.fn(async () => [{ acquired: true }]),
      restaurantJob: {
        findMany: vi.fn(async () => []),
      },
    };
    return db;
  };

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

  it('enqueues each inclusive day once while reporting chunk boundaries', async () => {
    const result = await enqueueInsightBackfill(backfillDb() as unknown as ScopedDb, {
      branchId: 'branch_1',
      from: '2026-01-01',
      to: '2026-04-01',
    });
    expect(result.chunks).toHaveLength(2);
    expect(result.enqueued).toBe(91);
    expect(mocks.enqueue).toHaveBeenCalledTimes(91);
  });

  it('rejects a huge range before enqueueing any work', async () => {
    await expect(
      enqueueInsightBackfill(backfillDb() as unknown as ScopedDb, {
        branchId: 'branch_1',
        from: '2020-01-01',
        to: '2022-01-01',
      })
    ).rejects.toThrow(`at most ${MAX_BACKFILL_TOTAL_DAYS}`);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues exactly 366 inclusive days', async () => {
    const result = await enqueueInsightBackfill(backfillDb() as unknown as ScopedDb, {
      branchId: 'branch_1',
      from: '2026-01-01',
      to: '2027-01-01',
    });
    expect(result.enqueued).toBe(366);
    expect(mocks.enqueue).toHaveBeenCalledTimes(366);
  });

  it('rejects 367 inclusive days before enqueueing any work', async () => {
    await expect(
      enqueueInsightBackfill(backfillDb() as unknown as ScopedDb, {
        branchId: 'branch_1',
        from: '2026-01-01',
        to: '2027-01-02',
      })
    ).rejects.toThrow(`at most ${MAX_BACKFILL_TOTAL_DAYS}`);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('creates a fresh terminal rebuild generation and deduplicates an in-flight one', async () => {
    const terminal = {
      id: 'job_1',
      status: 'FAILED',
      idempotencyKey: 'insights.rollupDay:branch_1:2026-01-01:rebuild:1',
    };
    const terminalDb = {
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(terminalDb)),
      $queryRaw: vi.fn(async () => [{ acquired: true }]),
      restaurantJob: {
        findMany: vi.fn(async () => [terminal]),
      },
    };
    mocks.enqueue.mockResolvedValueOnce({
      job: {
        id: 'job_2',
        status: 'QUEUED',
        idempotencyKey: 'insights.rollupDay:branch_1:2026-01-01:rebuild:2',
      },
      deduplicated: false,
    });
    const recovered = await enqueueInsightRollup(terminalDb as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-01-01',
      rebuild: true,
    });
    expect(recovered).toMatchObject({
      deduplicated: false,
      job: {
        status: 'QUEUED',
        idempotencyKey: 'insights.rollupDay:branch_1:2026-01-01:rebuild:2',
      },
    });
    expect(terminalDb.$queryRaw).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledWith(
      terminalDb,
      expect.objectContaining({
        idempotencyKey: 'insights.rollupDay:branch_1:2026-01-01:rebuild:2',
      })
    );

    terminalDb.restaurantJob.findMany.mockResolvedValue([
      terminal,
      {
        ...terminal,
        id: 'job_2',
        status: 'RUNNING',
        idempotencyKey: 'insights.rollupDay:branch_1:2026-01-01:rebuild:2',
      },
    ]);
    mocks.enqueue.mockClear();
    const duplicate = await enqueueInsightRollup(terminalDb as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-01-01',
      rebuild: true,
    });
    expect(duplicate).toMatchObject({ deduplicated: true, job: { status: 'RUNNING' } });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('deduplicates a concurrent rebuild even if its winner finishes before the lock is acquired', async () => {
    const prior = {
      id: 'job_1',
      status: 'FAILED',
      idempotencyKey: 'insights.rollupDay:branch_1:2026-01-01:rebuild:1',
    };
    const winner = {
      id: 'job_2',
      status: 'SUCCEEDED',
      idempotencyKey: 'insights.rollupDay:branch_1:2026-01-01:rebuild:2',
    };
    const db = {
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db)),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ acquired: false }])
        .mockResolvedValueOnce([{ pg_advisory_xact_lock: null }]),
      restaurantJob: {
        findMany: vi.fn().mockResolvedValueOnce([prior]).mockResolvedValueOnce([prior, winner]),
      },
    };

    await expect(
      enqueueInsightRollup(db as unknown as ScopedDb, {
        branchId: 'branch_1',
        businessDate: '2026-01-01',
        rebuild: true,
      })
    ).resolves.toEqual({ job: winner, deduplicated: true });
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
