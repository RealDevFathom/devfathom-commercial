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
    expect(cashVarianceLabel(-1234550, 'PKR')).toBe('PKR 12,345.50 short');
    expect(cashVarianceLabel(-100000, 'PKR')).toBe('PKR 1,000 short');
    expect(cashVarianceLabel(0, 'USD')).toBe('Balanced');
    expect(cashVarianceLabel(null, 'PKR')).toBe('—');
    expect(cashVarianceLabel(Number.NaN, 'PKR')).toBe('—');
    expect(cashVarianceLabel(-400, null)).toBe('4 (currency not confirmed) short');
  });
});
