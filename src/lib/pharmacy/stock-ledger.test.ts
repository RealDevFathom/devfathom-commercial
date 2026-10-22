import { describe, expect, it } from 'vitest';

import { expiryInstant } from './stock-ledger';

describe('printed medicine expiry', () => {
  it('expires month-precision stock at midnight in Asia/Karachi after the printed month', () => {
    expect(expiryInstant(new Date('2027-06-15T00:00:00.000Z'), 'MONTH').toISOString()).toBe(
      '2027-06-30T19:00:00.000Z'
    );
  });

  it('expires day-precision stock at midnight in Asia/Karachi after the printed day', () => {
    expect(expiryInstant(new Date('2027-06-15T00:00:00.000Z'), 'DAY').toISOString()).toBe(
      '2027-06-15T19:00:00.000Z'
    );
  });
});
