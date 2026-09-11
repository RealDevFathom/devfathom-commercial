import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { resolveActiveVersion } from './effective-dating';

const ZERO = new Prisma.Decimal(0);
const ONE = new Prisma.Decimal(1);
const MAX_DEPTH = 8;

export type RecipeCostSource = 'WEIGHTED_AVERAGE' | 'REFERENCE' | 'MISSING';

type RecipeSelector =
  | { organizationId: string; recipeId: string; recipeVersionId?: never }
  | { organizationId: string; recipeId?: never; recipeVersionId: string };

export type ExplodeRecipeInput = RecipeSelector & {
  portions?: Prisma.Decimal;
  batches?: Prisma.Decimal;
};

export type ExplodedRecipeIngredient = {
  ingredientId: string;
  ingredientName: string;
  baseUnitId: string;
  stockItemId: string | null;
  quantityInBaseUnit: Prisma.Decimal;
};

export type ExplodeRecipeResult = {
  recipeId: string;
  recipeVersionId: string;
  ingredients: ExplodedRecipeIngredient[];
};

export type RecipeCostLine = ExplodedRecipeIngredient & {
  unitCost: Prisma.Decimal;
  source: RecipeCostSource;
  lineCost: Prisma.Decimal;
};

export type RecipeCostResult = {
  recipeId: string;
  recipeVersionId: string;
  portionCount: number | null;
  yieldQuantity: Prisma.Decimal | null;
  yieldUnitId: string | null;
  lines: RecipeCostLine[];
  batchCost: Prisma.Decimal;
  costPerPortion: Prisma.Decimal | null;
  costPerYieldUnit: Prisma.Decimal | null;
  missing: string[];
};

export type RecipeCostingErrorReason =
  'NOT_FOUND' | 'NO_ACTIVE_VERSION' | 'NO_UNIT_CONVERSION' | 'CYCLE' | 'DEPTH_EXCEEDED' | 'INVALID';

export class RecipeCostingError extends Error {
  constructor(
    message: string,
    readonly reason: RecipeCostingErrorReason
  ) {
    super(message);
    this.name = 'RecipeCostingError';
  }
}

type Version = {
  id: string;
  recipeId: string;
  status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';
  yieldQuantity: Prisma.Decimal | null;
  yieldUnitId: string | null;
  portionCount: number | null;
};

async function resolveVersion(db: ScopedDb, input: RecipeSelector): Promise<Version> {
  if (input.recipeVersionId) {
    const version = await db.restaurantRecipeVersion.findFirst({
      where: { id: input.recipeVersionId, organizationId: input.organizationId },
      select: {
        id: true,
        recipeId: true,
        status: true,
        yieldQuantity: true,
        yieldUnitId: true,
        portionCount: true,
      },
    });
    if (!version) throw new RecipeCostingError('Recipe version not found.', 'NOT_FOUND');
    return version;
  }

  const recipe = await db.restaurantRecipe.findFirst({
    where: { id: input.recipeId, organizationId: input.organizationId },
    select: { id: true },
  });
  if (!recipe) throw new RecipeCostingError('Recipe not found.', 'NOT_FOUND');
  const versions = await db.restaurantRecipeVersion.findMany({
    where: { recipeId: recipe.id, organizationId: input.organizationId },
    select: {
      id: true,
      recipeId: true,
      status: true,
      yieldQuantity: true,
      yieldUnitId: true,
      portionCount: true,
    },
  });
  const active = resolveActiveVersion(versions);
  if (!active) throw new RecipeCostingError('Recipe has no active version.', 'NO_ACTIVE_VERSION');
  return active;
}

async function conversionFactor(
  db: ScopedDb,
  fromUnitId: string,
  toUnitId: string,
  cache: Map<string, Prisma.Decimal>
): Promise<Prisma.Decimal> {
  if (fromUnitId === toUnitId) return ONE;
  const key = `${fromUnitId}->${toUnitId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const conversion = await db.restaurantUnitConversion.findUnique({
    where: { fromUnitId_toUnitId: { fromUnitId, toUnitId } },
    select: { factor: true },
  });
  if (!conversion) {
    throw new RecipeCostingError(
      `No unit conversion from ${fromUnitId} to ${toUnitId}.`,
      'NO_UNIT_CONVERSION'
    );
  }
  cache.set(key, conversion.factor);
  return conversion.factor;
}

async function explodeVersion(
  db: ScopedDb,
  organizationId: string,
  version: Version,
  batches: Prisma.Decimal,
  depth: number,
  ancestors: ReadonlySet<string>,
  conversions: Map<string, Prisma.Decimal>
): Promise<ExplodedRecipeIngredient[]> {
  if (ancestors.has(version.recipeId)) {
    throw new RecipeCostingError('Recipe cycle detected.', 'CYCLE');
  }
  if (depth >= MAX_DEPTH) {
    throw new RecipeCostingError(`Recipe depth exceeds ${MAX_DEPTH}.`, 'DEPTH_EXCEEDED');
  }
  const nextAncestors = new Set(ancestors).add(version.recipeId);
  const lines = await db.restaurantRecipeLine.findMany({
    where: { recipeVersionId: version.id },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: {
      quantity: true,
      unitId: true,
      ingredientId: true,
      subRecipeId: true,
      ingredient: {
        select: {
          id: true,
          name: true,
          baseUnitId: true,
          stockItem: { select: { id: true } },
        },
      },
    },
  });

  const leaves: ExplodedRecipeIngredient[] = [];
  for (const line of lines) {
    const quantity = line.quantity.times(batches);
    if (line.ingredientId && line.ingredient) {
      const factor = await conversionFactor(
        db,
        line.unitId,
        line.ingredient.baseUnitId,
        conversions
      );
      leaves.push({
        ingredientId: line.ingredient.id,
        ingredientName: line.ingredient.name,
        baseUnitId: line.ingredient.baseUnitId,
        stockItemId: line.ingredient.stockItem?.id ?? null,
        quantityInBaseUnit: quantity.times(factor),
      });
      continue;
    }
    if (!line.subRecipeId) continue;
    const subVersion = await resolveVersion(db, {
      organizationId,
      recipeId: line.subRecipeId,
    });
    const subYield = subVersion.yieldQuantity;
    const subBatches = subYield && !subYield.isZero() ? quantity.dividedBy(subYield) : quantity;
    leaves.push(
      ...(await explodeVersion(
        db,
        organizationId,
        subVersion,
        subBatches,
        depth + 1,
        nextAncestors,
        conversions
      ))
    );
  }
  return leaves;
}

export async function explodeRecipeInDb(
  db: ScopedDb,
  input: ExplodeRecipeInput
): Promise<ExplodeRecipeResult> {
  if (input.portions && input.batches) {
    throw new RecipeCostingError('Specify portions or batches, not both.', 'INVALID');
  }
  const version = await resolveVersion(db, input);
  const batches = input.batches
    ? new Prisma.Decimal(input.batches)
    : input.portions && version.yieldQuantity && !version.yieldQuantity.isZero()
      ? new Prisma.Decimal(input.portions).dividedBy(version.yieldQuantity)
      : input.portions
        ? new Prisma.Decimal(input.portions)
        : ONE;
  if (batches.isNegative()) {
    throw new RecipeCostingError('Recipe scale cannot be negative.', 'INVALID');
  }
  const leaves = await explodeVersion(
    db,
    input.organizationId,
    version,
    batches,
    0,
    new Set(),
    new Map()
  );
  const byIngredient = new Map<string, ExplodedRecipeIngredient>();
  for (const leaf of leaves) {
    const current = byIngredient.get(leaf.ingredientId);
    if (current)
      current.quantityInBaseUnit = current.quantityInBaseUnit.plus(leaf.quantityInBaseUnit);
    else byIngredient.set(leaf.ingredientId, { ...leaf });
  }
  return {
    recipeId: version.recipeId,
    recipeVersionId: version.id,
    ingredients: [...byIngredient.values()],
  };
}

export async function explodeRecipe(input: ExplodeRecipeInput): Promise<ExplodeRecipeResult> {
  return withTenantDb(input.organizationId, (db) => explodeRecipeInDb(db, input));
}

export async function computeRecipeCost(input: RecipeSelector): Promise<RecipeCostResult> {
  return withTenantDb(input.organizationId, async (db) => {
    const version = await resolveVersion(db, input);
    const explosion = await explodeRecipeInDb(db, { ...input, batches: ONE });
    const stockItemIds = explosion.ingredients.flatMap((line) =>
      line.stockItemId ? [line.stockItemId] : []
    );
    const movements = stockItemIds.length
      ? await db.restaurantStockMovement.findMany({
          where: { stockItemId: { in: stockItemIds }, unitCost: { not: null } },
          select: { stockItemId: true, quantity: true, unitCost: true },
        })
      : [];
    const costs = new Map<string, { quantity: Prisma.Decimal; cost: Prisma.Decimal }>();
    for (const movement of movements) {
      if (!movement.unitCost) continue;
      const value = costs.get(movement.stockItemId) ?? { quantity: ZERO, cost: ZERO };
      value.quantity = value.quantity.plus(movement.quantity);
      value.cost = value.cost.plus(movement.quantity.times(movement.unitCost));
      costs.set(movement.stockItemId, value);
    }
    const ingredients = await db.restaurantIngredient.findMany({
      where: { id: { in: explosion.ingredients.map((line) => line.ingredientId) } },
      select: {
        id: true,
        referenceCost: true,
        baseUnitId: true,
        stockItem: { select: { id: true, canonicalUnitId: true } },
      },
    });
    const ingredientMap = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
    const conversions = new Map<string, Prisma.Decimal>();
    const lines: RecipeCostLine[] = [];
    for (const line of explosion.ingredients) {
      const ingredient = ingredientMap.get(line.ingredientId);
      const weighted = line.stockItemId ? costs.get(line.stockItemId) : undefined;
      let unitCost = ZERO;
      let source: RecipeCostSource = 'MISSING';
      if (weighted && !weighted.quantity.isZero()) {
        const canonicalCost = weighted.cost.dividedBy(weighted.quantity);
        if (canonicalCost.greaterThan(ZERO)) {
          const factor = ingredient?.stockItem
            ? await conversionFactor(
                db,
                ingredient.baseUnitId,
                ingredient.stockItem.canonicalUnitId,
                conversions
              )
            : ONE;
          unitCost = canonicalCost.times(factor);
          source = 'WEIGHTED_AVERAGE';
        }
      }
      if (source === 'MISSING' && ingredient?.referenceCost?.greaterThan(ZERO)) {
        unitCost = ingredient.referenceCost;
        source = 'REFERENCE';
      }
      lines.push({
        ...line,
        unitCost,
        source,
        lineCost: line.quantityInBaseUnit.times(unitCost),
      });
    }
    const batchCost = lines.reduce((total, line) => total.plus(line.lineCost), ZERO);
    return {
      recipeId: version.recipeId,
      recipeVersionId: version.id,
      portionCount: version.portionCount,
      yieldQuantity: version.yieldQuantity,
      yieldUnitId: version.yieldUnitId,
      lines,
      batchCost,
      costPerPortion:
        version.portionCount && version.portionCount > 0
          ? batchCost.dividedBy(new Prisma.Decimal(version.portionCount))
          : null,
      costPerYieldUnit:
        version.yieldQuantity && !version.yieldQuantity.isZero()
          ? batchCost.dividedBy(version.yieldQuantity)
          : null,
      missing: lines.filter((line) => line.source === 'MISSING').map((line) => line.ingredientId),
    };
  });
}
