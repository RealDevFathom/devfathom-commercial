// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { computeCloseAggregate, correctClose, cutClose } from './daily-close';
import { beginMoneyIdempotent } from './drawer-sessions';

vi.mock('./drawer-sessions', async (original) => ({
  ...(await original<typeof import('./drawer-sessions')>()),
  beginMoneyIdempotent: vi.fn(),
}));

const input = {
  branchId: 'branch',
  businessDate: '2026-10-29',
  supersedesCloseId: 'original-close',
  reason: 'recount',
  approvingStaffProfileId: 'manager',
  actor: { staffProfileId: 'operator', deviceId: 'device', idempotencyKey: 'close-key' },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T22:30:00Z')); // 03:30 in Karachi on October 29.
  vi.mocked(beginMoneyIdempotent).mockReset();
});

afterEach(() => vi.useRealTimers());

describe.each([
  { name: 'cut', command: cutClose },
  { name: 'correct', command: correctClose },
])('$name close date eligibility', ({ command }) => {
  function fixture() {
    const tx = {
      restaurantBranch: {
        findUnique: vi.fn().mockResolvedValue({
          organizationId: 'tenant',
          timezone: 'Asia/Karachi',
          businessDayCutoff: '04:00',
        }),
      },
      $executeRaw: vi.fn().mockResolvedValue(0),
      restaurantDailyClose: { create: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    };
    const db = {
      $transaction: (work: (scoped: ScopedDb) => Promise<unknown>) =>
        work(tx as unknown as ScopedDb),
    } as unknown as ScopedDb;
    return { db, tx };
  }

  it('rejects a new close before the branch cutoff without writing a snapshot', async () => {
    const { db, tx } = fixture();
    vi.mocked(beginMoneyIdempotent).mockResolvedValue({ replay: false });

    await expect(command(db, input)).rejects.toMatchObject({ reason: 'FUTURE_BUSINESS_DATE' });
    expect(tx.restaurantBranch.findUnique).toHaveBeenCalledWith({
      where: { id: input.branchId },
      select: { organizationId: true, timezone: true, businessDayCutoff: true },
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.restaurantDailyClose.create).not.toHaveBeenCalled();
    expect(tx.restaurantDailyClose.count).not.toHaveBeenCalled();
    expect(tx.restaurantDailyClose.findMany).not.toHaveBeenCalled();
  });

  it('returns a completed receipt even when a changed cutoff makes its date future', async () => {
    const { db, tx } = fixture();
    // The command completed with a midnight cutoff; configuration is now 04:00.
    const { tenderTotals, ...totals } = computeCloseAggregate({
      bills: [],
      tenders: [],
      refunds: [],
      drawers: [],
    });
    vi.mocked(beginMoneyIdempotent).mockResolvedValue({
      replay: true,
      resultRef: 'saved-close',
      resultPayload: {
        dailyCloseId: 'saved-close',
        supersedesCloseId: input.supersedesCloseId,
        totals: Object.fromEntries(
          Object.entries(totals).map(([key, value]) => [key, value.toString()])
        ),
        tenderTotals: [],
      },
    });

    await expect(command(db, input)).resolves.toMatchObject({
      dailyCloseId: 'saved-close',
      replayed: true,
      totals,
      tenderTotals,
    });
    expect(tx.restaurantDailyClose.create).not.toHaveBeenCalled();
    expect(tx.restaurantDailyClose.count).not.toHaveBeenCalled();
    expect(tx.restaurantDailyClose.findMany).not.toHaveBeenCalled();
  });
});
