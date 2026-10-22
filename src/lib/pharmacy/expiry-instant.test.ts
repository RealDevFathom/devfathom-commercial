import { describe, expect, it } from 'vitest';

import { expiryInstant } from './stock-ledger';

const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('#604 expiry boundary at local midnight', () => {
  it('ends 06/2027 at 00:00 Asia/Karachi on 1 July (2027-06-30T19:00Z)', () => {
    expect(expiryInstant(at('2027-06-01'), 'MONTH', 'Asia/Karachi').toISOString()).toBe(
      '2027-06-30T19:00:00.000Z'
    );
  });

  it('ends a day-precision expiry at 00:00 local after that day', () => {
    expect(expiryInstant(at('2027-06-15'), 'DAY', 'Asia/Karachi').toISOString()).toBe(
      '2027-06-15T19:00:00.000Z'
    );
    expect(expiryInstant(at('2027-12-31'), 'DAY', 'Asia/Karachi').toISOString()).toBe(
      '2027-12-31T19:00:00.000Z'
    );
  });

  it('rolls a December month expiry into the next year and honours other zones', () => {
    expect(expiryInstant(at('2027-12-01'), 'MONTH', 'Asia/Karachi').toISOString()).toBe(
      '2027-12-31T19:00:00.000Z'
    );
    // 14 March 2027 opens in EST; daylight time starts at 02:00 that day.
    expect(expiryInstant(at('2027-03-13'), 'DAY', 'America/New_York').toISOString()).toBe(
      '2027-03-14T05:00:00.000Z'
    );
    expect(expiryInstant(at('2027-06-01'), 'MONTH', 'Asia/Kolkata').toISOString()).toBe(
      '2027-06-30T18:30:00.000Z'
    );
  });

  it('stops sale before UTC midnight: the boundary precedes the old UTC instant', () => {
    const boundary = expiryInstant(at('2027-06-01'), 'MONTH', 'Asia/Karachi');
    const sellingAt = new Date('2027-06-30T20:00:00.000Z'); // 01:00 on 1 July in Karachi
    expect(boundary.getTime() <= sellingAt.getTime()).toBe(true);
  });

  it.each([undefined, null, '', 'UTC', 'Not/AZone'])('keeps UTC midnight for zone %j', (zone) => {
    expect(expiryInstant(at('2027-06-01'), 'MONTH', zone).toISOString()).toBe(
      '2027-07-01T00:00:00.000Z'
    );
  });
});
