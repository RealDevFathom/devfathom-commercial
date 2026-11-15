import { describe, expect, it } from 'vitest';

import type { PackLevelNode } from './counter-pricing';
import { baseUnitNoun, formatStockBreakdown, lotStockBreakdown } from './stock-breakdown';

const boxOfStrips = [
  { levelLabel: 'BOX', canonicalUnitsPerSaleUnit: 100 },
  { levelLabel: 'STRIP', canonicalUnitsPerSaleUnit: 10 },
  { levelLabel: 'UNIT', canonicalUnitsPerSaleUnit: 1 },
];

const hierarchy: PackLevelNode[] = [
  { id: 'box', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1 },
  { id: 'strip', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 10 },
  { id: 'tab', level: 'UNIT', parentPackLevelId: 'strip', unitsPerParent: 10 },
];

describe('formatStockBreakdown (DEV-727)', () => {
  it('shows 570 tablets as boxes + strips with the tablet total', () => {
    expect(formatStockBreakdown(570, boxOfStrips, 'Tablet')).toBe('5 boxes + 7 strips (570 tabs)');
  });

  it('keeps loose tablets and singular nouns', () => {
    expect(formatStockBreakdown(111, boxOfStrips, 'Film-coated tablet')).toBe(
      '1 box + 1 strip + 1 tab (111 tabs)'
    );
    expect(formatStockBreakdown(1_203, boxOfStrips, 'Tablet')).toBe(
      '12 boxes + 3 tabs (1,203 tabs)'
    );
  });

  it('does not repeat a total that is smaller than any pack', () => {
    expect(formatStockBreakdown(7, boxOfStrips, 'Capsule')).toBe('7 caps');
    expect(formatStockBreakdown(0, boxOfStrips, 'Tablet')).toBe('0 tabs');
  });

  it('falls back to the canonical total without a resolvable hierarchy', () => {
    expect(formatStockBreakdown(570, [], 'Tablet')).toBe('570 tabs');
    expect(
      formatStockBreakdown(220, [{ levelLabel: 'Sachet', canonicalUnitsPerSaleUnit: 1 }])
    ).toBe('220 units');
  });

  it('names cartons and unknown levels readably', () => {
    expect(
      formatStockBreakdown(
        1_250,
        [
          { levelLabel: 'CARTON', canonicalUnitsPerSaleUnit: 1_000 },
          { levelLabel: 'BOTTLE', canonicalUnitsPerSaleUnit: 50 },
        ],
        'Syrup'
      )
    ).toBe('1 carton + 5 bottles (1,250 units)');
  });

  it('reads the base noun from the dosage form', () => {
    expect(baseUnitNoun('Tablet')).toEqual(['tab', 'tabs']);
    expect(baseUnitNoun('Caplet')).toEqual(['tab', 'tabs']);
    expect(baseUnitNoun('Hard capsule')).toEqual(['cap', 'caps']);
    expect(baseUnitNoun('Injection')).toEqual(['unit', 'units']);
    expect(baseUnitNoun(null)).toEqual(['unit', 'units']);
  });
});

describe('lotStockBreakdown (DEV-727)', () => {
  it('resolves a received lot hierarchy into boxes + strips', () => {
    expect(
      lotStockBreakdown({
        onHandUnits: 570,
        rootPackLevelId: 'box',
        unitsPerPack: 100,
        packLevels: hierarchy,
        dosageForm: 'Tablet',
      })
    ).toBe('5 boxes + 7 strips (570 tabs)');
  });

  it('falls back to the canonical total when the hierarchy disagrees with the lot', () => {
    expect(
      lotStockBreakdown({
        onHandUnits: 570,
        rootPackLevelId: 'box',
        unitsPerPack: 30,
        packLevels: hierarchy,
        dosageForm: 'Tablet',
      })
    ).toBe('570 tabs');
    expect(
      lotStockBreakdown({
        onHandUnits: 34,
        rootPackLevelId: undefined,
        unitsPerPack: 10,
        packLevels: undefined,
      })
    ).toBe('34 units');
  });
});
