import { describe, expect, it } from 'vitest';
import {
  describePackConversion,
  isEffective,
  packConversions,
  type PackLevelNode,
} from './pack-conversion';

const AT = new Date('2026-06-01');
function level(
  id: string,
  kind: string,
  unitsPerParent: number,
  parentPackLevelId: string | null = null
): PackLevelNode {
  return {
    id,
    level: kind,
    unitsPerParent,
    parentPackLevelId,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
  };
}
const nodes = () => [
  level('carton', 'CARTON', 99),
  level('box', 'BOX', 5, 'carton'),
  level('strip', 'STRIP', 4, 'box'),
  level('unit', 'UNIT', 10, 'strip'),
];

describe('packConversions', () => {
  it('multiplies descendants through UNIT and ignores the selected pack multiplier', () => {
    expect(packConversions(nodes(), AT).map((row) => row.canonicalUnitsPerPack)).toEqual([
      200, 40, 10, 1,
    ]);
    expect(packConversions([level('unit', 'UNIT', 100)], AT)[0]!.canonicalUnitsPerPack).toBe(1);
  });
  it('converts a realistic strip root of 1 with ten UNIT children', () => {
    expect(
      packConversions([level('strip', 'STRIP', 1), level('unit', 'UNIT', 10, 'strip')], AT)[0]!
        .canonicalUnitsPerPack
    ).toBe(10);
  });
  it('fails closed without an explicit UNIT leaf', () => {
    expect(packConversions([level('strip', 'STRIP', 10)], AT)).toEqual([]);
  });
  it('rejects ambiguous branches regardless of insertion order', () => {
    const branched = [...nodes(), level('other-unit', 'UNIT', 5, 'strip')];
    for (const input of [branched, [...branched].reverse()]) {
      expect(packConversions(input, AT).map((row) => row.level)).toEqual(['UNIT', 'UNIT']);
    }
  });
  it('rejects cycles and UNIT nodes with descendants', () => {
    expect(packConversions([level('a', 'BOX', 2, 'b'), level('b', 'UNIT', 3, 'a')], AT)).toEqual(
      []
    );
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid descendant multiplier %s',
    (units) => {
      expect(
        packConversions(
          [level('strip', 'STRIP', 1), level('unit', 'UNIT', units, 'strip')],
          AT
        ).map((row) => row.packLevelId)
      ).toEqual(['unit']);
    }
  );
  it('rejects overflow in a descendant product', () => {
    const input = nodes();
    input[1]!.unitsPerParent = Number.MAX_SAFE_INTEGER;
    expect(packConversions(input, AT).some((row) => row.packLevelId === 'carton')).toBe(false);
  });
  it('uses only the effective revision, with an exclusive end boundary', () => {
    const old = { ...level('old', 'UNIT', 7, 'strip'), effectiveTo: AT };
    const current = { ...level('current', 'UNIT', 12, 'strip'), effectiveFrom: AT };
    const future = {
      ...level('future', 'UNIT', 14, 'strip'),
      effectiveFrom: new Date('2026-09-01'),
    };
    expect(isEffective(old, AT)).toBe(false);
    expect(isEffective(current, AT)).toBe(true);
    expect(
      packConversions([level('strip', 'STRIP', 1), old, current, future], AT)[0]!
        .canonicalUnitsPerPack
    ).toBe(12);
    expect(packConversions([level('strip', 'STRIP', 1), old, future], AT)).toEqual([]);
  });
});

describe('describePackConversion', () => {
  it('describes descendant counts consistently with canonical units', () => {
    const conversions = packConversions(nodes(), AT);
    expect(describePackConversion(conversions[0]!)).toBe(
      '1 CARTON = 5 BOXs = 20 STRIPs = 200 units'
    );
    expect(describePackConversion(conversions[2]!, 4)).toBe('4 STRIPs = 40 units');
    expect(describePackConversion(conversions[3]!, 2)).toBe('2 UNITs = 2 units');
  });
});
