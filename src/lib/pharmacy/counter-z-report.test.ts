import { describe, it, expect, vi } from 'vitest';
import { buildCounterBrowserZReport, printCounterBrowserZReport } from './counter-browser-print';
const report = {
  id: 'close-1',
  branchName: '<script>private</script>',
  businessDate: '2026-09-29',
  currency: 'USD',
  sequence: 1,
  grossSalesMinor: 2500,
  refundTotalMinor: 0,
  netSalesMinor: 2500,
  cashExpectedMinor: 12500,
  cashCountedMinor: 12400,
  cashVarianceMinor: -100,
  reason: '<img onerror=alert(1)>',
  isFinal: true,
};
describe('Z report', () => {
  it('prints Raast, JazzCash and Easypaisa separately from cash from recorded close totals', () => {
    const html = buildCounterBrowserZReport({ ...report, tenderTotals: [
      { type: 'CASH', amountMinor: 500, refundMinor: 0, netMinor: 500 },
      { type: 'RAAST', amountMinor: 1000, refundMinor: 100, netMinor: 900 },
      { type: 'JAZZCASH', amountMinor: 2000, refundMinor: 0, netMinor: 2000 },
      { type: 'EASYPAISA', amountMinor: 3000, refundMinor: 0, netMinor: 3000 },
    ] }, 'en');
    expect(html).toContain('CASH: 5.00');
    expect(html).toContain('RAAST: 10.00');
    expect(html).toContain('JAZZCASH: 20.00');
    expect(html).toContain('EASYPAISA: 30.00');
  });
  it('prints escaped recorded totals and variance, separate from a sale receipt', () => {
    const html = buildCounterBrowserZReport(report, 'en');
    expect(html).toContain('USD');
    expect(html).toContain('Expected cash: 125.00');
    expect(html).not.toContain('PKR');
    expect(html).toContain('Variance: -1.00');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });
  it('supports Urdu and labels a provisional report honestly', () => {
    const html = buildCounterBrowserZReport({ ...report, isFinal: false }, 'ur');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('متوقع نقد');
    expect(html).toContain('Provisional');
  });
  it('prints Urdu Z-report amounts in Urdu digits', () => {
    const html = buildCounterBrowserZReport(report, 'ur');
    expect(html).toContain('متوقع نقد: ۱۲۵٫۰۰');
    expect(html).toContain('فرق: -۱٫۰۰');
    expect(html).not.toContain('125.00');
  });
  it('prints Urdu tender totals in Urdu digits', () => {
    const html = buildCounterBrowserZReport(
      {
        ...report,
        tenderTotals: [{ type: 'RAAST', amountMinor: 1000, refundMinor: 100, netMinor: 900 }],
      },
      'ur'
    );
    expect(html).toContain('RAAST: ۱۰٫۰۰ · واپسی: ۱٫۰۰ · خالص: ۹٫۰۰');
    expect(html).not.toContain('10.00');
  });
  it('refuses invalid amounts', () => {
    expect(() => buildCounterBrowserZReport({ ...report, cashCountedMinor: NaN }, 'en')).toThrow();
  });
  it('reports a blocked popup without claiming printing', () => {
    vi.stubGlobal('window', { open: vi.fn(() => null) });
    expect(() => printCounterBrowserZReport(report, 'en')).toThrow('Allow pop-ups');
    vi.unstubAllGlobals();
  });
});
