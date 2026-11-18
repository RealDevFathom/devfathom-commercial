import { describe, expect, it } from 'vitest';
import {
  STAGED_COLUMN_HEADINGS,
  STAGED_LIST_INTRO,
  formatStagedPrice,
  formatStagedQuantity,
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
    expect(STAGED_LIST_INTRO).toMatch(/cannot be sold/);
  });
});
