import { describe, expect, it } from 'vitest';

import { blockReasonFor } from './inventory';
import { expiryInstant } from './stock-ledger';

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
