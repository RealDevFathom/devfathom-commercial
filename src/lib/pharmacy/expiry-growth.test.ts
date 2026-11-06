import { describe, expect, it } from 'vitest';

import { expiryRiskBuckets, maySuggestExpiryMarkdown, supplierReturnDates } from './expiry-growth';

describe('expiry growth recovery facts', () => {
  it('matches cumulative 30/60/90 PKR-at-risk fixture totals', () => {
    expect(
      expiryRiskBuckets([
        { daysLeft: 12, valueAtRiskMinor: 125_000 },
        { daysLeft: 45, valueAtRiskMinor: 75_000 },
        { daysLeft: 80, valueAtRiskMinor: 50_000 },
        { daysLeft: 120, valueAtRiskMinor: 999_999 },
      ])
    ).toEqual([
      { days: 30, valueAtRiskMinor: 125_000 },
      { days: 60, valueAtRiskMinor: 200_000 },
      { days: 90, valueAtRiskMinor: 250_000 },
    ]);
  });

  it('derives the distributor window from its configured days and never invents one', () => {
    const expiry = new Date('2026-12-31T00:00:00.000Z');
    expect(supplierReturnDates(expiry, 30)).toEqual({
      opensAt: new Date('2026-12-01T00:00:00.000Z'),
      deadlineAt: expiry,
    });
    expect(supplierReturnDates(expiry, null)).toBeNull();
  });

  it('excludes expired positions, including a just-expired lot rounded up to zero days', () => {
    expect(
      expiryRiskBuckets([
        { daysLeft: -1, valueAtRiskMinor: 100_000 },
        { daysLeft: 0, valueAtRiskMinor: 50_000 },
        { daysLeft: 1, valueAtRiskMinor: 25_000 },
      ])
    ).toEqual([
      { days: 30, valueAtRiskMinor: 25_000 },
      { days: 60, valueAtRiskMinor: 25_000 },
      { days: 90, valueAtRiskMinor: 25_000 },
    ]);
  });

  it('never suggests a markdown for Rx/restricted/controlled stock', () => {
    const base = { otc: true, productFamily: 'PHARMACEUTICAL' };
    expect(
      maySuggestExpiryMarkdown({ ...base, rx: true, restricted: false, controlled: false })
    ).toBe(false);
    expect(
      maySuggestExpiryMarkdown({ ...base, rx: false, restricted: true, controlled: false })
    ).toBe(false);
    expect(
      maySuggestExpiryMarkdown({ ...base, rx: false, restricted: false, controlled: true })
    ).toBe(false);
    expect(
      maySuggestExpiryMarkdown({ ...base, rx: false, restricted: false, controlled: false })
    ).toBe(true);
  });
});
