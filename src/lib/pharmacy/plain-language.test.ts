import { describe, expect, it } from 'vitest';
import { cashVarianceLabel, formatShopPeriod, formatShopTime } from './plain-language';

describe('shop report presentation', () => {
  it('uses the PKT day at midnight and keeps earlier dates readable with their year', () => {
    const now = new Date('2026-11-14T20:00:00Z');
    expect(formatShopTime('2026-11-14T19:20:00Z', 'Asia/Karachi', now)).toBe('Today 12:20 AM PKT');
    expect(formatShopTime('2025-11-14T18:20:00Z', 'Asia/Karachi', now)).toBe(
      '14 Nov 2025, 11:20 PM PKT'
    );
    expect(formatShopTime('invalid', 'Asia/Karachi', now)).toBe('Unavailable');
    expect(formatShopTime(null, 'Asia/Karachi', now)).toBe('Unavailable');
  });

  it('preserves a configured workspace clock and labels calendar dates without shifting them', () => {
    expect(formatShopTime('2026-11-14T19:20:00Z', 'UTC', new Date('2026-11-14T20:00:00Z'))).toBe(
      'Today 7:20 PM UTC'
    );
    expect(formatShopPeriod('2026-10-28', '2026-11-03')).toBe('28 Oct – 3 Nov');
    expect(formatShopPeriod('2025-12-31', '2026-01-01')).toBe('31 Dec 2025 – 1 Jan 2026');
  });

  it('distinguishes short, over, balanced and missing cash without inventing currency', () => {
    expect(cashVarianceLabel(-400, 'PKR')).toBe('PKR 4 short');
    expect(cashVarianceLabel(425, 'PKR')).toBe('PKR 4.25 over');
    expect(cashVarianceLabel(0, 'USD')).toBe('Balanced');
    expect(cashVarianceLabel(null, 'PKR')).toBe('—');
    expect(cashVarianceLabel(Number.NaN, 'PKR')).toBe('—');
    expect(cashVarianceLabel(-400, null)).toBe('4 (currency not confirmed) short');
  });
});

import { describeCashVariance, formatDateRange, formatPktTime } from './plain-language';

describe('plain-language helpers', () => {
  const now = new Date('2026-11-03T14:00:00Z'); // 7:00 PM PKT
  it('formats times in Pakistan time', () => {
    expect(formatPktTime('2026-11-03T13:20:00Z', now)).toBe('Today 6:20 PM');
    expect(formatPktTime('2026-11-02T04:05:00Z', now)).toBe('Yesterday 9:05 AM');
    expect(formatPktTime('2026-10-28T04:05:00Z', now)).toBe('28 Oct 9:05 AM');
    expect(formatPktTime('2027-11-03T04:05:00Z', now)).toBe('3 Nov 2027 9:05 AM');
    expect(formatPktTime('nope', now)).toBe('');
    expect(formatPktTime(null, now)).toBe('');
  });
  it('formats ranges', () => {
    expect(formatDateRange('2026-10-28', '2026-11-03')).toBe('28 Oct – 3 Nov');
    expect(formatDateRange('2026-11-03', '2026-11-03')).toBe('3 Nov');
  });
  it('describes cash variance', () => {
    const f = (m: number) => `PKR ${m / 100}`;
    expect(describeCashVariance(-400, f)).toEqual({ text: 'PKR 4 short', tone: 'short' });
    expect(describeCashVariance(400, f)).toEqual({ text: 'PKR 4 over', tone: 'over' });
    expect(describeCashVariance(0, f).text).toBe('Balanced');
    expect(describeCashVariance(null, f).tone).toBe('unknown');
  });
});
