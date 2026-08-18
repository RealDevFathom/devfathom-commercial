import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  assertVersionMutable,
  nextVersionNumber,
  planActivation,
  resolveActiveVersion,
  type VersionRecord,
} from './effective-dating';
import type { LocalizedField } from './catalog';

/**
 * M3-L2 / §6 — unit + conversion CRUD, allergen catalog CRUD, ingredient CRUD
 * (+ ingredient-allergen), and recipe + version lifecycle (C3).
 *
 * Binding invariants:
 *  - C3: recipe versions are immutable once ACTIVE; only DRAFT versions are
 *    editable. All activation/supersession goes through the L1 effective-dating
 *    primitives; no direct status writes outside this module.
 *  - C2: no `branchId` column exists on any of these tables; inputs do not accept one.
 *  - C4: monetary values (referenceCost) are stored as Prisma Decimal — no floats.
 */

export type RecipeErrorReason =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'CONVERSION_CYCLE'
  | 'RECIPE_CYCLE'
  | 'VERSION_IMMUTABLE'
  | 'ALREADY_ATTACHED';

export class RecipeError extends Error {
  constructor(
    message: string,
    readonly reason: RecipeErrorReason
  ) {
    super(message);
    this.name = 'RecipeError';
  }
}

function requireName(value: string, label = 'name'): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new RecipeError(`A ${label} is required.`, 'INVALID');
  return trimmed;
}

function decimal(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function localizedWrite(
  value: LocalizedField | null | undefined
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

// ── Units ────────────────────────────────────────────────────────────────────

export type CreateUnitInput = {
  name: string;
  abbreviation?: string | null;
};

export async function createUnit(db: ScopedDb, input: CreateUnitInput) {
  const name = requireName(input.name, 'unit name');
  return db.restaurantUnit.create({
    data: { name, abbreviation: input.abbreviation ?? null },
  });
}

export type UpdateUnitInput = {
  name?: string;
  abbreviation?: string | null;
};

export async function updateUnit(db: ScopedDb, id: string, patch: UpdateUnitInput) {
  await requireUnit(db, id);
  const data: Prisma.RestaurantUnitUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'unit name');
  if (patch.abbreviation !== undefined) data.abbreviation = patch.abbreviation;
  return db.restaurantUnit.update({ where: { id }, data });
}

export async function deleteUnit(db: ScopedDb, id: string) {
  await requireUnit(db, id);
  // Restrict FKs on ingredient.baseUnit, recipeLine.unit, recipeVersion.yieldUnit
  // surface as P2003; map to friendly REFERENCED in the router.
  await db.restaurantUnit.delete({ where: { id } });
}

async function requireUnit(db: ScopedDb, id: string) {
  const unit = await db.restaurantUnit.findUnique({ where: { id }, select: { id: true } });
  if (!unit) throw new RecipeError('Unit not found.', 'NOT_FOUND');
  return unit;
}

// ── Unit conversions (cycle guard) ───────────────────────────────────────────

/**
 * Upsert the directed conversion `fromUnitId → toUnitId` with the given factor.
 * A cycle is defined as a path `A → ... → A`; self-conversion (A → A) is
 * rejected outright. Detection walks the outgoing edge chain from `toUnitId`; if
 * `fromUnitId` is reachable the new edge would close a cycle.
 */
export async function upsertConversion(
  db: ScopedDb,
  fromUnitId: string,
  toUnitId: string,
  factor: string
) {
  await requireUnit(db, fromUnitId);
  await requireUnit(db, toUnitId);
  if (fromUnitId === toUnitId) {
    throw new RecipeError('A unit cannot convert to itself.', 'CONVERSION_CYCLE');
  }
  await assertNoConversionCycle(db, fromUnitId, toUnitId);
  return db.restaurantUnitConversion.upsert({
    where: { fromUnitId_toUnitId: { fromUnitId, toUnitId } },
    create: { fromUnitId, toUnitId, factor: decimal(factor) },
    update: { factor: decimal(factor) },
  });
}

export async function deleteConversion(db: ScopedDb, fromUnitId: string, toUnitId: string) {
  const existing = await db.restaurantUnitConversion.findUnique({
    where: { fromUnitId_toUnitId: { fromUnitId, toUnitId } },
    select: { id: true },
  });
  if (!existing) throw new RecipeError('Conversion not found.', 'NOT_FOUND');
  await db.restaurantUnitConversion.delete({ where: { id: existing.id } });
}

/** Walk outgoing conversions from `start`; if we reach `origin` it's a cycle. */
async function assertNoConversionCycle(db: ScopedDb, origin: string, start: string) {
  const visited = new Set<string>();
  let frontier = [start];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      if (nodeId === origin) {
        throw new RecipeError(
          'Adding this conversion would create a cycle in the unit graph.',
          'CONVERSION_CYCLE'
        );
      }
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      const edges = await db.restaurantUnitConversion.findMany({
        where: { fromUnitId: nodeId },
        select: { toUnitId: true },
      });
      next.push(...edges.map((e: { toUnitId: string }) => e.toUnitId));
    }
    frontier = next;
  }
}

// ── Allergens ─────────────────────────────────────────────────────────────────

export type CreateAllergenInput = {
  name: string;
  nameLocalized?: LocalizedField | null;
};

export async function createAllergen(db: ScopedDb, input: CreateAllergenInput) {
  const name = requireName(input.name, 'allergen name');
  return db.restaurantAllergen.create({
    data: { name, nameLocalized: localizedWrite(input.nameLocalized) },
  });
}

export type UpdateAllergenInput = {
  name?: string;
  nameLocalized?: LocalizedField | null;
};

export async function updateAllergen(db: ScopedDb, id: string, patch: UpdateAllergenInput) {
  await requireAllergen(db, id);
  const data: Prisma.RestaurantAllergenUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'allergen name');
  if (patch.nameLocalized !== undefined) data.nameLocalized = localizedWrite(patch.nameLocalized);
  return db.restaurantAllergen.update({ where: { id }, data });
}

export async function deleteAllergen(db: ScopedDb, id: string) {
  await requireAllergen(db, id);
  // Cascade FKs on productAllergens and ingredientAllergens remove junction rows.
  await db.restaurantAllergen.delete({ where: { id } });
}

async function requireAllergen(db: ScopedDb, id: string) {
  const allergen = await db.restaurantAllergen.findUnique({ where: { id }, select: { id: true } });
  if (!allergen) throw new RecipeError('Allergen not found.', 'NOT_FOUND');
  return allergen;
}

// ── Ingredients ───────────────────────────────────────────────────────────────

export type CreateIngredientInput = {
  name: string;
  nameLocalized?: LocalizedField | null;
  baseUnitId: string;
  referenceCost?: string | null;
};

export async function createIngredient(db: ScopedDb, input: CreateIngredientInput) {
  const name = requireName(input.name, 'ingredient name');
  await requireUnit(db, input.baseUnitId);
  return db.restaurantIngredient.create({
    data: {
      name,
      nameLocalized: localizedWrite(input.nameLocalized),
      baseUnitId: input.baseUnitId,
      referenceCost: input.referenceCost != null ? decimal(input.referenceCost) : null,
    },
  });
}

export type UpdateIngredientInput = {
  name?: string;
  nameLocalized?: LocalizedField | null;
  baseUnitId?: string;
  referenceCost?: string | null;
};

export async function updateIngredient(db: ScopedDb, id: string, patch: UpdateIngredientInput) {
  await requireIngredient(db, id);
  const data: Prisma.RestaurantIngredientUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'ingredient name');
  if (patch.nameLocalized !== undefined) data.nameLocalized = localizedWrite(patch.nameLocalized);
  if (patch.baseUnitId !== undefined) {
    await requireUnit(db, patch.baseUnitId);
    data.baseUnitId = patch.baseUnitId;
  }
  if (patch.referenceCost !== undefined) {
    data.referenceCost = patch.referenceCost != null ? decimal(patch.referenceCost) : null;
  }
  return db.restaurantIngredient.update({ where: { id }, data });
}

export async function deleteIngredient(db: ScopedDb, id: string) {
  await requireIngredient(db, id);
  // RESTRICT FK on recipeLine.ingredient blocks deletion if referenced.
  await db.restaurantIngredient.delete({ where: { id } });
}

async function requireIngredient(db: ScopedDb, id: string) {
  const ingredient = await db.restaurantIngredient.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!ingredient) throw new RecipeError('Ingredient not found.', 'NOT_FOUND');
  return ingredient;
}

// ── Ingredient ↔ allergen attachment ─────────────────────────────────────────

export async function attachIngredientAllergen(
  db: ScopedDb,
  ingredientId: string,
  allergenId: string
) {
  await requireIngredient(db, ingredientId);
  await requireAllergen(db, allergenId);
  const existing = await db.restaurantIngredientAllergen.findUnique({
    where: { ingredientId_allergenId: { ingredientId, allergenId } },
    select: { id: true },
  });
  if (existing) {
    throw new RecipeError('That allergen is already declared on this ingredient.', 'ALREADY_ATTACHED');
  }
  return db.restaurantIngredientAllergen.create({ data: { ingredientId, allergenId } });
}

export async function detachIngredientAllergen(
  db: ScopedDb,
  ingredientId: string,
  allergenId: string
) {
  const link = await db.restaurantIngredientAllergen.findUnique({
    where: { ingredientId_allergenId: { ingredientId, allergenId } },
    select: { id: true },
  });
  if (!link) throw new RecipeError('That allergen is not declared on this ingredient.', 'NOT_FOUND');
  await db.restaurantIngredientAllergen.delete({ where: { id: link.id } });
}

// ── Recipes ───────────────────────────────────────────────────────────────────

export type CreateRecipeInput = {
  productId: string;
  variantId?: string | null;
  name: string;
};

/** Create the recipe identity. No version is created here; use `createRecipeVersion`. */
export async function createRecipe(db: ScopedDb, input: CreateRecipeInput) {
  const name = requireName(input.name, 'recipe name');
  const product = await db.restaurantProduct.findUnique({
    where: { id: input.productId },
    select: { id: true },
  });
  if (!product) throw new RecipeError('Product not found.', 'NOT_FOUND');
  return db.restaurantRecipe.create({
    data: { productId: input.productId, variantId: input.variantId ?? null, name },
  });
}

// ── Recipe versions (C3) ──────────────────────────────────────────────────────

export type CreateRecipeVersionInput = {
  recipeId: string;
  yieldQuantity?: string | null;
  yieldUnitId?: string | null;
  portionCount?: number | null;
  notes?: string | null;
};

/** Fork a new DRAFT version for the recipe. Always creates; never edits ACTIVE/SUPERSEDED. */
export async function createRecipeVersion(db: ScopedDb, input: CreateRecipeVersionInput) {
  await requireRecipe(db, input.recipeId);
  if (input.yieldUnitId) await requireUnit(db, input.yieldUnitId);
  const existingVersions = await db.restaurantRecipeVersion.findMany({
    where: { recipeId: input.recipeId },
    select: { id: true, versionNumber: true, status: true },
  });
  const versionNumber = nextVersionNumber(existingVersions);
  return db.restaurantRecipeVersion.create({
    data: {
      recipeId: input.recipeId,
      versionNumber,
      status: 'DRAFT',
      yieldQuantity: input.yieldQuantity != null ? decimal(input.yieldQuantity) : null,
      yieldUnitId: input.yieldUnitId ?? null,
      portionCount: input.portionCount ?? null,
      notes: input.notes ?? null,
    },
  });
}

export type UpdateRecipeVersionInput = {
  yieldQuantity?: string | null;
  yieldUnitId?: string | null;
  portionCount?: number | null;
  notes?: string | null;
};

/**
 * Edit a DRAFT recipe version. Throws `VersionImmutabilityError` (from L1) if
 * the version is ACTIVE or SUPERSEDED (C3).
 */
export async function updateRecipeVersion(
  db: ScopedDb,
  id: string,
  patch: UpdateRecipeVersionInput
) {
  const version = await requireRecipeVersion(db, id);
  assertVersionMutable(version); // C3 immutability guard
  if (patch.yieldUnitId !== undefined && patch.yieldUnitId) {
    await requireUnit(db, patch.yieldUnitId);
  }
  const data: Prisma.RestaurantRecipeVersionUncheckedUpdateInput = {};
  if (patch.yieldQuantity !== undefined) {
    data.yieldQuantity = patch.yieldQuantity != null ? decimal(patch.yieldQuantity) : null;
  }
  if (patch.yieldUnitId !== undefined) data.yieldUnitId = patch.yieldUnitId;
  if (patch.portionCount !== undefined) data.portionCount = patch.portionCount;
  if (patch.notes !== undefined) data.notes = patch.notes;
  return db.restaurantRecipeVersion.update({ where: { id }, data });
}

/**
 * Activate DRAFT version `versionId`. Uses `planActivation` (L1) which
 * simultaneously supersedes the prior ACTIVE version (if any) in one
 * transaction, preserving GOV-2.
 */
export async function activateRecipeVersion(db: ScopedDb, recipeId: string, versionId: string) {
  await requireRecipe(db, recipeId);
  const allVersions = await db.restaurantRecipeVersion.findMany({
    where: { recipeId },
    select: { id: true, status: true, versionNumber: true },
  });
  const plan = planActivation(allVersions as VersionRecord[], versionId, new Date());
  return db.$transaction(async (tx) => {
    if (plan.supersede) {
      await tx.restaurantRecipeVersion.update({
        where: { id: plan.supersede.id },
        data: plan.supersede.patch,
      });
    }
    return tx.restaurantRecipeVersion.update({
      where: { id: plan.activate.id },
      data: plan.activate.patch,
    });
  });
}

async function requireRecipe(db: ScopedDb, id: string) {
  const recipe = await db.restaurantRecipe.findUnique({ where: { id }, select: { id: true } });
  if (!recipe) throw new RecipeError('Recipe not found.', 'NOT_FOUND');
  return recipe;
}

async function requireRecipeVersion(db: ScopedDb, id: string) {
  const version = await db.restaurantRecipeVersion.findUnique({
    where: { id },
    select: { id: true, status: true, recipeId: true },
  });
  if (!version) throw new RecipeError('Recipe version not found.', 'NOT_FOUND');
  return version;
}

// ── Recipe lines (BOM) ────────────────────────────────────────────────────────

export type CreateRecipeLineInput =
  | { recipeVersionId: string; ingredientId: string; subRecipeId?: never; quantity: string; unitId: string; sortOrder?: number }
  | { recipeVersionId: string; subRecipeId: string; ingredientId?: never; quantity: string; unitId: string; sortOrder?: number };

/**
 * Append a BOM line to a DRAFT version. Exactly one of `ingredientId` or
 * `subRecipeId` must be set (XOR). Sub-recipe lines are cycle-detected: a recipe
 * may not reference itself directly or transitively.
 */
export async function createRecipeLine(db: ScopedDb, input: CreateRecipeLineInput) {
  if ((!input.ingredientId && !input.subRecipeId) || (input.ingredientId && input.subRecipeId)) {
    throw new RecipeError(
      'Exactly one of ingredientId or subRecipeId must be set.',
      'INVALID'
    );
  }
  const version = await requireRecipeVersion(db, input.recipeVersionId);
  assertVersionMutable(version);
  await requireUnit(db, input.unitId);

  let ingredientId: string | null = null;
  let subRecipeId: string | null = null;

  if (input.ingredientId) {
    await requireIngredient(db, input.ingredientId);
    ingredientId = input.ingredientId;
  } else {
    const subRecipe = await db.restaurantRecipe.findUnique({
      where: { id: input.subRecipeId! },
      select: { id: true },
    });
    if (!subRecipe) throw new RecipeError('Sub-recipe not found.', 'NOT_FOUND');
    await assertNoRecipeCycle(db, version.recipeId, input.subRecipeId!);
    subRecipeId = input.subRecipeId!;
  }

  return db.restaurantRecipeLine.create({
    data: {
      recipeVersionId: input.recipeVersionId,
      ingredientId,
      subRecipeId,
      quantity: decimal(input.quantity),
      unitId: input.unitId,
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export type UpdateRecipeLineInput = {
  quantity?: string;
  unitId?: string;
  sortOrder?: number;
};

export async function updateRecipeLine(db: ScopedDb, id: string, patch: UpdateRecipeLineInput) {
  const line = await db.restaurantRecipeLine.findUnique({
    where: { id },
    select: { id: true, recipeVersionId: true },
  });
  if (!line) throw new RecipeError('Recipe line not found.', 'NOT_FOUND');
  const version = await requireRecipeVersion(db, line.recipeVersionId);
  assertVersionMutable(version);
  if (patch.unitId) await requireUnit(db, patch.unitId);
  const data: Prisma.RestaurantRecipeLineUncheckedUpdateInput = {};
  if (patch.quantity !== undefined) data.quantity = decimal(patch.quantity);
  if (patch.unitId !== undefined) data.unitId = patch.unitId;
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  return db.restaurantRecipeLine.update({ where: { id }, data });
}

export async function deleteRecipeLine(db: ScopedDb, id: string) {
  const line = await db.restaurantRecipeLine.findUnique({
    where: { id },
    select: { id: true, recipeVersionId: true },
  });
  if (!line) throw new RecipeError('Recipe line not found.', 'NOT_FOUND');
  const version = await requireRecipeVersion(db, line.recipeVersionId);
  assertVersionMutable(version);
  await db.restaurantRecipeLine.delete({ where: { id } });
}

/**
 * Detect recipe cycles by walking the sub-recipe reference graph. Starting from
 * the candidate `subRecipeId`, collect all reachable recipe ids across any
 * version's lines. If `parentRecipeId` is reachable, the new line would close
 * a cycle.
 */
async function assertNoRecipeCycle(db: ScopedDb, parentRecipeId: string, subRecipeId: string) {
  const visited = new Set<string>();
  let frontier = [subRecipeId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const recipeId of frontier) {
      if (recipeId === parentRecipeId) {
        throw new RecipeError(
          'Adding this sub-recipe would create a cycle in the recipe graph.',
          'RECIPE_CYCLE'
        );
      }
      if (visited.has(recipeId)) continue;
      visited.add(recipeId);
      // Walk every version's lines to catch cycles regardless of version status.
      const lines = await db.restaurantRecipeLine.findMany({
        where: { recipeVersion: { recipeId } },
        select: { subRecipeId: true },
      });
      const reachable = lines
        .map((l: { subRecipeId: string | null }) => l.subRecipeId)
        .filter(Boolean) as string[];
      next.push(...reachable);
    }
    frontier = next;
  }
}

// ── Convenience query: resolved active version for a recipe ───────────────────

export async function getActiveRecipeVersion(db: ScopedDb, recipeId: string) {
  await requireRecipe(db, recipeId);
  const versions = await db.restaurantRecipeVersion.findMany({
    where: { recipeId },
    select: { id: true, status: true, versionNumber: true },
  });
  return resolveActiveVersion(versions as VersionRecord[]);
}
