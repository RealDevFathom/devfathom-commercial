import { describe, expect, it } from 'vitest';

import { formatOrderDateTime, formatOrderMoney } from './customer-order-format';

describe('customer order formatting', () => {
  it('formats money without Intl', () => {
    expect(formatOrderMoney(123456789, 'PKR')).toBe('PKR 1,234,567.89');
    expect(formatOrderMoney(5, 'PKR')).toBe('PKR 0.05');
    expect(formatOrderMoney(-250000, 'PKR')).toBe('-PKR 2,500.00');
  });

  it('formats Karachi time deterministically with a plain space', () => {
    expect(formatOrderDateTime(new Date('2026-11-02T18:08:26Z'))).toBe('2 Nov 2026, 11:08 pm');
    expect(formatOrderDateTime(new Date('2026-11-02T19:05:00Z'))).toBe('3 Nov 2026, 12:05 am');
    expect(formatOrderDateTime(new Date('2026-11-02T07:00:00Z'))).toBe('2 Nov 2026, 12:00 pm');
    expect(formatOrderDateTime('2026-11-02T00:30:00Z')).not.toMatch(/[  ]/);
  });
});

it('displays each workspace date when it is 00:30 in Karachi', () => {
  const at = new Date('2026-11-02T00:30:00+05:00');
  expect(formatOrderDateTime(at, 'Asia/Karachi')).toBe('2 Nov 2026, 12:30 am');
  expect(formatOrderDateTime(at, 'UTC')).toBe('1 Nov 2026, 7:30 pm');
});
