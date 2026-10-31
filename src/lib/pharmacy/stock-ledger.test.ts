import { describe, expect, it } from 'vitest';

import { blockReasonFor } from './inventory';
import { expiryInstant, normalizeExpiryBoundary } from './stock-ledger';

const SCOPE = {
  organizationId: 'org_a',
  branchId: 'branch_a',
  at: new Date('2027-06-30T19:00:00.000Z'), // 2027-07-01 00:00 PKT
};

describe('printed pharmacy expiry', () => {
  it('makes a month-precision pack unsaleable at Pakistan midnight after its printed month', () => {
    const expiresAt = expiryInstant(new Date('2027-06-01T00:00:00.000Z'), 'MONTH');

    expect(expiresAt.toISOString()).toBe('2027-06-30T19:00:00.000Z');
    expect(
      blockReasonFor(
        {
          inventoryLotId: 'lot_1',
          stockLocationId: 'loc_1',
          organizationId: 'org_a',
          branchId: 'branch_a',
          batchState: 'ACTIVE',
          disposition: 'AVAILABLE',
          expiresAt,
          receivedAt: new Date('2027-01-01T00:00:00.000Z'),
          availableUnits: 10,
        },
        SCOPE
      )
    ).toBe('EXPIRED');
  });

  it('uses the same Pakistan-local boundary for day-precision expiry', () => {
    expect(expiryInstant(new Date('2027-06-30T00:00:00.000Z'), 'DAY').toISOString()).toBe(
      '2027-06-30T19:00:00.000Z'
    );
  });
});

describe('stored pharmacy expiry boundaries', () => {
  it.each([
    ['2027-06-16T00:00:00.000Z', '2027-06-15T19:00:00.000Z'],
    ['2027-07-01T00:00:00.000Z', '2027-06-30T19:00:00.000Z'],
    ['2028-01-01T00:00:00.000Z', '2027-12-31T19:00:00.000Z'],
    ['2028-03-01T00:00:00.000Z', '2028-02-29T19:00:00.000Z'],
  ])('normalizes legacy %s exactly once to %s', (legacy, pkt) => {
    const stored = new Date(legacy);
    const normalized = normalizeExpiryBoundary(stored);
    expect(normalized).toEqual(new Date(pkt));
    expect(normalizeExpiryBoundary(normalized)).toEqual(new Date(pkt));
    expect(stored).toEqual(new Date(legacy));
  });

  it.each(['2027-06-30T19:00:00.000Z', '2027-07-01T00:00:00.001Z', '2027-07-01T12:00:00.000Z'])(
    'preserves nonlegacy instant %s exactly',
    (instant) => {
      expect(normalizeExpiryBoundary(new Date(instant))).toEqual(new Date(instant));
    }
  );
});
