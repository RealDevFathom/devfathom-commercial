import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      '30 Aug 2026, 12:00 AM UTC',
      'start inclusive, end exclusive',
      'the previous period',
      'not a causal price/volume/mix',
      'missing evidence is not zero',
      'not net profit or contribution',
      'Percentage change is omitted',
      'overflow-x-auto',
    ])
      expect(html).toContain(text);
    expect(html).not.toMatch(/NaN|Infinity/);
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

  describe('on the workspace clock (DEV-902)', () => {
    afterEach(() => vi.useRealTimers());
    const section = (marginComparison: ReturnType<typeof vi.fn>, dates: object = {}) =>
      MarginComparisonSection({
        caller: { marginComparison } as unknown as Parameters<
          typeof MarginComparisonSection
        >[0]['caller'],
        branch: { id: 'branch_1', name: 'Main' },
        timeZone: 'Asia/Karachi',
        ...dates,
      });

    it('splits picked days at the workspace midnight, not UTC midnight', async () => {
      const marginComparison = vi.fn().mockRejectedValue({ code: 'FORBIDDEN' });
      const html = renderToStaticMarkup(
        await section(marginComparison, { from: '2026-09-01', to: '2026-09-03' })
      );
      expect(marginComparison).toHaveBeenCalledWith({
        branchId: 'branch_1',
        from: '2026-08-31T19:00:00Z',
        to: '2026-09-02T19:00:00Z',
      });
      expect(html).toContain('Current start (PKT)');
      expect(html).toContain('Current end (PKT, exclusive)');
      expect(html).not.toContain('UTC');
    });

    it('ends the default period on the workspace today, so a 00:30 local sale is current', async () => {
      vi.useFakeTimers();
      // 00:30 on 18 Nov in Karachi; UTC is still on 17 Nov.
      vi.setSystemTime(new Date('2026-11-17T19:30:00Z'));
      const marginComparison = vi.fn().mockRejectedValue({ code: 'FORBIDDEN' });
      const html = renderToStaticMarkup(await section(marginComparison));
      expect(html).toContain('value="2026-11-18"');
      expect(html).toContain('value="2026-10-19"');
      expect(marginComparison).toHaveBeenCalledWith({
        branchId: 'branch_1',
        from: '2026-10-18T19:00:00Z',
        to: '2026-11-17T19:00:00Z',
      });
    });

    it('shows period boundaries in the workspace zone', () => {
      const report = {
        branchId: 'branch_1',
        timezone: 'UTC' as const,
        periods: marginComparisonPeriods(
          new Date('2026-08-31T19:00:00Z'),
          new Date('2026-09-02T19:00:00Z')
        ),
        ...explainGrossMargin(undefined, undefined),
      };
      const html = renderToStaticMarkup(
        <MarginComparisonLedger report={report} timeZone="Asia/Karachi" />
      );
      expect(html).toContain('Previous: 30 Aug 2026, 12:00 AM PKT to 1 Sep 2026, 12:00 AM PKT');
      expect(html).toContain('Current: 1 Sep 2026, 12:00 AM PKT to 3 Sep 2026, 12:00 AM PKT');
    });
  });
});
