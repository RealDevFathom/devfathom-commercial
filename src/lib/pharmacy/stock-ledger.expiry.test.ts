import { describe, expect, it } from 'vitest';

import { expiryInstant } from './stock-ledger';
import { blockReasonFor } from './inventory';

describe('expiryInstant', () => {
  it('expires a month-precision batch at Karachi midnight after the printed month', () => {
    expect(expiryInstant(new Date('2027-06-01T00:00:00.000Z'), 'MONTH')).toEqual(
      new Date('2027-06-30T19:00:00.000Z')
    );
  });

  it('expires a day-precision batch at Karachi midnight after the printed day', () => {
    expect(expiryInstant(new Date('2027-06-15T00:00:00.000Z'), 'DAY')).toEqual(
      new Date('2027-06-15T19:00:00.000Z')
    );
  });

  it.each([
    ['2028-02-01', 'MONTH', '2028-02-29T19:00:00.000Z'],
    ['2028-02-29', 'DAY', '2028-02-29T19:00:00.000Z'],
    ['2027-12-01', 'MONTH', '2027-12-31T19:00:00.000Z'],
    ['2027-12-31', 'DAY', '2027-12-31T19:00:00.000Z'],
  ] as const)('blocks %s (%s) at the exclusive expiry boundary', (printed, precision, expected) => {
    const expiresAt = expiryInstant(new Date(`${printed}T00:00:00.000Z`), precision);
    expect(expiresAt.toISOString()).toBe(expected);
    const candidate = {
      organizationId: 'org_a',
      branchId: 'branch_a',
      inventoryLotId: 'lot',
      stockLocationId: 'location',
      batchState: 'ACTIVE',
      disposition: 'AVAILABLE',
      receivedAt: new Date('2026-01-01T00:00:00.000Z'),
      availableUnits: 10,
      expiresAt,
    } as const;
    const scope = { organizationId: 'org_a', branchId: 'branch_a' };
    expect(
      blockReasonFor(candidate, { ...scope, at: new Date(expiresAt.getTime() - 1) })
    ).toBeNull();
    expect(blockReasonFor(candidate, { ...scope, at: expiresAt })).toBe('EXPIRED');
    expect(blockReasonFor(candidate, { ...scope, at: new Date(expiresAt.getTime() + 1) })).toBe(
      'EXPIRED'
    );
  });
});
