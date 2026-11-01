import { describe, expect, it } from 'vitest';
import { packConversionLabel } from './pack-conversion-label';

describe('pack conversion labels', () => {
  it('renders a canonical one-unit pack without a redundant equation or plural', () => {
    expect(packConversionLabel('UNIT', [{ level: 'UNIT', unitsPerParent: 1 }], 1)).toBe('1 unit');
    expect(packConversionLabel('pack', [], 1)).toBe('1 unit');
  });

  it('retains conversion detail for packs containing multiple units', () => {
    expect(packConversionLabel('STRIP', [{ level: 'STRIP', unitsPerParent: 10 }], 10)).toBe(
      '1 STRIP = 10 units'
    );
  });
});
