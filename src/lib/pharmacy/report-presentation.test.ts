import { describe, expect, it } from 'vitest';
import { reportDate, reportDayStart, reportLabel, reportMoney } from './report-presentation';

describe('pharmacy report presentation', () => {
  it('uses tenant currency without changing signed minor amounts', () => {
    expect(reportMoney(-22500, 'PKR')).toBe('PKR -225.00');
    expect(reportMoney(12345, 'USD')).toBe('USD 123.45');
    expect(reportMoney(12345, null)).toBe('Currency not configured 123.45');
    expect(reportMoney(null, 'PKR')).toBe('Unavailable');
    expect(reportMoney(NaN, 'PKR')).toContain('invalid');
    expect(reportMoney(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1), 'PKR')).toContain('bounds');
  });
  it('renders timestamps and selects midnight in the tenant timezone', () => {
    expect(reportDate('2026-11-02T21:30:00Z', 'Asia/Karachi')).toBe('3 Nov 2026, 02:30');
    expect(reportDayStart('2026-11-03', 'Asia/Karachi').toISOString()).toBe('2026-11-02T19:00:00.000Z');
    expect(reportDayStart('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(() => reportDayStart('2026-02-30', 'Asia/Karachi')).toThrow();
    expect(reportDate(null, 'Asia/Karachi')).toBe('Not recorded');
  });
  it('uses owner-facing account and source labels', () => {
    expect(reportLabel('PHARMACY_REFUND')).toBe('Refund');
    expect(reportLabel('CASH')).toBe('Cash');
    expect(reportLabel('COST_OF_GOODS_SOLD')).toBe('Cost of medicines sold');
  });
});
