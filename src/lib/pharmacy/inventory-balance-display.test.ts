import { describe, expect, it } from 'vitest';
import { inventoryBalanceDisplay } from './inventory-balance-display';

const box = { id: 'box', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1 };
const strip = { id: 'strip', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 10 };
const unit = { id: 'unit', level: 'UNIT', parentPackLevelId: 'strip', unitsPerParent: 10 };
const input = {
  onHandUnits: 570,
  sealedPacks: 5,
  looseUnits: 70,
  unitsPerPack: 100,
  packLevelId: 'box',
  packLevels: [box, strip, unit],
};

describe('inventory balance display', () => {
  it('retains custody evidence and labels the loose strip calculation as an equivalent', () => {
    expect(inventoryBalanceDisplay(input)).toBe(
      '5 sealed boxes + 70 loose units (7 strip equivalents + 0 units; 570 units total)'
    );
    expect(inventoryBalanceDisplay({ ...input, onHandUnits: 573, looseUnits: 73 })).toContain(
      '7 strip equivalents + 3 units'
    );
  });
  it('does not invent strips for a flat pack or ambiguous hierarchy', () => {
    expect(inventoryBalanceDisplay({ ...input, packLevels: [box] })).toBe(
      '570 units · 5 sealed + 70 loose'
    );
    expect(
      inventoryBalanceDisplay({
        ...input,
        packLevels: [box, strip, unit, { ...strip, id: 'other' }],
      })
    ).toBe('570 units · 5 sealed + 70 loose');
    expect(inventoryBalanceDisplay({ ...input, unitsPerPack: 90 })).toBe(
      '570 units · 5 sealed + 70 loose'
    );
  });
  it('does not relabel a received strip as a box', () => {
    expect(
      inventoryBalanceDisplay({
        onHandUnits: 34,
        sealedPacks: 3,
        looseUnits: 4,
        unitsPerPack: 10,
        packLevelId: 'strip',
        packLevels: [{ ...strip, parentPackLevelId: null, unitsPerParent: 10 }],
      })
    ).toBe('3 sealed strips + 4 loose units (34 units)');
  });
});
