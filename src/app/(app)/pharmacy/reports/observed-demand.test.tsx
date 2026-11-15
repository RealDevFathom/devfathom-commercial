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
  it('distinguishes observations, units, null estimates and exclusions', () => {
    const html = renderToStaticMarkup(
      <ObservedDemand timeZone="UTC" report={report} failed={false} selected financial />
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
      <ObservedDemand timeZone="UTC" report={report} failed={false} selected financial={false} />
    );
    expect(html).not.toContain('5.00');
    expect(html).not.toContain('estimated value');
  });
  it('does not turn missing reads into zero observations', () => {
    const html = renderToStaticMarkup(
      <ObservedDemand timeZone="UTC" report={null} failed selected financial />
    );
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('Recorded demand events');
  });
  it('names the workspace dates the demand window covers, not the UTC dates', () => {
    const karachi = {
      ...report,
      // 9–15 November on the Karachi clock: 19:00 UTC on the 8th to 19:00 UTC on the 15th.
      window: {
        from: new Date('2026-11-08T19:00:00.000Z'),
        to: new Date('2026-11-15T19:00:00.000Z'),
      },
    };
    const html = renderToStaticMarkup(
      <ObservedDemand report={karachi} failed={false} selected financial timeZone="Asia/Karachi" />
    );
    expect(html).toContain('event dates 2026-11-09 to 2026-11-16 (end exclusive) in Asia/Karachi');
    expect(html).not.toContain('UTC event dates');
  });
});
