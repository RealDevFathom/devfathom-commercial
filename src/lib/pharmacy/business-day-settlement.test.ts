/**
 * DEV-958A: the server's money checks book on the branch's business day, which ends at its
 * "day ends at" hour. A sale at 00:30 at a branch whose day ends at 05:00 books on the day
 * before, in the drawer opened that day; with the default (midnight) nothing changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@/server/audit', () => audit);

import { pharmacyBusinessDayRange } from './business-day';
import { currentPharmacyBusinessDate, readPharmacyDayClock } from './business-day-clock';
import {
  PHARMACY_DAY_END_HOUR_SET_ACTION,
  PharmacyDayEndHourError,
  readPharmacyDayEndHourSetting,
  savePharmacyDayEndHour,
} from './business-day-settings';
import { reopenPharmacyDayForTrading } from './day-close';
import {
  PharmacySettlementError,
  requireCurrentPharmacyBusinessDate,
  requirePharmacyTodayOpenForTrading,
  requireTodaysPharmacyDrawer,
} from './settlement';

const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'actor_a' };
// Karachi is UTC+5. Local times on the night of 1 to 2 Nov 2026.
const AT_2330 = new Date('2026-11-01T18:30:00.000Z');
const AT_0030 = new Date('2026-11-01T19:30:00.000Z');
const AT_0530 = new Date('2026-11-02T00:30:00.000Z');
const NOV_1 = new Date('2026-11-01T00:00:00.000Z');
const NOV_2 = new Date('2026-11-02T00:00:00.000Z');

function db(hour: number, extra: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn(async () => []),
    organization: { findUnique: vi.fn(async () => ({ timezone: 'Asia/Karachi' })) },
    pharmacyBranch: {
      findFirst: vi.fn(async () => ({
        id: 'branch_a',
        name: 'Main',
        businessDayEndsAtHistory: hour,
        businessDayEndsAtRevision: 3,
      })),
      findMany: vi.fn(async () => [{ businessDayEndsAtHistory: hour }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    pharmacyDailyClose: { findFirst: vi.fn(async () => null) },
    pharmacyDrawerSession: { count: vi.fn(async () => 0) },
    ...extra,
  } as unknown as ScopedDb;
}

/** The day keys of the advisory day locks a call took. */
function lockedDays(target: ScopedDb) {
  return vi
    .mocked(target.$queryRaw)
    .mock.calls.map(([query]) => (query as { values?: unknown[] }).values ?? [])
    .flat()
    .filter((value): value is string => typeof value === 'string' && /^org_a:branch_a:/.test(value))
    .map((value) => value.slice('org_a:branch_a:'.length));
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('DEV-958A the current business date on the branch clock', () => {
  it.each([
    [AT_2330, 0, NOV_1],
    [AT_0030, 0, NOV_2],
    [AT_0530, 0, NOV_2],
    [AT_2330, 5, NOV_1],
    [AT_0030, 5, NOV_1],
    [AT_0530, 5, NOV_2],
  ])('at %s with the day ending at %s:00 the current day is %s', async (at, hour, day) => {
    const target = db(hour);
    await expect(currentPharmacyBusinessDate(target, SCOPE, at)).resolves.toEqual(day);
    await expect(requireCurrentPharmacyBusinessDate(target, SCOPE, day, at)).resolves.toBe(
      undefined
    );
    const other = day.getTime() === NOV_1.getTime() ? NOV_2 : NOV_1;
    await expect(
      requireCurrentPharmacyBusinessDate(target, SCOPE, other, at)
    ).rejects.toMatchObject({ reason: 'BUSINESS_DATE_NOT_CURRENT' });
    expect(target.pharmacyBranch.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', id: 'branch_a' },
      select: { businessDayEndsAtHistory: true },
    });
  });

  it('takes a 00:30 bill at a 05:00 branch into the drawer opened the day before', async () => {
    const late = db(5);
    await expect(
      requireTodaysPharmacyDrawer(late, SCOPE, { businessDate: NOV_1 }, AT_0030)
    ).resolves.toBe(undefined);
    await expect(
      requireTodaysPharmacyDrawer(late, SCOPE, { businessDate: NOV_2 }, AT_0030)
    ).rejects.toMatchObject({ reason: 'DRAWER_FROM_EARLIER_DAY' });
    // At a midnight branch the same drawer is yesterday's: closed and reopened at midnight.
    await expect(
      requireTodaysPharmacyDrawer(db(0), SCOPE, { businessDate: NOV_1 }, AT_0030)
    ).rejects.toBeInstanceOf(PharmacySettlementError);
  });

  it('locks and checks the business day the 00:30 bill belongs to', async () => {
    const late = db(5);
    await requirePharmacyTodayOpenForTrading(late, SCOPE, AT_0030);
    expect(lockedDays(late)).toEqual(['2026-11-01']);
    const midnight = db(0);
    await requirePharmacyTodayOpenForTrading(midnight, SCOPE, AT_0030);
    expect(lockedDays(midnight)).toEqual(['2026-11-02']);
  });

  it('reopens only the current business day for trading', async () => {
    const close = { id: 'close_1', reopen: null };
    const late = db(5, { pharmacyDailyClose: { findFirst: vi.fn(async () => close) } });
    // 2 Nov is not today yet at 00:30 on a 05:00 branch: 1 Nov is.
    await expect(
      reopenPharmacyDayForTrading(
        late,
        SCOPE,
        { businessDate: NOV_2, closeId: 'close_1', reason: 'Late customer' },
        AT_0030
      )
    ).rejects.toMatchObject({ reason: 'REOPEN_NOT_TODAY' });
    await expect(
      reopenPharmacyDayForTrading(
        db(0),
        SCOPE,
        { businessDate: NOV_1, closeId: 'close_1', reason: 'Late customer' },
        AT_0030
      )
    ).rejects.toMatchObject({ reason: 'REOPEN_NOT_TODAY' });
  });

  it('a branch that cannot be read is on midnight', async () => {
    const missing = db(0, {
      pharmacyBranch: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    });
    await expect(currentPharmacyBusinessDate(missing, SCOPE, AT_0030)).resolves.toEqual(NOV_2);
  });
});

/** A branch whose stored history `history` starts as given; `updateMany` saves into it. */
function historyDb(history: unknown[]) {
  const branch = {
    id: 'branch_a',
    name: 'Main',
    businessDayEndsAtHistory: history,
    businessDayEndsAtRevision: 3,
  };
  const target = {
    organization: { findUnique: vi.fn(async () => ({ timezone: 'Asia/Karachi' })) },
    pharmacyBranch: {
      findFirst: vi.fn(async () => ({ ...branch })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        branch.businessDayEndsAtHistory = data.businessDayEndsAtHistory as unknown[];
        branch.businessDayEndsAtRevision += 1;
        return { count: 1 };
      }),
    },
  } as unknown as ScopedDb;
  return { target, branch };
}

// 23:30 on 18 Nov in Karachi: business day 18 Nov at a midnight branch.
const AT_18_2330 = new Date('2026-11-18T18:30:00.000Z');

describe('DEV-958A changing when a branch day ends', () => {
  it("reads today's hour, the business day and the first day a change would apply to", async () => {
    await expect(
      readPharmacyDayEndHourSetting(historyDb([]).target, SCOPE, AT_18_2330)
    ).resolves.toEqual({
      branchId: 'branch_a',
      dayEndsAtHour: 0,
      scheduledHour: 0,
      pendingChanges: [],
      revision: 3,
      timeZone: 'Asia/Karachi',
      currentBusinessDay: '2026-11-18',
      nextBusinessDay: '2026-11-19',
    });
  });

  it('on the changeover day, names the hour today ends at, and lists every change ahead', async () => {
    // Saved on 18 Nov: 19 Nov began at midnight and is the first day to end at 05:00; a later
    // change moves the end to 02:00 from the business day of 25 Nov.
    const history = [
      { from: '2026-11-20', hour: 5 },
      { from: '2026-11-26', hour: 2 },
    ];
    // 23:30 on 19 Nov in Karachi.
    const at = new Date('2026-11-19T18:30:00.000Z');
    await expect(
      readPharmacyDayEndHourSetting(historyDb(history).target, SCOPE, at)
    ).resolves.toMatchObject({
      dayEndsAtHour: 5,
      scheduledHour: 5,
      pendingChanges: [{ fromBusinessDay: '2026-11-25', hour: 2 }],
      currentBusinessDay: '2026-11-19',
      nextBusinessDay: '2026-11-20',
    });
    // The evening before, today still ends at midnight and both changes are ahead.
    await expect(
      readPharmacyDayEndHourSetting(historyDb(history).target, SCOPE, AT_18_2330)
    ).resolves.toMatchObject({
      dayEndsAtHour: 0,
      scheduledHour: 5,
      pendingChanges: [
        { fromBusinessDay: '2026-11-19', hour: 5 },
        { fromBusinessDay: '2026-11-25', hour: 2 },
      ],
    });
  });

  it('appends the change from the day after the next business day, on the revision, audited', async () => {
    const { target, branch } = historyDb([]);
    await expect(
      savePharmacyDayEndHour(
        target,
        SCOPE,
        { revision: 3, dayEndsAtHour: 5 },
        { id: 'owner_1', name: 'Owner', role: 'ADMIN' },
        AT_18_2330
      )
    ).resolves.toEqual({
      branchId: 'branch_a',
      dayEndsAtHour: 5,
      fromBusinessDay: '2026-11-19',
      revision: 4,
    });
    expect(target.pharmacyBranch.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        id: 'branch_a',
        active: true,
        businessDayEndsAtRevision: 3,
      },
      data: {
        businessDayEndsAtHistory: [
          { from: '2026-11-20', hour: 5, actorId: 'owner_1', at: '2026-11-18T18:30:00.000Z' },
        ],
        businessDayEndsAtRevision: { increment: 1 },
      },
    });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_a',
        actorId: 'owner_1',
        action: PHARMACY_DAY_END_HOUR_SET_ACTION,
        targetType: 'PharmacyBranch',
        targetId: 'branch_a',
        changes: {
          businessDayEndsAtHour: { before: 0, after: 5 },
          endsFromBusinessDay: '2026-11-19',
          startsFromBusinessDay: '2026-11-20',
        },
        metadata: { revision: 4 },
      }),
      target
    );
    // The change is pending: today is still on midnight, and a second read shows it.
    await expect(readPharmacyDayEndHourSetting(target, SCOPE, AT_18_2330)).resolves.toMatchObject({
      dayEndsAtHour: 0,
      scheduledHour: 5,
      pendingChanges: [{ fromBusinessDay: '2026-11-19', hour: 5 }],
      revision: 4,
    });
    expect(branch.businessDayEndsAtHistory).toHaveLength(1);
  });

  it('keeps every closed day, today included, exactly as it was', async () => {
    const { target } = historyDb([]);
    const before = await readPharmacyDayClock(target, SCOPE);
    const pastDays = Array.from({ length: 18 }, (_, index) =>
      new Date(Date.UTC(2026, 10, 1 + index)).toISOString().slice(0, 10)
    );
    const windows = (clock: Awaited<ReturnType<typeof readPharmacyDayClock>>) => [
      ...pastDays.map((day) => pharmacyBusinessDayRange(day, day, clock)),
      pharmacyBusinessDayRange('2026-11-01', '2026-11-18', clock),
    ];
    const read = windows(before);
    await savePharmacyDayEndHour(
      target,
      SCOPE,
      { revision: 3, dayEndsAtHour: 5 },
      { id: 'owner_1' },
      AT_18_2330
    );
    const after = await readPharmacyDayClock(target, SCOPE);
    // 1 to 18 Nov, closed at midnight, read the same; 19 Nov is the one longer day.
    expect(windows(after)).toEqual(read);
    expect(pharmacyBusinessDayRange('2026-11-19', '2026-11-19', after)).toEqual({
      from: new Date('2026-11-18T19:00:00.000Z'),
      to: new Date('2026-11-20T00:00:00.000Z'),
    });
    // Trading tonight stays on today: 23:59 is still 18 Nov, and the change reopens no day.
    await expect(
      currentPharmacyBusinessDate(target, SCOPE, new Date('2026-11-18T18:59:00.000Z'))
    ).resolves.toEqual(new Date('2026-11-18T00:00:00.000Z'));
    await expect(
      currentPharmacyBusinessDate(target, SCOPE, new Date('2026-11-18T19:30:00.000Z'))
    ).resolves.toEqual(new Date('2026-11-19T00:00:00.000Z'));
  });

  it('lowers the hour the same way: the next day is the one shorter day', async () => {
    // A branch on 05:00 since 1 Nov; at 02:00 on 19 Nov it is still business day 18 Nov.
    const { target } = historyDb([{ from: '2026-11-01', hour: 5 }]);
    const at = new Date('2026-11-18T21:00:00.000Z');
    await expect(
      savePharmacyDayEndHour(target, SCOPE, { revision: 3, dayEndsAtHour: 0 }, { id: 'o' }, at)
    ).resolves.toMatchObject({ fromBusinessDay: '2026-11-19' });
    const clock = await readPharmacyDayClock(target, SCOPE);
    expect(pharmacyBusinessDayRange('2026-11-18', '2026-11-18', clock)).toEqual({
      from: new Date('2026-11-18T00:00:00.000Z'),
      to: new Date('2026-11-19T00:00:00.000Z'),
    });
    expect(pharmacyBusinessDayRange('2026-11-19', '2026-11-19', clock)).toEqual({
      from: new Date('2026-11-19T00:00:00.000Z'),
      to: new Date('2026-11-19T19:00:00.000Z'),
    });
    await expect(currentPharmacyBusinessDate(target, SCOPE, at)).resolves.toEqual(
      new Date('2026-11-18T00:00:00.000Z')
    );
  });

  it('refuses a stale revision and an hour a branch cannot store', async () => {
    await expect(
      savePharmacyDayEndHour(
        historyDb([]).target,
        SCOPE,
        { revision: 2, dayEndsAtHour: 5 },
        {
          id: 'owner_1',
        }
      )
    ).rejects.toEqual(new PharmacyDayEndHourError('REVISION_CONFLICT'));
    const raced = historyDb([]);
    vi.mocked(raced.target.pharmacyBranch.updateMany).mockResolvedValueOnce({ count: 0 });
    await expect(
      savePharmacyDayEndHour(raced.target, SCOPE, { revision: 3, dayEndsAtHour: 5 }, { id: 'o' })
    ).rejects.toEqual(new PharmacyDayEndHourError('REVISION_CONFLICT'));
    for (const hour of [7, -1, 2.5])
      await expect(
        savePharmacyDayEndHour(
          historyDb([]).target,
          SCOPE,
          { revision: 3, dayEndsAtHour: hour },
          {
            id: 'o',
          }
        )
      ).rejects.toThrow();
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });

  it('records nothing when the hour already set does not change', async () => {
    const { target } = historyDb([{ from: '2026-11-20', hour: 5 }]);
    await expect(
      savePharmacyDayEndHour(
        target,
        SCOPE,
        { revision: 3, dayEndsAtHour: 5 },
        { id: 'o' },
        AT_18_2330
      )
    ).resolves.toEqual({
      branchId: 'branch_a',
      dayEndsAtHour: 5,
      fromBusinessDay: null,
      revision: 3,
    });
    expect(target.pharmacyBranch.updateMany).not.toHaveBeenCalled();
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });
});
