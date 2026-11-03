import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { formatDisplayDateTime } from '@/lib/display-time';
import { explainGrossMargin, marginComparisonPeriods } from '@/lib/pharmacy/finance-reports';
import { MarginComparisonLedger, MarginComparisonSection } from './margin-comparison';

describe('gross-margin comparison UI', () => {
  it('renders reconciled money, UTC boundaries and evidence limits', () => {
    const report = {
      branchId: 'branch_1',
      timezone: 'UTC' as const,
      periods: marginComparisonPeriods(new Date('2026-09-01Z'), new Date('2026-09-03Z')),
      ...explainGrossMargin(undefined, {
        key: 'branch_1',
        revenueMinor: 12000,
        discountMinor: 1500,
        cogsMinor: 8000,
        grossMarginMinor: 2500,
      }),
    };
    const html = renderToStaticMarkup(<MarginComparisonLedger report={report} />);
    for (const text of [
      '25.00 (currency unknown)',
      formatDisplayDateTime(report.periods.previous.from),
      'includes its start time and stops just before its end time',
      'the previous period',
      'not a causal price/volume/mix',
      'missing evidence is not zero',
      'not net profit or contribution',
      'Percentage change is omitted',
      'overflow-x-auto',
    ])
      expect(html).toContain(text);
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).not.toContain('2026-08-30T00:00:00.000Z');
    expect(html).not.toMatch(/UTC\.?\s+UTC/);
  });
  it.each(['FORBIDDEN', 'INTERNAL_SERVER_ERROR'])(
    'shows %s without fabricated totals and preserves filters',
    async (code) => {
      const marginComparison = vi.fn().mockRejectedValue({ code });
      const element = await MarginComparisonSection({
        caller: { marginComparison } as unknown as Parameters<
          typeof MarginComparisonSection
        >[0]['caller'],
        branch: { id: 'branch_1', name: 'Main' },
        from: '2026-09-01',
        to: '2026-09-03',
      });
      const html = renderToStaticMarkup(element);
      expect(html).toContain('role="alert"');
      expect(html).toContain(
        code === 'FORBIDDEN' ? 'Permission required' : 'Comparison unavailable'
      );
      expect(html).not.toContain('0.00 (currency unknown)');
      expect(html).toContain('name="marginFrom"');
      expect(html).toContain('value="2026-09-01"');
      expect(html).toContain('value="branch_1"');
      expect(marginComparison).toHaveBeenCalledWith({
        branchId: 'branch_1',
        from: '2026-09-01T00:00:00Z',
        to: '2026-09-03T00:00:00Z',
      });
    }
  );
});
