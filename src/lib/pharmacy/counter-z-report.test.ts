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
  it('refuses invalid amounts', () => {
    expect(() => buildCounterBrowserZReport({ ...report, cashCountedMinor: NaN }, 'en')).toThrow();
  });
  it('reports a blocked popup without claiming printing', () => {
    vi.stubGlobal('window', { open: vi.fn(() => null) });
    expect(() => printCounterBrowserZReport(report, 'en')).toThrow('Allow pop-ups');
    vi.unstubAllGlobals();
  });
});
