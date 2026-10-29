import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
      visitId: 'visit-a',
      visitType: 'PARTIAL',
      outcome: 'WENT_ELSEWHERE',
      _count: { _all: 2 },
      _sum: {
        quantity: 3,
        requestedQty: 3,
        estimatedValueMinor: 500,
        estimatedMarginMinor: 50,
        estLossPkr: 5 as never,
        lossProbability: 1 as never,
      },
    },
    {
      requestedMedicineId: null,
      requestedText: 'never render free text',
      reason: 'PRICE_REJECTED',
      visitId: 'visit-b',
      visitType: 'WALK_OUT',
      outcome: 'UNKNOWN',
      _count: { _all: 1 },
      _sum: {
        quantity: 1,
        requestedQty: 1,
        estimatedValueMinor: null,
        estimatedMarginMinor: null,
        estLossPkr: null,
        lossProbability: null,
      },
    },
  ],
};

describe('observed demand evidence', () => {
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
      'Estimated lost sales (PKR)',
      'PARTIAL / WENT_ELSEWHERE',
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
