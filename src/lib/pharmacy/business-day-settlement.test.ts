/**
 * DEV-958A: the server's money checks book on the branch's business day, which ends at its
 * "day ends at" hour. A sale at 00:30 at a branch whose day ends at 05:00 books on the day
 * before, in the drawer opened that day; with the default (midnight) nothing changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@/server/audit', () => audit);

import { currentPharmacyBusinessDate, readPharmacyReportDayEndHour } from './business-day-clock';
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
        businessDayEndsAtHour: hour,
        businessDayEndsAtRevision: 3,
      })),
      findMany: vi.fn(async () => [{ businessDayEndsAtHour: hour }]),
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
      select: { businessDayEndsAtHour: true },
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
    await expect(readPharmacyReportDayEndHour(missing, 'org_a', [])).resolves.toEqual({
      dayEndsAtHour: 0,
      mixed: false,
    });
  });
});

describe('DEV-958A changing when a branch day ends', () => {
  it('reads the hour, the business day it gives and the open drawers', async () => {
    await expect(readPharmacyDayEndHourSetting(db(5), SCOPE, AT_0030)).resolves.toEqual({
      branchId: 'branch_a',
      dayEndsAtHour: 5,
      revision: 3,
      timeZone: 'Asia/Karachi',
      currentBusinessDay: '2026-11-01',
      openDrawers: 0,
    });
  });

  it('saves on the revision, under both days locks, and audits before and after', async () => {
    const target = db(0);
    await expect(
      savePharmacyDayEndHour(
        target,
        SCOPE,
        { revision: 3, dayEndsAtHour: 5 },
        { id: 'owner_1', name: 'Owner', role: 'ADMIN' },
        AT_0030
      )
    ).resolves.toEqual({ branchId: 'branch_a', dayEndsAtHour: 5, revision: 4 });
    expect(target.pharmacyBranch.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        id: 'branch_a',
        active: true,
        businessDayEndsAtRevision: 3,
      },
      data: { businessDayEndsAtHour: 5, businessDayEndsAtRevision: { increment: 1 } },
    });
    // Today under the old hour (2 Nov) and under the new one (1 Nov), in one order.
    expect(lockedDays(target)).toEqual(['2026-11-01', '2026-11-02']);
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_a',
        actorId: 'owner_1',
        action: PHARMACY_DAY_END_HOUR_SET_ACTION,
        targetType: 'PharmacyBranch',
        targetId: 'branch_a',
        changes: { businessDayEndsAtHour: { before: 0, after: 5 } },
        metadata: { revision: 4 },
      }),
      target
    );
  });

  it('refuses while a drawer is open, writing nothing', async () => {
    const target = db(0, { pharmacyDrawerSession: { count: vi.fn(async () => 1) } });
    await expect(
      savePharmacyDayEndHour(target, SCOPE, { revision: 3, dayEndsAtHour: 5 }, { id: 'owner_1' })
    ).rejects.toEqual(new PharmacyDayEndHourError('DRAWERS_OPEN'));
    expect(target.pharmacyBranch.updateMany).not.toHaveBeenCalled();
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });

  it('refuses a stale revision and an hour a branch cannot store', async () => {
    const stale = db(0);
    await expect(
      savePharmacyDayEndHour(stale, SCOPE, { revision: 2, dayEndsAtHour: 5 }, { id: 'owner_1' })
    ).rejects.toEqual(new PharmacyDayEndHourError('REVISION_CONFLICT'));
    const raced = db(0, {
      pharmacyBranch: {
        findFirst: vi.fn(async () => ({
          id: 'branch_a',
          name: 'Main',
          businessDayEndsAtHour: 0,
          businessDayEndsAtRevision: 3,
        })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    });
    await expect(
      savePharmacyDayEndHour(raced, SCOPE, { revision: 3, dayEndsAtHour: 5 }, { id: 'owner_1' })
    ).rejects.toEqual(new PharmacyDayEndHourError('REVISION_CONFLICT'));
    for (const hour of [7, -1, 2.5])
      await expect(
        savePharmacyDayEndHour(db(0), SCOPE, { revision: 3, dayEndsAtHour: hour }, { id: 'o' })
      ).rejects.toThrow();
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });

  it('records nothing when the hour does not change', async () => {
    const target = db(5);
    await expect(
      savePharmacyDayEndHour(target, SCOPE, { revision: 3, dayEndsAtHour: 5 }, { id: 'owner_1' })
    ).resolves.toEqual({ branchId: 'branch_a', dayEndsAtHour: 5, revision: 3 });
    expect(target.pharmacyBranch.updateMany).not.toHaveBeenCalled();
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });
});
