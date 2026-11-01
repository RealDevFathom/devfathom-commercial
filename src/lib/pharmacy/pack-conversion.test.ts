import { describe, expect, it } from 'vitest';

import {
  describePackConversion,
  flatPackChain,
  isEffective,
  packConversions,
  splitPackTotal,
  type PackLevelNode,
} from './pack-conversion';

const AT = new Date('2026-06-01T00:00:00.000Z');

function level(overrides: Partial<PackLevelNode> & Pick<PackLevelNode, 'id'>): PackLevelNode {
  return {
    level: 'STRIP',
    unitsPerParent: 10,
    parentPackLevelId: null,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    ...overrides,
  };
}

describe('packConversions', () => {
  it('reads a leaf level as canonical base units per pack', () => {
    const [conversion] = packConversions([level({ id: 'strip' })], AT);
    expect(conversion).toMatchObject({ packLevelId: 'strip', canonicalUnitsPerPack: 10 });
    expect(conversion!.chain).toHaveLength(1);
  });

  it('multiplies down the hierarchy so an outer pack states base units, not child packs', () => {
    const conversions = packConversions(
      [
        level({ id: 'carton', level: 'CARTON', unitsPerParent: 5 }),
        level({ id: 'box', level: 'BOX', unitsPerParent: 4, parentPackLevelId: 'carton' }),
        level({ id: 'strip', level: 'STRIP', unitsPerParent: 10, parentPackLevelId: 'box' }),
      ],
      AT
    );
    const byId = Object.fromEntries(conversions.map((row) => [row.packLevelId, row]));
    expect(byId.strip!.canonicalUnitsPerPack).toBe(10);
    expect(byId.box!.canonicalUnitsPerPack).toBe(40);
    expect(byId.carton!.canonicalUnitsPerPack).toBe(200);
  });

  it('ignores a revision that has not started and one that has ended', () => {
    const conversions = packConversions(
      [
        level({
          id: 'v1',
          unitsPerParent: 10,
          effectiveTo: new Date('2026-03-01T00:00:00.000Z'),
        }),
        level({
          id: 'v2',
          unitsPerParent: 12,
          effectiveFrom: new Date('2026-03-01T00:00:00.000Z'),
        }),
        level({
          id: 'v3',
          unitsPerParent: 14,
          effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
        }),
      ],
      AT
    );
    expect(conversions.map((row) => row.packLevelId)).toEqual(['v2']);
    expect(conversions[0]!.canonicalUnitsPerPack).toBe(12);
  });

  it('does not descend through a superseded child', () => {
    const conversions = packConversions(
      [
        level({ id: 'box', level: 'BOX', unitsPerParent: 4 }),
        level({
          id: 'strip-old',
          level: 'STRIP',
          unitsPerParent: 10,
          parentPackLevelId: 'box',
          effectiveTo: new Date('2026-03-01T00:00:00.000Z'),
        }),
        level({
          id: 'strip-new',
          level: 'STRIP',
          unitsPerParent: 15,
          parentPackLevelId: 'box',
          effectiveFrom: new Date('2026-03-01T00:00:00.000Z'),
        }),
      ],
      AT
    );
    expect(conversions.find((row) => row.packLevelId === 'box')!.canonicalUnitsPerPack).toBe(60);
  });

  it('resolves a branch point deterministically rather than by insertion order', () => {
    const nodes = [
      level({ id: 'carton', level: 'CARTON', unitsPerParent: 2 }),
      level({ id: 'b', level: 'BOX', unitsPerParent: 7, parentPackLevelId: 'carton' }),
      level({ id: 'a', level: 'BOX', unitsPerParent: 3, parentPackLevelId: 'carton' }),
    ];
    const forward = packConversions(nodes, AT);
    const reversed = packConversions([...nodes].reverse(), AT);
    const carton = (rows: ReturnType<typeof packConversions>) =>
      rows.find((row) => row.packLevelId === 'carton')!.canonicalUnitsPerPack;
    expect(carton(forward)).toBe(carton(reversed));
    // (level, id) ordering picks 'a' over 'b', so 2 × 3 rather than 2 × 7.
    expect(carton(forward)).toBe(6);
  });

  it('terminates on a cyclic hierarchy instead of looping forever', () => {
    const conversions = packConversions(
      [
        level({ id: 'x', level: 'BOX', unitsPerParent: 2, parentPackLevelId: 'y' }),
        level({ id: 'y', level: 'CARTON', unitsPerParent: 3, parentPackLevelId: 'x' }),
      ],
      AT
    );
    expect(conversions).toHaveLength(2);
    for (const conversion of conversions) expect(conversion.canonicalUnitsPerPack).toBe(6);
  });
});

describe('isEffective', () => {
  it('treats the end of a window as exclusive so two versions never overlap', () => {
    const boundary = new Date('2026-03-01T00:00:00.000Z');
    expect(isEffective(level({ id: 'old', effectiveTo: boundary }), boundary)).toBe(false);
    expect(isEffective(level({ id: 'new', effectiveFrom: boundary }), boundary)).toBe(true);
  });
});

describe('describePackConversion', () => {
  it('states the whole chain for a nested pack', () => {
    const [carton] = packConversions(
      [
        level({ id: 'carton', level: 'CARTON', unitsPerParent: 5 }),
        level({ id: 'strip', level: 'STRIP', unitsPerParent: 10, parentPackLevelId: 'carton' }),
      ],
      AT
    ).filter((row) => row.packLevelId === 'carton');
    expect(describePackConversion(carton!)).toBe('1 CARTON = 5 STRIPs = 50 units');
    expect(describePackConversion(carton!, 3)).toBe('3 CARTONs = 15 STRIPs = 150 units');
  });

  it('states a leaf pack without an intermediate step', () => {
    const [strip] = packConversions([level({ id: 'strip' })], AT);
    expect(describePackConversion(strip!, 4)).toBe('4 STRIPs = 40 units');
  });
});

describe('splitPackTotal', () => {
  it('turns printed totals into per-level counts that keep the outer total', () => {
    expect(
      splitPackTotal({ level: 'BOX', totalUnits: 100 }, { level: 'STRIP', totalUnits: 10 })
    ).toEqual({ outerUnitsPerParent: 10, innerUnitsPerParent: 10 });
    expect(
      splitPackTotal({ level: 'STRIP', totalUnits: 10 }, { level: 'UNIT', totalUnits: 1 })
    ).toEqual({ outerUnitsPerParent: 10, innerUnitsPerParent: 1 });
  });

  it.each([
    [{ level: 'BOX', totalUnits: 100 }, { level: 'STRIP', totalUnits: 30 }, /whole number/],
    [{ level: 'BOX', totalUnits: 100 }, { level: 'STRIP', totalUnits: 100 }, /whole number/],
    [{ level: 'BOX', totalUnits: 100 }, { level: 'STRIP', totalUnits: 0 }, /positive whole/],
    [{ level: 'BOX', totalUnits: 100 }, { level: 'UNIT', totalUnits: 2 }, /exactly 1/],
    [{ level: 'STRIP', totalUnits: 100 }, { level: 'BOX', totalUnits: 10 }, /cannot be placed/],
  ])('refuses %o containing %o', (outer, inner, message) => {
    expect(splitPackTotal(outer, inner)).toEqual({ error: expect.stringMatching(message) });
  });

  it('builds a chain whose conversions equal the totals entered', () => {
    const box = level({ id: 'box', level: 'BOX', unitsPerParent: 100 });
    const first = splitPackTotal(
      { level: 'BOX', totalUnits: 100 },
      { level: 'STRIP', totalUnits: 10 }
    );
    if ('error' in first) throw new Error(first.error);
    const strip = level({
      id: 'strip',
      parentPackLevelId: 'box',
      unitsPerParent: first.innerUnitsPerParent,
    });
    const second = splitPackTotal(
      { level: 'STRIP', totalUnits: 10 },
      { level: 'UNIT', totalUnits: 1 }
    );
    if ('error' in second) throw new Error(second.error);
    const unit = level({
      id: 'unit',
      level: 'UNIT',
      parentPackLevelId: 'strip',
      unitsPerParent: 1,
    });
    const totals = packConversions(
      [
        { ...box, unitsPerParent: first.outerUnitsPerParent },
        { ...strip, unitsPerParent: second.outerUnitsPerParent },
        unit,
      ],
      AT
    ).map((entry) => [entry.level, entry.canonicalUnitsPerPack]);
    expect(totals).toEqual([
      ['BOX', 100],
      ['STRIP', 10],
      ['UNIT', 1],
    ]);
  });
});

describe('flatPackChain', () => {
  it('orders flat packs whose totals divide evenly from outermost to innermost', () => {
    const chain = flatPackChain(
      [
        level({ id: 'unit', level: 'UNIT', unitsPerParent: 1 }),
        level({ id: 'box', level: 'BOX', unitsPerParent: 100 }),
        level({ id: 'strip', level: 'STRIP', unitsPerParent: 10 }),
      ],
      AT
    );
    expect(chain?.map((item) => item.id)).toEqual(['box', 'strip', 'unit']);
  });

  it('refuses flat totals that do not divide evenly', () => {
    expect(
      flatPackChain(
        [
          level({ id: 'box', level: 'BOX', unitsPerParent: 100 }),
          level({ id: 'strip', level: 'STRIP', unitsPerParent: 30 }),
        ],
        AT
      )
    ).toBeNull();
  });

  it('ignores packs that are not effective and declines nested hierarchies', () => {
    expect(
      flatPackChain(
        [
          level({ id: 'box', level: 'BOX', unitsPerParent: 100 }),
          level({
            id: 'old',
            unitsPerParent: 30,
            effectiveTo: new Date('2026-02-01T00:00:00.000Z'),
          }),
        ],
        AT
      )?.map((item) => item.id)
    ).toEqual(['box']);
    expect(
      flatPackChain(
        [
          level({ id: 'box', level: 'BOX', unitsPerParent: 10 }),
          level({ id: 'strip', parentPackLevelId: 'box' }),
        ],
        AT
      )
    ).toBeNull();
  });
});
