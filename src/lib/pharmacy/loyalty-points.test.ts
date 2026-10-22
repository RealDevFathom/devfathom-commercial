import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  allocateNetPaid,
  expiryDate,
  planPointsExpiry,
  type PointsEntryKind,
  type PointsLedgerEntry,
} from './loyalty-points';

let sequence = 0;
function entry(
  kind: PointsEntryKind,
  points: number,
  occurredAt: string,
  extra: Partial<PointsLedgerEntry> = {}
): PointsLedgerEntry {
  sequence += 1;
  return {
    id: extra.id ?? `${kind.toLowerCase()}-${sequence}`,
    kind,
    points,
    occurredAt: new Date(occurredAt),
    expiresAt: null,
    saleId: 'sale-0',
    tenderId: null,
    sourceEntryId: null,
    ...extra,
  };
}
const earn = (
  id: string,
  points: number,
  earnedAt: string,
  expiresAt: string | null,
  saleId = id
) =>
  entry('EARN', points, earnedAt, {
    id,
    saleId,
    expiresAt: expiresAt === null ? null : new Date(expiresAt),
  });
const redeem = (points: number, at: string, tenderId: string) =>
  entry('REDEEM', -points, at, { tenderId });
const balance = (entries: PointsLedgerEntry[], plan: { points: number }[]) =>
  [...entries, ...plan].reduce((sum, row) => sum + row.points, 0);

describe('pharmacy points expiry', () => {
  it('expires six calendar months after earning', () => {
    expect(expiryDate(new Date('2026-01-15T00:00:00Z'), 6).toISOString()).toBe(
      '2026-07-15T00:00:00.000Z'
    );
  });

  it('consumes earliest-expiring earns first and expires only the remainder', () => {
    const ledger = [
      earn('first', 100, '2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z'),
      earn('second', 200, '2026-01-15T00:00:00Z', '2026-07-15T00:00:00Z'),
      redeem(150, '2026-06-01T00:00:00Z', 'tender-1'),
    ];
    expect(planPointsExpiry(ledger, new Date('2026-08-01T00:00:00Z'))).toEqual([
      { sourceEntryId: 'second', saleId: 'second', points: -150, expiredTotal: 150 },
    ]);
  });

  it('returns a refunded redemption to the lots it spent, which keep their expiry', () => {
    const ledger = [
      earn('a', 100, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      earn('b', 100, '2026-01-02T00:00:00Z', '2026-08-01T00:00:00Z'),
      redeem(100, '2026-01-10T00:00:00Z', 'tender-1'), // spends lot a
      redeem(50, '2026-01-11T00:00:00Z', 'tender-2'), // spends half of lot b
      entry('REFUND', 100, '2026-03-01T00:00:00Z', { tenderId: 'tender-1' }),
    ];
    const at = new Date('2026-03-02T00:00:00Z');
    // The 100 restored points belong to lot a, which expired in February. Lot b is untouched.
    expect(planPointsExpiry(ledger, at)).toEqual([
      { sourceEntryId: 'a', saleId: 'a', points: -100, expiredTotal: 100 },
    ]);
    expect(balance(ledger, planPointsExpiry(ledger, at))).toBe(50);
  });

  it('expires a lot again after a later restoration, under a new running total', () => {
    const ledger = [
      earn('a', 100, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      redeem(60, '2026-01-10T00:00:00Z', 'tender-1'),
      entry('EXPIRE', -40, '2026-02-02T00:00:00Z', { sourceEntryId: 'a', saleId: 'a' }),
      entry('REFUND', 30, '2026-03-01T00:00:00Z', { tenderId: 'tender-1' }),
    ];
    expect(planPointsExpiry(ledger, new Date('2026-03-02T00:00:00Z'))).toEqual([
      { sourceEntryId: 'a', saleId: 'a', points: -30, expiredTotal: 70 },
    ]);
  });

  it('writes nothing twice: an expired lot already debited plans no second debit', () => {
    const ledger = [
      earn('a', 100, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      entry('EXPIRE', -100, '2026-02-02T00:00:00Z', { sourceEntryId: 'a', saleId: 'a' }),
    ];
    expect(planPointsExpiry(ledger, new Date('2026-06-01T00:00:00Z'))).toEqual([]);
  });

  it('counts a negative adjustment, so expiry never over-expires the remaining balance', () => {
    const ledger = [
      earn('a', 100, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      entry('ADJUST', -60, '2026-01-20T00:00:00Z'),
    ];
    const plan = planPointsExpiry(ledger, new Date('2026-03-01T00:00:00Z'));
    expect(plan).toEqual([{ sourceEntryId: 'a', saleId: 'a', points: -40, expiredTotal: 40 }]);
    expect(balance(ledger, plan)).toBe(0);
  });

  it('treats a positive adjustment as its own lot with its own expiry', () => {
    const ledger = [
      earn('a', 100, '2026-01-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      entry('ADJUST', 50, '2026-01-05T00:00:00Z', {
        id: 'goodwill',
        expiresAt: new Date('2026-02-01T00:00:00Z'),
      }),
    ];
    expect(planPointsExpiry(ledger, new Date('2026-03-01T00:00:00Z'))).toEqual([
      { sourceEntryId: 'goodwill', saleId: 'sale-0', points: -50, expiredTotal: 50 },
    ]);
  });

  it('debits an earn reversal from its own sale lot, not the earliest one', () => {
    const ledger = [
      earn('a', 100, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 'sale-a'),
      earn('b', 100, '2026-01-02T00:00:00Z', '2026-08-01T00:00:00Z', 'sale-b'),
      entry('EARN_REVERSAL', -100, '2026-01-20T00:00:00Z', { saleId: 'sale-b' }),
    ];
    expect(planPointsExpiry(ledger, new Date('2026-03-01T00:00:00Z'))).toEqual([
      { sourceEntryId: 'a', saleId: 'sale-a', points: -100, expiredTotal: 100 },
    ]);
  });

  it('debits a reversal from the lot it names', () => {
    const ledger = [
      earn('a', 100, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      earn('b', 100, '2026-01-02T00:00:00Z', '2026-02-15T00:00:00Z'),
      entry('REVERSAL', -100, '2026-01-20T00:00:00Z', { sourceEntryId: 'a', saleId: 'a' }),
    ];
    expect(planPointsExpiry(ledger, new Date('2026-03-01T00:00:00Z'))).toEqual([
      { sourceEntryId: 'b', saleId: 'b', points: -100, expiredTotal: 100 },
    ]);
  });

  it('never takes the balance below zero, and a later credit repays a debt first', () => {
    const negative = [
      earn('a', 100, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 'sale-a'),
      redeem(100, '2026-01-10T00:00:00Z', 'tender-1'),
      entry('EARN_REVERSAL', -50, '2026-01-20T00:00:00Z', { saleId: 'sale-a' }),
    ];
    expect(balance(negative, [])).toBe(-50);
    expect(planPointsExpiry(negative, new Date('2026-03-01T00:00:00Z'))).toEqual([]);

    const repaid = [
      ...negative,
      earn('c', 80, '2026-02-10T00:00:00Z', '2026-02-20T00:00:00Z', 'sale-c'),
    ];
    const plan = planPointsExpiry(repaid, new Date('2026-03-01T00:00:00Z'));
    expect(plan).toEqual([{ sourceEntryId: 'c', saleId: 'sale-c', points: -30, expiredTotal: 30 }]);
    expect(balance(repaid, plan)).toBe(0);
  });

  it('spends points due to expire before borrowing, so expiry cannot make it negative', () => {
    const ledger = [
      earn('a', 100, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 'sale-a'),
      earn('b', 50, '2026-01-02T00:00:00Z', '2026-08-01T00:00:00Z', 'sale-b'),
      redeem(50, '2026-01-10T00:00:00Z', 'tender-1'), // spends half of lot a
      // After lot a expired (no EXPIRE written yet), a reversal of lot b's sale beyond it.
      entry('EARN_REVERSAL', -100, '2026-02-10T00:00:00Z', { saleId: 'sale-b' }),
    ];
    const plan = planPointsExpiry(ledger, new Date('2026-03-01T00:00:00Z'));
    expect(balance(ledger, [])).toBe(0);
    expect(plan).toEqual([]);
    expect(balance(ledger, plan)).toBe(0);
  });

  it('leaves awards earned before expiry existed unexpired, and spends them last', () => {
    const ledger = [
      earn('legacy', 300, '2025-06-01T00:00:00Z', null),
      earn('a', 100, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      redeem(150, '2026-01-10T00:00:00Z', 'tender-1'),
    ];
    // The redemption spent all of lot a and 50 legacy points; nothing is left to expire.
    expect(planPointsExpiry(ledger, new Date('2027-01-01T00:00:00Z'))).toEqual([]);
  });

  it('lets a debit in the same instant as a credit spend older lots first', () => {
    const at = '2026-01-10T00:00:00Z';
    const ledger = [
      earn('a', 200, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      entry('REDEEM', -200, at, { id: 'r', tenderId: 'tender-1' }),
      earn('b', 30, at, '2026-07-10T00:00:00Z'),
    ];
    expect(planPointsExpiry(ledger, new Date('2026-03-01T00:00:00Z'))).toEqual([]);
  });

  it('allocates partial net paid without floating-point money', () => {
    expect(allocateNetPaid({ medicineMinor: 10_000, nonDrugMinor: 30_000 }, 20_000)).toEqual({
      medicineMinor: 5_000,
      nonDrugMinor: 15_000,
    });
  });
});
