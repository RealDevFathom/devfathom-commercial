import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('./insight-rollups', () => ({ enqueueInsightRollup: vi.fn() }));

import { cutClose } from './daily-close';

const input = {
  branchId: 'branch-1',
  businessDate: '2026-01-15',
  actor: { staffProfileId: 'staff-1', deviceId: 'device-1', idempotencyKey: 'close-1' },
};
const beforeCutoff = new Date('2026-01-15T11:59:59.000Z');
const canonicalHash = createHash('sha256')
  .update(
    JSON.stringify({ version: 1, branchId: input.branchId, businessDate: input.businessDate }),
    'utf8'
  )
  .digest('hex');
const frozenResult = {
  dailyCloseId: 'close-0',
  totals: { grossSales: '10.00' },
  tenderTotals: [{ tenderType: 'CASH', amount: '10.00', tipAmount: '0.00', count: 1 }],
};
const atCutoff = new Date('2026-01-15T12:00:00.000Z');

function closeDb() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    restaurantBranch: {
      findUnique: vi.fn().mockResolvedValue({
        organizationId: 'org-1',
        timezone: 'America/Los_Angeles',
        businessDayCutoff: '04:00',
      }),
    },
    restaurantMoneyIdempotencyKey: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    restaurantDailyClose: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: 'close-1' }),
    },
    restaurantBill: { findMany: vi.fn().mockResolvedValue([]) },
    // The close readiness guard (#538) also counts unresolved orders for the day.
    restaurantOrder: { count: vi.fn().mockResolvedValue(0) },
    restaurantTender: { findMany: vi.fn().mockResolvedValue([]) },
    restaurantRefund: { findMany: vi.fn().mockResolvedValue([]) },
    restaurantDrawerSession: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const db = {
    $transaction: (work: (scoped: ScopedDb) => Promise<unknown>) => work(tx as unknown as ScopedDb),
  } as unknown as ScopedDb;
  return { db, tx };
}

afterEach(() => vi.useRealTimers());

describe('daily-close server clock', () => {
  it('allows a close whose advisory-lock wait crosses the business-day cutoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(beforeCutoff);
    const { db, tx } = closeDb();
    const lock = Promise.withResolvers<number>();
    const waiting = Promise.withResolvers<void>();
    tx.$executeRaw.mockImplementationOnce(() => {
      waiting.resolve();
      return lock.promise;
    });

    const result = cutClose(db, input);
    await waiting.promise;
    expect(tx.restaurantDailyClose.create).not.toHaveBeenCalled();
    vi.setSystemTime(atCutoff);
    lock.resolve(1);

    await expect(result).resolves.toMatchObject({ dailyCloseId: 'close-1', replayed: false });
    expect(tx.restaurantDailyClose.create).toHaveBeenCalledOnce();
  });

  it('rejects a future business date before writing a close or idempotency key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(beforeCutoff);
    const { db, tx } = closeDb();

    await expect(cutClose(db, input)).rejects.toMatchObject({ reason: 'INVALID' });
    expect(tx.restaurantDailyClose.create).not.toHaveBeenCalled();
    expect(tx.restaurantMoneyIdempotencyKey.create).not.toHaveBeenCalled();
  });

  it.each(['2026-01-13', '2026-01-14'])(
    'allows past and current business dates before the cutoff: %s',
    async (businessDate) => {
      const { db } = closeDb();

      await expect(cutClose(db, { ...input, businessDate }, beforeCutoff)).resolves.toMatchObject({
        dailyCloseId: 'close-1',
        replayed: false,
      });
    }
  );

  it('honors an injected time independently of the server clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(atCutoff);
    const { db } = closeDb();

    await expect(cutClose(db, input, beforeCutoff)).rejects.toMatchObject({ reason: 'INVALID' });
    await expect(cutClose(db, input, atCutoff)).resolves.toMatchObject({ replayed: false });
  });

  it('replays a completed close even when its date now resolves as future', async () => {
    const { db, tx } = closeDb();
    tx.restaurantMoneyIdempotencyKey.findUnique.mockResolvedValue({
      commandType: 'cash.day_close',
      canonicalPayloadHash: canonicalHash,
      resultRef: 'close-0',
      resultPayload: frozenResult,
      completedAt: new Date('2026-01-15T12:00:00.000Z'),
    });

    await expect(cutClose(db, input, beforeCutoff)).resolves.toMatchObject({
      dailyCloseId: 'close-0',
      replayed: true,
    });
    expect(tx.restaurantMoneyIdempotencyKey.create).not.toHaveBeenCalled();
    expect(tx.restaurantDailyClose.create).not.toHaveBeenCalled();
  });

  it('still rejects a mismatched existing key for a future date without writing', async () => {
    const { db, tx } = closeDb();
    tx.restaurantMoneyIdempotencyKey.findUnique.mockResolvedValue({
      commandType: 'cash.day_close',
      canonicalPayloadHash: 'different',
      resultRef: 'close-0',
      resultPayload: frozenResult,
      completedAt: new Date('2026-01-15T12:00:00.000Z'),
    });

    await expect(cutClose(db, input, beforeCutoff)).rejects.toMatchObject({
      reason: 'TAX_SETTLEMENT_CONFLICT',
    });
    expect(tx.restaurantMoneyIdempotencyKey.create).not.toHaveBeenCalled();
    expect(tx.restaurantDailyClose.create).not.toHaveBeenCalled();
  });
});
