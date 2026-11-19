/**
 * DEV-958A: changing a branch's day-end hour never re-reads a past day. Days are closed at
 * midnight up to 19 Nov, then the owner moves the day end to 05:00 (in force from 20 Nov). Every
 * report window for the days before reads exactly what it read before the change; the reported
 * repro (lost sales for 9 and 10 Nov, the cash-close check's voids) included.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { pharmacyBusinessDayRange, pharmacyDayEndField } from './business-day';
import { pharmacyCashCloseDayBounds } from './cash-close-day';
import { readLostSalesRecovery } from './lost-sales-recovery-report';
import { ownerBriefingWindow } from './owner-briefing';

const KARACHI = 'Asia/Karachi';
const BEFORE: unknown[] = [];
const AFTER = [{ from: '2026-11-20', hour: 5, actorId: 'owner_1', at: '2026-11-18T18:30:00Z' }];

async function lostSalesWindow(dayEnd: unknown, from: string, to: string) {
  const findMany = vi.fn(async () => []);
  const db = {
    pharmacyBranch: { findMany: vi.fn(async () => []) },
    unfulfilledDemandEvent: { findMany },
    pharmacySaleLine: { findMany: vi.fn(async () => []) },
    pharmacyGoodsReceiptLine: { findMany: vi.fn(async () => []) },
    pharmacyBackInStockPolicy: { findFirst: vi.fn(async () => null) },
  } as unknown as ScopedDb;
  await readLostSalesRecovery(
    db,
    'org_a',
    { branchIds: ['branch_a'], from, to, ...pharmacyDayEndField(dayEnd) },
    KARACHI
  ).catch(() => undefined);
  return (findMany.mock.calls[0] as unknown as [{ where: { createdAt: unknown } }])[0].where
    .createdAt;
}

describe('DEV-958A past days read the same after the day-end hour changes', () => {
  it.each([
    ['2026-11-09', '2026-11-09'],
    ['2026-11-10', '2026-11-10'],
    ['2026-11-01', '2026-11-18'],
  ])('lost sales for %s to %s', async (from, to) => {
    const before = await lostSalesWindow(BEFORE, from, to);
    expect(await lostSalesWindow(AFTER, from, to)).toEqual(before);
    expect(before).toEqual({
      gte: pharmacyBusinessDayRange(from, from, { timeZone: KARACHI }).from,
      lt: pharmacyBusinessDayRange(to, to, { timeZone: KARACHI }).to,
    });
  });

  it("the cash-close check reads a past day's voids on that day's own window", () => {
    for (const day of ['2026-11-09', '2026-11-10', '2026-11-18'])
      expect(pharmacyCashCloseDayBounds(new Date(`${day}T00:00:00Z`), KARACHI, AFTER)).toEqual(
        pharmacyCashCloseDayBounds(new Date(`${day}T00:00:00Z`), KARACHI, BEFORE)
      );
    // The day after the change uses the new hour.
    expect(pharmacyCashCloseDayBounds(new Date('2026-11-21T00:00:00Z'), KARACHI, AFTER)).toEqual({
      start: new Date('2026-11-21T00:00:00.000Z'),
      end: new Date('2026-11-22T00:00:00.000Z'),
    });
  });

  it('the owner briefing for a past day and week', () => {
    for (const cadence of ['DAILY', 'WEEKLY'] as const)
      expect(
        ownerBriefingWindow('2026-11-18', cadence, undefined, KARACHI, pharmacyDayEndField(AFTER))
      ).toEqual(ownerBriefingWindow('2026-11-18', cadence, undefined, KARACHI));
  });

  it('a month report across the change is its days laid end to end', () => {
    const clock = { timeZone: KARACHI, dayEnd: AFTER };
    const month = pharmacyBusinessDayRange('2026-11-01', '2026-11-30', clock);
    expect(month.from).toEqual(pharmacyBusinessDayRange('2026-11-01', '2026-11-01', clock).from);
    expect(month.to).toEqual(pharmacyBusinessDayRange('2026-11-30', '2026-11-30', clock).to);
    // 30 days of 24 hours, plus the five hours the long day of 19 Nov adds.
    expect(month.to.getTime() - month.from.getTime()).toBe((30 * 24 + 5) * 3_600_000);
  });
});
