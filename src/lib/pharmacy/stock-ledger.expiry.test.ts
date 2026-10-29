import { describe, expect, it } from 'vitest';

import { expiryInstant } from './stock-ledger';

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
});
