import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOST_DEMAND_TRIGGER_CONFIG,
  type LostDemandTrigger,
} from '@/lib/pharmacy/lost-demand-procurement';
import type { demandAggregate } from '@/lib/pharmacy/sales';
import { ObservedDemand } from './observed-demand';

const report: Awaited<ReturnType<typeof demandAggregate>> = {
  label: 'Estimate',
  method: 'Explicit POS-10 events grouped by requested item and cause',
  window: { from: new Date('2026-09-01Z'), to: new Date('2026-09-02Z') },
  exclusions: ['searches without an explicit event', 'abandoned carts'],
  confidence: 'observed-events-only',
  rows: [
    {
      requestedMedicineId: 'item-a',
      requestedText: 'never render free text',
      reason: 'STOCKOUT',
      _count: { _all: 2 },
      _sum: { quantity: 3, estimatedValueMinor: 500, estimatedMarginMinor: 50 },
    },
    {
      requestedMedicineId: null,
      requestedText: 'never render free text',
      reason: 'PRICE_REJECTED',
      _count: { _all: 1 },
      _sum: { quantity: 1, estimatedValueMinor: null, estimatedMarginMinor: null },
    },
  ],
};

describe('observed demand evidence', () => {
  const highValueReport = {
    ...report,
    rows: report.rows.map((row) => ({
      ...row,
      _sum: { ...row._sum, estimatedValueMinor: 1_500_000_000 },
    })),
  };
  const alerts = {
    at: new Date('2026-09-02Z'),
    config: DEFAULT_LOST_DEMAND_TRIGGER_CONFIG,
    walkOutRateEvaluated: false as const,
    alerts: [
      {
        scope: 'SKU' as const,
        key: 'item-a',
        medicineIds: ['item-a'],
        requests: 3,
        estimatedLossMinor: 1_500_000_000,
        fired: ['REQUESTS', 'ESTIMATED_LOSS'] as LostDemandTrigger[],
      },
    ],
  };

  it('renders valid monetary aggregates above the per-event database limit', () => {
    const html = renderToStaticMarkup(
      <ObservedDemand report={highValueReport} alerts={alerts} failed={false} selected financial />
    );
    expect(html).toContain('Recorded demand events');
    expect(html).toContain('Procurement review recommended');
    expect(html).toContain('estimated loss');
    expect(html).toContain('15000000.00');
  });

  it('never derives alerts from the selected-period report total', () => {
    const html = renderToStaticMarkup(
      <ObservedDemand report={highValueReport} failed={false} selected financial />
    );
    expect(html).not.toContain('Procurement review recommended');
  });

  it('hides financial-derived trigger output without financial permission', () => {
    const html = renderToStaticMarkup(
      <ObservedDemand
        report={highValueReport}
        alerts={alerts}
        failed={false}
        selected
        financial={false}
      />
    );
    expect(html).toContain('Procurement review recommended');
    expect(html).not.toContain('estimated loss');
    expect(html).not.toContain('estimated value');
    expect(html).not.toContain('15000000');
  });

  it('distinguishes observations, units, null estimates and exclusions', () => {
    const html = renderToStaticMarkup(
      <ObservedDemand report={report} failed={false} selected financial />
    );
    for (const value of [
      'Recorded demand events',
      'Stockout events',
      '3 requested units',
      '5.00 (currency unknown)',
      'estimated value unavailable',
      'not unique customers',
      'abandoned carts',
      'coverage is unknown',
      'not added across items',
    ]) {
      expect(html).toContain(value);
    }
    expect(html).not.toContain('never render free text');
  });
  it('withholds financial estimates without financial permission', () => {
    const html = renderToStaticMarkup(
      <ObservedDemand report={report} failed={false} selected financial={false} />
    );
    expect(html).not.toContain('5.00');
    expect(html).not.toContain('estimated value');
  });
  it('does not turn missing reads into zero observations', () => {
    const html = renderToStaticMarkup(<ObservedDemand report={null} failed selected financial />);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('Recorded demand events');
  });
});
