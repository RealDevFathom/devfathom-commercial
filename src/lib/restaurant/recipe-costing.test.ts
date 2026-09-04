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

import { computeRecipeCost, explodeRecipe } from './recipe-costing';

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

  it('fails closed when a sub-recipe cycle is encountered', async () => {
    const versions: Version[] = [
      {
        id: 'v1',
        recipeId: 'r1',
        status: 'ACTIVE',
        yieldQuantity: D('1'),
        yieldUnitId: null,
        portionCount: null,
      },
      {
        id: 'v2',
        recipeId: 'r2',
        status: 'ACTIVE',
        yieldQuantity: D('1'),
        yieldUnitId: null,
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
