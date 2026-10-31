import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

const mocks = vi.hoisted(() => ({
  db: {} as Record<string, unknown>,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_organizationId: string, run: (db: unknown) => unknown) =>
    run(mocks.db)
  ),
}));

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import { computeRecipeCost, computeRecipeCostInDb, explodeRecipe } from './recipe-costing';

const D = (value: string | number) => new Prisma.Decimal(value);

type Version = {
  id: string;
  recipeId: string;
  status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';
  yieldQuantity: Prisma.Decimal | null;
  yieldUnitId: string | null;
  portionCount: number | null;
};

function makeDb(options: {
  versions: Version[];
  lines: Record<string, unknown[]>;
  conversions?: Record<string, string>;
  ingredients?: unknown[];
  movements?: unknown[];
}) {
  return {
    restaurantRecipe: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        options.versions.some((version) => version.recipeId === where.id) ? { id: where.id } : null
      ),
    },
    restaurantRecipeVersion: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        options.versions.find((version) => version.id === where.id)
      ),
      findMany: vi.fn(async ({ where }: { where: { recipeId: string } }) =>
        options.versions.filter((version) => version.recipeId === where.recipeId)
      ),
    },
    restaurantRecipeLine: {
      findMany: vi.fn(
        async ({ where }: { where: { recipeVersionId: string } }) =>
          options.lines[where.recipeVersionId] ?? []
      ),
    },
    restaurantUnitConversion: {
      findUnique: vi.fn(
        async ({ where }: { where: { fromUnitId_toUnitId: Record<string, string> } }) => {
          const { fromUnitId, toUnitId } = where.fromUnitId_toUnitId;
          const factor = options.conversions?.[`${fromUnitId}->${toUnitId}`];
          return factor ? { factor: D(factor) } : null;
        }
      ),
    },
    restaurantStockMovement: {
      findMany: vi.fn(async () => options.movements ?? []),
    },
    restaurantIngredient: {
      findMany: vi.fn(async () => options.ingredients ?? []),
    },
  };
}

const ingredientLine = (
  id: string,
  quantity: string,
  unitId: string,
  baseUnitId: string,
  stockItemId: string | null = null
) => ({
  id,
  quantity: D(quantity),
  unitId,
  ingredientId: id,
  subRecipeId: null,
  ingredient: {
    id,
    name: id,
    baseUnitId,
    stockItem: stockItemId ? { id: stockItemId } : null,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db = {};
});

describe('explodeRecipe', () => {
  it('scales portions, recursively expands active sub-recipes, converts, and aggregates', async () => {
    const versions: Version[] = [
      {
        id: 'v_main',
        recipeId: 'r_main',
        status: 'ACTIVE',
        yieldQuantity: D('10'),
        yieldUnitId: 'portion',
        portionCount: 10,
      },
      {
        id: 'v_sub',
        recipeId: 'r_sub',
        status: 'ACTIVE',
        yieldQuantity: D('2'),
        yieldUnitId: 'cup',
        portionCount: null,
      },
    ];
    mocks.db = makeDb({
      versions,
      conversions: { 'kg->g': '1000' },
      lines: {
        v_main: [
          ingredientLine('flour', '2', 'kg', 'g', 'stock_flour'),
          {
            id: 'sub_line',
            quantity: D('4'),
            unitId: 'cup',
            ingredientId: null,
            subRecipeId: 'r_sub',
            ingredient: null,
          },
        ],
        v_sub: [ingredientLine('flour', '3', 'g', 'g', 'stock_flour')],
      },
    });

    const result = await explodeRecipe({
      organizationId: 'org_1',
      recipeId: 'r_main',
      portions: D('20'),
    });

    expect(result.recipeVersionId).toBe('v_main');
    expect(result.ingredients).toHaveLength(1);
    expect(result.ingredients[0]?.quantityInBaseUnit.equals('4012')).toBe(true);
  });

  it('reports a self-reference before validating an absent yield', async () => {
    mocks.db = makeDb({
      versions: [
        {
          id: 'v_self',
          recipeId: 'r_self',
          status: 'ACTIVE',
          yieldQuantity: null,
          yieldUnitId: null,
          portionCount: null,
        },
      ],
      lines: {
        v_self: [{ quantity: D('1'), unitId: 'u', ingredientId: null, subRecipeId: 'r_self' }],
      },
    });
    await expect(
      explodeRecipe({ organizationId: 'org_1', recipeId: 'r_self' })
    ).rejects.toMatchObject({ message: 'Recipe cycle detected.', reason: 'CYCLE' });
  });

  it('reports an indirect cycle before validating missing sub-recipe yields', async () => {
    mocks.db = makeDb({
      versions: ['r1', 'r2'].map((recipeId, index) => ({
        id: `v${index + 1}`,
        recipeId,
        status: 'ACTIVE' as const,
        yieldQuantity: null,
        yieldUnitId: null,
        portionCount: null,
      })),
      lines: {
        v1: [{ quantity: D('1'), unitId: 'u', ingredientId: null, subRecipeId: 'r2' }],
        v2: [{ quantity: D('1'), unitId: 'u', ingredientId: null, subRecipeId: 'r1' }],
      },
    });
    await expect(explodeRecipe({ organizationId: 'org_1', recipeId: 'r1' })).rejects.toMatchObject({
      message: 'Recipe cycle detected.',
      reason: 'CYCLE',
    });
  });

  it('fails closed when a sub-recipe cycle is encountered', async () => {
    const versions: Version[] = [
      {
        id: 'v1',
        recipeId: 'r1',
        status: 'ACTIVE',
        yieldQuantity: D('1'),
        yieldUnitId: 'u',
        portionCount: null,
      },
      {
        id: 'v2',
        recipeId: 'r2',
        status: 'ACTIVE',
        yieldQuantity: D('1'),
        yieldUnitId: 'u',
        portionCount: null,
      },
    ];
    mocks.db = makeDb({
      versions,
      lines: {
        v1: [{ quantity: D('1'), unitId: 'u', ingredientId: null, subRecipeId: 'r2' }],
        v2: [{ quantity: D('1'), unitId: 'u', ingredientId: null, subRecipeId: 'r1' }],
      },
    });

    await expect(explodeRecipe({ organizationId: 'org_1', recipeId: 'r1' })).rejects.toMatchObject({
      reason: 'CYCLE',
    });
  });
});

describe('computeRecipeCost', () => {
  it('prefers positive weighted average, falls back to reference, and reports missing costs', async () => {
    const version: Version = {
      id: 'v1',
      recipeId: 'r1',
      status: 'ACTIVE',
      yieldQuantity: D('2'),
      yieldUnitId: 'unit_batch',
      portionCount: 3,
    };
    mocks.db = makeDb({
      versions: [version],
      lines: {
        v1: [
          ingredientLine('weighted', '2', 'each', 'each', 'stock_weighted'),
          ingredientLine('reference', '3', 'each', 'each', 'stock_reference'),
          ingredientLine('missing', '1', 'each', 'each'),
        ],
      },
      movements: [
        { stockItemId: 'stock_weighted', quantity: D('10'), unitCost: D('2') },
        { stockItemId: 'stock_weighted', quantity: D('10'), unitCost: D('4') },
      ],
      ingredients: [
        {
          id: 'weighted',
          referenceCost: D('99'),
          baseUnitId: 'each',
          stockItem: { id: 'stock_weighted', canonicalUnitId: 'each' },
        },
        {
          id: 'reference',
          referenceCost: D('5'),
          baseUnitId: 'each',
          stockItem: { id: 'stock_reference', canonicalUnitId: 'each' },
        },
        { id: 'missing', referenceCost: null, baseUnitId: 'each', stockItem: null },
      ],
    });

    const result = await computeRecipeCost({ organizationId: 'org_1', recipeId: 'r1' });

    expect(result.lines.map((line) => line.source)).toEqual([
      'WEIGHTED_AVERAGE',
      'REFERENCE',
      'MISSING',
    ]);
    expect(result.batchCost.equals('21')).toBe(true);
    expect(result.costPerPortion?.equals('7')).toBe(true);
    expect(result.costPerYieldUnit?.equals('10.5')).toBe(true);
    expect(result.missing).toEqual(['missing']);
  });
});

// Independent arithmetic: 2 kg yield / 10 portions; 100 g ingredient per batch.
const massVersion = (overrides: Partial<Version> = {}): Version => ({
  id: 'v_mass',
  recipeId: 'r_mass',
  status: 'ACTIVE',
  yieldQuantity: D('2'),
  yieldUnitId: 'kg',
  portionCount: 10,
  ...overrides,
});
const subLine = (recipeId: string, quantity = '500', unitId = 'g') => ({
  quantity: D(quantity),
  unitId,
  ingredientId: null,
  subRecipeId: recipeId,
});

function massDb(overrides: Partial<Version> = {}) {
  return makeDb({
    versions: [massVersion(overrides)],
    lines: { v_mass: [ingredientLine('flour', '100', 'g', 'g')] },
    ingredients: [{ id: 'flour', referenceCost: D('0.04'), baseUnitId: 'g', stockItem: null }],
  });
}

describe('recipe dimensions', () => {
  it.each([
    ['20', '200'],
    ['2.5', '25'],
    ['0', '0'],
  ])('%s portions consume exactly %s g, independently of yield mass', async (portions, grams) => {
    mocks.db = massDb();
    const result = await explodeRecipe({
      organizationId: 'org_1',
      recipeId: 'r_mass',
      portions: D(portions),
    });
    expect(result.ingredients[0].quantityInBaseUnit.toString()).toBe(grams);
  });

  it.each([undefined, '2.5'])('preserves explicit/default batch scaling (%s)', async (batches) => {
    mocks.db = massDb({ portionCount: null, yieldQuantity: null, yieldUnitId: null });
    const result = await explodeRecipe({
      organizationId: 'org_1',
      recipeId: 'r_mass',
      ...(batches ? { batches: D(batches) } : {}),
    });
    expect(result.ingredients[0].quantityInBaseUnit.toString()).toBe(batches ? '250' : '100');
  });

  it.each([null, 0, -2])(
    'rejects requested portions with unusable portionCount %s',
    async (portionCount) => {
      mocks.db = massDb({ portionCount });
      await expect(
        explodeRecipe({ organizationId: 'org_1', recipeId: 'r_mass', portions: D('1') })
      ).rejects.toMatchObject({ reason: 'INVALID' });
    }
  );

  it.each(['-1', 'NaN', 'Infinity'])('rejects invalid scale %s for either input', async (scale) => {
    mocks.db = massDb();
    for (const key of ['portions', 'batches'] as const) {
      await expect(
        explodeRecipe({ organizationId: 'org_1', recipeId: 'r_mass', [key]: D(scale) })
      ).rejects.toMatchObject({ reason: 'INVALID' });
    }
  });

  it('rejects both scales even when zero', async () => {
    mocks.db = massDb();
    await expect(
      explodeRecipe({ organizationId: 'org_1', recipeId: 'r_mass', portions: D(0), batches: D(0) })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('converts 500 g to 0.5 kg before dividing by a 2 kg subrecipe yield', async () => {
    mocks.db = makeDb({
      versions: [massVersion(), massVersion({ id: 'v_sub', recipeId: 'r_sub', portionCount: 99 })],
      lines: { v_mass: [subLine('r_sub')], v_sub: [ingredientLine('flour', '100', 'g', 'g')] },
      conversions: { 'g->kg': '0.001' },
      ingredients: [{ id: 'flour', referenceCost: D('0.04'), baseUnitId: 'g', stockItem: null }],
    });
    const result = await explodeRecipe({
      organizationId: 'org_1',
      recipeId: 'r_mass',
      portions: D('20'),
    });
    // 2 parent batches * 0.5 kg / 2 kg * 100 g = 50 g.
    expect(result.ingredients[0].quantityInBaseUnit.toString()).toBe('50');
    const cost = await computeRecipeCost({ organizationId: 'org_1', recipeId: 'r_mass' });
    expect(cost.batchCost.toString()).toBe('1');
    expect(cost.costPerPortion?.toString()).toBe('0.1');
    expect(cost.costPerYieldUnit?.toString()).toBe('0.5');
  });

  it.each([undefined, '0', '-0.001'])(
    'fails closed on absent/invalid nested conversion %s',
    async (factor) => {
      mocks.db = makeDb({
        versions: [massVersion(), massVersion({ id: 'v_sub', recipeId: 'r_sub' })],
        lines: { v_mass: [subLine('r_sub')], v_sub: [ingredientLine('flour', '100', 'g', 'g')] },
        conversions: factor === undefined ? {} : { 'g->kg': factor },
      });
      await expect(
        explodeRecipe({ organizationId: 'org_1', recipeId: 'r_mass' })
      ).rejects.toMatchObject({ reason: factor === undefined ? 'NO_UNIT_CONVERSION' : 'INVALID' });
    }
  );

  it.each([null, '0', '-2'])('rejects unusable subrecipe yield %s', async (yieldQuantity) => {
    mocks.db = makeDb({
      versions: [
        massVersion(),
        massVersion({
          id: 'v_sub',
          recipeId: 'r_sub',
          yieldQuantity: yieldQuantity === null ? null : D(yieldQuantity),
        }),
      ],
      lines: { v_mass: [subLine('r_sub', '0.5', 'kg')] },
    });
    await expect(
      explodeRecipe({ organizationId: 'org_1', recipeId: 'r_mass' })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('rejects a subrecipe without a yield unit', async () => {
    mocks.db = makeDb({
      versions: [massVersion(), massVersion({ id: 'v_sub', recipeId: 'r_sub', yieldUnitId: null })],
      lines: { v_mass: [subLine('r_sub')] },
    });
    await expect(
      explodeRecipe({ organizationId: 'org_1', recipeId: 'r_mass' })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it.each([8, 9])('supports eight levels and rejects nine (%s)', async (levels) => {
    const versions = Array.from({ length: levels }, (_, i) =>
      massVersion({ id: `v${i}`, recipeId: `r${i}`, yieldQuantity: D('1') })
    );
    mocks.db = makeDb({
      versions,
      lines: Object.fromEntries(
        versions.map((v, i) => [
          v.id,
          i === levels - 1
            ? [ingredientLine('flour', '100', 'g', 'g')]
            : [subLine(`r${i + 1}`, '1', 'kg')],
        ])
      ),
    });
    const result = explodeRecipe({ organizationId: 'org_1', recipeId: 'r0' });
    if (levels === 9) await expect(result).rejects.toMatchObject({ reason: 'DEPTH_EXCEEDED' });
    else expect((await result).ingredients[0].quantityInBaseUnit.toString()).toBe('100');
  });

  it('keeps explicitly selected historical quantities and denominators after activation', async () => {
    mocks.db = makeDb({
      versions: [
        massVersion({ status: 'SUPERSEDED' }),
        massVersion({ id: 'v_new', portionCount: 20, yieldQuantity: D('8') }),
      ],
      lines: {
        v_mass: [ingredientLine('flour', '100', 'g', 'g')],
        v_new: [ingredientLine('flour', '800', 'g', 'g')],
      },
      ingredients: [{ id: 'flour', referenceCost: D('0.04'), baseUnitId: 'g', stockItem: null }],
    });
    const historical = { organizationId: 'org_1', recipeVersionId: 'v_mass' };
    const result = await explodeRecipe({ ...historical, portions: D('20') });
    expect(result.recipeVersionId).toBe('v_mass');
    expect(result.ingredients[0].quantityInBaseUnit.toString()).toBe('200');
    const cost = await computeRecipeCost(historical);
    expect(cost.batchCost.toString()).toBe('4');
    expect(cost.costPerPortion?.toString()).toBe('0.4');
    expect(cost.costPerYieldUnit?.toString()).toBe('2');
    expect(
      (
        await computeRecipeCost({ organizationId: 'org_1', recipeId: 'r_mass' })
      ).costPerPortion?.toString()
    ).toBe('1.6');
  });

  it.each([null, '0', '-2'])(
    'returns no per-unit cost for invalid denominators %s',
    async (yieldQuantity) => {
      mocks.db = massDb({
        portionCount: yieldQuantity === null ? null : Number(yieldQuantity),
        yieldQuantity: yieldQuantity === null ? null : D(yieldQuantity),
      });
      const cost = await computeRecipeCost({ organizationId: 'org_1', recipeId: 'r_mass' });
      expect(cost.batchCost.toString()).toBe('4');
      expect(cost.costPerPortion).toBeNull();
      expect(cost.costPerYieldUnit).toBeNull();
    }
  );
});

// 2 kg at 10/kg + 6 kg at 30/kg = 25/kg = 0.025/g.
function transactionCostDb(conversions = { 'kg->g': '1000', 'g->kg': '0.001' }) {
  return makeDb({
    versions: [massVersion({ id: 'v_old', status: 'SUPERSEDED' }), massVersion()],
    lines: {
      v_old: [
        ingredientLine('flour', '0.5', 'kg', 'g', 'stock_flour'),
        ingredientLine('reference', '2', 'g', 'g'),
        ingredientLine('missing', '3', 'g', 'g'),
      ],
      v_mass: [ingredientLine('flour', '1000', 'g', 'g', 'stock_flour')],
    },
    conversions,
    movements: [
      { stockItemId: 'stock_flour', quantity: D('2'), unitCost: D('10') },
      { stockItemId: 'stock_flour', quantity: D('6'), unitCost: D('30') },
    ],
    ingredients: [
      {
        id: 'flour',
        referenceCost: D('99'),
        baseUnitId: 'g',
        stockItem: { id: 'stock_flour', canonicalUnitId: 'kg' },
      },
      { id: 'reference', referenceCost: D('4'), baseUnitId: 'g', stockItem: null },
      { id: 'missing', referenceCost: null, baseUnitId: 'g', stockItem: null },
    ],
  });
}

describe('computeRecipeCostInDb', () => {
  it('uses the supplied transaction and preserves every wrapper field for an explicit root version', async () => {
    const db = transactionCostDb();
    const input = { organizationId: 'org_1', recipeVersionId: 'v_old' };
    // The tenant wrapper still points at an empty DB during the direct call.
    const direct = await computeRecipeCostInDb(db as unknown as ScopedDb, input);
    expect(withTenantDb).not.toHaveBeenCalled();
    expect(direct.recipeVersionId).toBe('v_old');
    expect(direct.recipeId).toBe('r_mass');
    expect(direct.portionCount).toBe(10);
    expect(direct.yieldQuantity?.toString()).toBe('2');
    expect(direct.yieldUnitId).toBe('kg');
    expect(
      direct.lines.map((line) => ({
        id: line.ingredientId,
        quantity: line.quantityInBaseUnit.toString(),
        unitCost: line.unitCost.toString(),
        cost: line.lineCost.toString(),
        source: line.source,
      }))
    ).toEqual([
      { id: 'flour', quantity: '500', unitCost: '0.025', cost: '12.5', source: 'WEIGHTED_AVERAGE' },
      { id: 'reference', quantity: '2', unitCost: '4', cost: '8', source: 'REFERENCE' },
      { id: 'missing', quantity: '3', unitCost: '0', cost: '0', source: 'MISSING' },
    ]);
    expect(direct.batchCost.toString()).toBe('20.5');
    expect(direct.costPerPortion?.toString()).toBe('2.05');
    expect(direct.costPerYieldUnit?.toString()).toBe('10.25');
    expect(direct.missing).toEqual(['missing']);

    mocks.db = db;
    expect(await computeRecipeCost(input)).toEqual(direct);
    expect(withTenantDb).toHaveBeenCalledExactlyOnceWith('org_1', expect.any(Function));
  });

  it('preserves active-version selection through either entry point', async () => {
    const db = transactionCostDb();
    const input = { organizationId: 'org_1', recipeId: 'r_mass' };
    const direct = await computeRecipeCostInDb(db as unknown as ScopedDb, input);
    expect(direct.recipeVersionId).toBe('v_mass');
    expect(direct.batchCost.toString()).toBe('25');
    mocks.db = db;
    expect(await computeRecipeCost(input)).toEqual(direct);
  });

  it('fails closed in both entry points when weighted canonical/base conversion is missing', async () => {
    const db = transactionCostDb({ 'kg->g': '1000', 'g->kg': '' });
    const input = { organizationId: 'org_1', recipeVersionId: 'v_old' };
    await expect(computeRecipeCostInDb(db as unknown as ScopedDb, input)).rejects.toMatchObject({
      reason: 'NO_UNIT_CONVERSION',
    });
    expect(withTenantDb).not.toHaveBeenCalled();
    mocks.db = db;
    await expect(computeRecipeCost(input)).rejects.toMatchObject({ reason: 'NO_UNIT_CONVERSION' });
  });
});
