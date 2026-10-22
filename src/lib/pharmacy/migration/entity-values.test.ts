import { describe, expect, it } from 'vitest';
import { parseImportExpiry, parsePackConversion, smallestUnitQuantity } from './entity-values';

describe('import entity normalization', () => {
  it('stores all quantities in the smallest unit through three pack levels', () => {
    expect(parsePackConversion('10x10')).toEqual({ unit: 1n, strip: 10n, box: 10n, smallestUnits: 100n });
    expect(smallestUnitQuantity(3, '10x10')).toBe(300n);
    expect(smallestUnitQuantity('2', 'pack_size 12')).toBe(24n);
  });

  it.each([
    ['02/27', '2027-02-28'],
    ['02/2028', '2028-02-29'],
    ['31-12-2027', '2027-12-31'],
    ['31/12/2027', '2027-12-31'],
    ['20271231', '2027-12-31'],
    [46752, '2027-12-31'],
  ])('parses expiry %j deterministically', (input, iso) => {
    expect(parseImportExpiry(input)?.toISOString().slice(0, 10)).toBe(iso);
  });

  it('rejects impossible dates and ambiguous packing', () => {
    expect(parseImportExpiry('31/02/2027')).toBeNull();
    expect(parsePackConversion('ten by ten')).toBeNull();
    for (const value of ['0', '-1', '+1', '1.5', '1 2', '999999999999999999999999999999']) expect(parsePackConversion(value)).toBeNull();
  });
});
