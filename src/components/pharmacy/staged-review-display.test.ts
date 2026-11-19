import { describe, expect, it } from 'vitest';
import {
  STAGED_COLUMN_HEADINGS,
  stagedListIntro,
  plainExceptionStatus,
  plainReviewFlag,
  plainSeverity,
  STAGED_PRICE_COLUMN_NOTE,
  formatStagedPrice,
  formatStagedQuantity,
  formatStagedQuantityReview,
  plainBatchStatus,
  plainExceptionLabel,
} from './staged-review-display';

describe('staged review display helpers', () => {
  it('shows prices to two decimals', () => {
    expect(formatStagedPrice('1944.0000000000000')).toBe('1944.00');
    expect(formatStagedPrice('12.5')).toBe('12.50');
    expect(formatStagedPrice(null)).toBe('Not supplied as text');
    expect(formatStagedPrice('n/a')).toBe('n/a');
  });
  it('drops trailing zeros from quantities', () => {
    expect(formatStagedQuantity('1.0000')).toBe('1');
    expect(formatStagedQuantity('2.5000')).toBe('2.5');
    expect(formatStagedQuantity('100')).toBe('100');
    expect(formatStagedQuantity('10.0')).toBe('10');
  });
  it('uses plain headings and codes-free wording', () => {
    expect(STAGED_COLUMN_HEADINGS).toEqual(
      expect.arrayContaining(['MRP', 'Purchase price (from distributor)', 'Quantity in old system'])
    );
    expect(STAGED_COLUMN_HEADINGS.join(' ')).not.toMatch(/source|saleprice|purprice/i);
    expect(plainExceptionLabel('MISSING_BATCH')).toBe('No batch or expiry recorded');
    expect(plainExceptionLabel('EXPIRED_STOCK')).toBe('Expiry has passed');
    expect(stagedListIntro(true)).toMatch(/cannot be sold/);
    expect(stagedListIntro(true)).toMatch(/Create medicines/);
    expect(stagedListIntro(true)).not.toMatch(/not available on this screen/);
    expect(stagedListIntro(false)).not.toMatch(/Create medicines/);
    expect(stagedListIntro(false)).toMatch(/catalogue editor or reviewer/);
    expect(plainSeverity('BLOCKING')).toBe('Needs your attention');
    expect(plainSeverity('WARNING')).toBe('Information only');
    expect(plainExceptionStatus('SIGNED_OFF')).toBe('Signed off');
    expect(plainExceptionStatus('OPEN')).toBe('Open');
    expect(plainReviewFlag('NORMALIZED_NAME_COLLISION_NO_MERGE')).toMatch(/kept separate/);
    expect(STAGED_PRICE_COLUMN_NOTE.saleprice).toMatch(/MRP/);
    expect(STAGED_PRICE_COLUMN_NOTE.purprice).toMatch(/distributor/);
  });
  it('shows the counted quantity in plain words without trailing zeros', () => {
    const base = {
      unit: null,
      packs: null,
      units: '29',
      unitsPerPack: null,
      label: '29 (staged as raw count)',
    } as const;
    expect(formatStagedQuantityReview(base)).toBe('29 (unit not chosen yet)');
    expect(formatStagedQuantityReview({ ...base, unit: 'UNITS' })).toBe('29 units');
    expect(
      formatStagedQuantityReview({
        unit: 'PACKS',
        packs: '2.5000',
        units: '25.0000',
        unitsPerPack: '10.0000',
        label: 'x',
      })
    ).toBe('2.5 packs × 10 = 25 units');
    expect(formatStagedQuantityReview({ ...base, units: null, label: null })).toBeNull();
    expect(
      formatStagedQuantityReview({ ...base, units: null, label: 'Unresolved: "2.50" units' })
    ).toBe('Unresolved: "2.5" units');
  });
  it('uses plain words for batch status codes', () => {
    expect(plainBatchStatus('PROFILED')).toBe('Ready to review');
    expect(plainBatchStatus('PROFILING')).toBe('Being read');
    expect(plainBatchStatus('FAILED')).toBe('Could not be read');
    expect(plainBatchStatus('SOMETHING')).not.toMatch(/[A-Z]{4}/);
  });
});
