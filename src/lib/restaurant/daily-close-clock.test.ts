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
});
