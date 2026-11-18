import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  cutPharmacyDailyClose,
  requirePharmacyDayOpen,
  requirePharmacyTodayOpenForTrading,
} from './settlement';
import { closePharmacyDay, readPharmacyClose, reopenPharmacyDayForTrading } from './day-close';

/**
 * DEV-631: closing early must not block selling until midnight. The owner reopens
 * today's closed business day for trading with a reason; the next close supersedes it.
 */
const scope = { organizationId: 'org', branchId: 'branch', actorId: 'owner' };
const date = new Date('2026-11-02T00:00:00Z');
// 23:48 in Karachi on 2026-11-02: the moment the owner closed early in the QA run.
const lateEvening = new Date('2026-11-02T18:48:00Z');

type Close = {
  id: string;
  sequence: number;
  supersedesCloseId?: string | null;
  reopen?: { id: string; reason?: string } | null;
};

function fixture(close: Close | null) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi' }) },
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ name: 'Branch' }) },
    pharmacyDailyClose: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
        where.id
          ? {
              id: where.id,
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              cashVarianceMinor: 0,
            }
          : close
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'close-2',
        ...data,
      })),
    },
    pharmacyDayReopen: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'reopen-1',
        ...data,
      })),
    },
    pharmacyDrawerSession: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    pharmacySale: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyRefund: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyTender: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyParallelRunWindow: { count: vi.fn().mockResolvedValue(0) },
    camera: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  return { db, scoped: db as unknown as ScopedDb };
}

describe('reopening a closed business day for trading', () => {
  it('keeps a standing close blocking trading', async () => {
    const { scoped } = fixture({ id: 'close-1', sequence: 1, reopen: null });
    await expect(requirePharmacyDayOpen(scoped, scope, date)).rejects.toMatchObject({
      reason: 'DAY_CLOSED',
    });
  });

  it('opens the day for payments and drawers once the latest close is reopened', async () => {
    const { db, scoped } = fixture({ id: 'close-1', sequence: 1, reopen: { id: 'reopen-1' } });
    await expect(requirePharmacyDayOpen(scoped, scope, date)).resolves.toBeUndefined();
    // Only the latest close counts: an earlier reopened close never reopens a later one.
    expect(db.pharmacyDailyClose.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { sequence: 'desc' } })
    );
  });

  it('records the owner, reason, close and date of a reopen for today', async () => {
    const { db, scoped } = fixture({ id: 'close-1', sequence: 1, reopen: null });
    await expect(
      reopenPharmacyDayForTrading(
        scoped,
        scope,
        { businessDate: date, closeId: 'close-1', reason: '  Closed early by mistake  ' },
        lateEvening
      )
    ).resolves.toMatchObject({ id: 'reopen-1', closeId: 'close-1' });
    expect(db.pharmacyDayReopen.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org',
        branchId: 'branch',
        businessDate: date,
        closeId: 'close-1',
        reason: 'Closed early by mistake',
        actorId: 'owner',
      },
    });
    // The day lock is taken before the close is read, as close and tender take it.
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyDailyClose.findFirst.mock.invocationCallOrder[0]!
    );
  });

  it('requires a reason', async () => {
    const { db, scoped } = fixture({ id: 'close-1', sequence: 1, reopen: null });
    await expect(
      reopenPharmacyDayForTrading(
        scoped,
        scope,
        { businessDate: date, closeId: 'close-1', reason: '  ' },
        lateEvening
      )
    ).rejects.toMatchObject({ reason: 'REOPEN_REASON_REQUIRED' });
    expect(db.pharmacyDayReopen.create).not.toHaveBeenCalled();
  });

  it("refuses any day but today's in the workspace zone", async () => {
    const { db, scoped } = fixture({ id: 'close-1', sequence: 1, reopen: null });
    // 00:30 in Karachi on 2026-11-03: the 2nd is now yesterday there.
    const afterMidnight = new Date('2026-11-02T19:30:00Z');
    await expect(
      reopenPharmacyDayForTrading(
        scoped,
        scope,
        { businessDate: date, closeId: 'close-1', reason: 'Late sale' },
        afterMidnight
      )
    ).rejects.toMatchObject({ reason: 'REOPEN_NOT_TODAY' });
    expect(db.pharmacyDayReopen.create).not.toHaveBeenCalled();
  });

  it('refuses a day that is not closed', async () => {
    const { db, scoped } = fixture(null);
    await expect(
      reopenPharmacyDayForTrading(
        scoped,
        scope,
        { businessDate: date, closeId: 'close-1', reason: 'Why' },
        lateEvening
      )
    ).rejects.toMatchObject({ reason: 'DAY_NOT_CLOSED' });
    expect(db.pharmacyDayReopen.create).not.toHaveBeenCalled();
  });

  it('returns the recorded reopen on retry instead of writing a second one', async () => {
    const existing = { id: 'reopen-1', reason: 'Closed early' };
    const { db, scoped } = fixture({ id: 'close-1', sequence: 1, reopen: existing });
    await expect(
      reopenPharmacyDayForTrading(
        scoped,
        scope,
        { businessDate: date, closeId: 'close-1', reason: 'Again' },
        lateEvening
      )
    ).resolves.toBe(existing);
    expect(db.pharmacyDayReopen.create).not.toHaveBeenCalled();
  });

  it('refuses a stale reopen request after a newer close, without changing either report', async () => {
    const { db, scoped } = fixture({ id: 'close-2', sequence: 2, reopen: null });
    await expect(
      reopenPharmacyDayForTrading(
        scoped,
        scope,
        {
          businessDate: date,
          closeId: 'close-1',
          reason: 'Retry of the earlier reopen',
        },
        lateEvening
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.pharmacyDayReopen.create).not.toHaveBeenCalled();
    expect(db.pharmacyDailyClose.create).not.toHaveBeenCalled();
  });

  it('closes a reopened day again with a superseding report and no re-cut reason', async () => {
    const { db, scoped } = fixture({
      id: 'close-1',
      sequence: 1,
      reopen: { id: 'reopen-1', reason: 'Closed early' },
    });
    const preview = await readPharmacyClose(scoped, scope, date);
    await expect(
      closePharmacyDay(scoped, scope, {
        businessDate: date,
        sourceHash: preview.totals.sourceHash,
        counts: [],
        varianceNote: '',
      })
    ).resolves.toMatchObject({ id: 'close-2', sequence: 2, supersedesCloseId: 'close-1' });
    expect(db.pharmacyDailyClose.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a pre-reopen close retry even if no trading changed the totals', async () => {
    const { scoped: before } = fixture(null);
    const oldPreview = await readPharmacyClose(before, scope, date);
    const { db, scoped } = fixture({ id: 'close-1', sequence: 1, reopen: { id: 'reopen-1' } });
    await expect(
      closePharmacyDay(scoped, scope, {
        businessDate: date,
        sourceHash: oldPreview.totals.sourceHash,
        counts: [],
        varianceNote: '',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.pharmacyDailyClose.create).not.toHaveBeenCalled();
  });

  it('still requires a reason to re-cut a close that was not reopened', async () => {
    const { db, scoped } = fixture({ id: 'close-1', sequence: 1, reopen: null });
    await expect(
      cutPharmacyDailyClose(scoped, scope, { businessDate: date })
    ).rejects.toMatchObject({ reason: 'REOPEN_REASON_REQUIRED' });
    expect(db.pharmacyDailyClose.create).not.toHaveBeenCalled();
  });

  it('labels a close cut after a reopen as following it', async () => {
    const { db, scoped } = fixture({
      id: 'close-2',
      sequence: 2,
      supersedesCloseId: 'close-1',
      reopen: null,
    });
    db.pharmacyDayReopen.findFirst.mockResolvedValue({ id: 'reopen-1' });
    await expect(readPharmacyClose(scoped, scope, date)).resolves.toMatchObject({
      closeFollowsReopen: true,
    });
    expect(db.pharmacyDayReopen.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org', closeId: 'close-1' },
      select: { id: true },
    });
  });
});

describe('the counter refuses a bill or line on a closed day', () => {
  it("reads today's close in the workspace zone and refuses while it stands", async () => {
    const { db, scoped } = fixture({ id: 'close-1', sequence: 1, reopen: null });
    await expect(
      requirePharmacyTodayOpenForTrading(scoped, scope, lateEvening)
    ).rejects.toMatchObject({ reason: 'DAY_CLOSED' });
    expect(db.pharmacyDailyClose.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org', branchId: 'branch', businessDate: date },
      })
    );
  });

  it('admits a bill or line once the latest close is reopened', async () => {
    const { scoped } = fixture({ id: 'close-1', sequence: 1, reopen: { id: 'reopen-1' } });
    await expect(
      requirePharmacyTodayOpenForTrading(scoped, scope, lateEvening)
    ).resolves.toBeUndefined();
  });

  it('checks the new day after midnight in the workspace zone', async () => {
    const { db, scoped } = fixture(null);
    // 00:30 in Karachi on 2026-11-03.
    await requirePharmacyTodayOpenForTrading(scoped, scope, new Date('2026-11-02T19:30:00Z'));
    expect(db.pharmacyDailyClose.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ businessDate: new Date('2026-11-03T00:00:00Z') }),
      })
    );
  });
});
