import { describe, expect, it } from 'vitest';
import { previousReportPeriod, reportPeriod } from './visual-report-period';

describe('visual report periods', () => {
  it.each([
    ['today', '2024-03-01', '2024-03-01'],
    ['yesterday', '2024-02-29', '2024-02-29'],
    ['week', '2024-02-26', '2024-03-01'],
    ['month', '2024-03-01', '2024-03-01'],
    ['lastMonth', '2024-02-01', '2024-02-29'],
    ['year', '2024-01-01', '2024-03-01'],
  ] as const)('%s uses the supplied branch business date', (preset, from, to) => {
    expect(reportPeriod(preset, '2024-03-01')).toEqual({ from, to });
  });
  it('compares with the immediately preceding equal number of business dates', () => {
    expect(previousReportPeriod({ from: '2024-03-01', to: '2024-03-02' })).toEqual({
      from: '2024-02-28',
      to: '2024-02-29',
    });
  });
  it('rejects inverted, impossible and unbounded custom periods', () => {
    for (const [from, to] of [
      ['2024-01-02', '2024-01-01'],
      ['2024-02-30', '2024-03-02'],
      ['2023-01-01', '2024-12-31'],
    ]) {
      expect(() => reportPeriod('custom', '2024-03-01', { from: from!, to: to! })).toThrow();
    }
  });
});
