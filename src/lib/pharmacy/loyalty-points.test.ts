import { describe, expect, it } from 'vitest';

import { allocateNetPaid, expiryDate, fifoExpiry } from './loyalty-points';

describe('pharmacy points expiry', () => {
  it('expires six calendar months after earning', () => {
    expect(expiryDate(new Date('2026-01-15T00:00:00Z'), 6).toISOString())
      .toBe('2026-07-15T00:00:00.000Z');
  });

  it('consumes earliest-expiring earns first and expires only the remainder', () => {
    const at = new Date('2026-08-01T00:00:00Z');
    expect(fifoExpiry([
      { id: 'first', points: 100, expiresAt: new Date('2026-07-01T00:00:00Z') },
      { id: 'second', points: 200, expiresAt: new Date('2026-07-15T00:00:00Z') },
    ], 150, at)).toEqual([{ sourceEntryId: 'second', points: -150 }]);
  });

  it('allocates partial net paid without floating-point money', () => {
    expect(allocateNetPaid({ medicineMinor: 10_000, nonDrugMinor: 30_000 }, 20_000))
      .toEqual({ medicineMinor: 5_000, nonDrugMinor: 15_000 });
  });
});
