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

  it('preserves integer paisa and the capped paid total for uneven allocations', () => {
    for (let netPaidMinor = 1; netPaidMinor < 1_000; netPaidMinor += 17) {
      const result = allocateNetPaid(
        { medicineMinor: 101, nonDrugMinor: 203 },
        netPaidMinor
      );
      expect(Number.isSafeInteger(result.medicineMinor)).toBe(true);
      expect(Number.isSafeInteger(result.nonDrugMinor)).toBe(true);
      expect(result.medicineMinor + result.nonDrugMinor).toBe(
        Math.min(netPaidMinor, 304)
      );
      expect(result.medicineMinor).toBeGreaterThanOrEqual(0);
      expect(result.nonDrugMinor).toBeGreaterThanOrEqual(0);
    }
  });

  it.each([
    [{ medicineMinor: -1, nonDrugMinor: 1 }, 0],
    [{ medicineMinor: 1.1, nonDrugMinor: 1 }, 1],
    [{ medicineMinor: 1, nonDrugMinor: 1 }, -1],
  ])('rejects invalid integer-paisa allocation input', (subtotals, paid) => {
    expect(() => allocateNetPaid(subtotals, paid)).toThrow('INVALID_MONEY');
  });
});
