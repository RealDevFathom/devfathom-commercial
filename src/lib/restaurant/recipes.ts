import 'server-only';

import { catalogOrganizationId } from './catalog-scope';

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

/**
 * Serialize mutations to one of the organization's directed dependency graphs.
 *
 * Cycle detection is only sound when the path read and the edge write happen
 * while competing writers are excluded. Transaction-scoped advisory locks give
 * us that property without locking unrelated organizations (or the other graph).
 *
 * Requires READ COMMITTED (the withTenantDb default): reads issued after the
 * lock must see edges committed by the previous holder. Under REPEATABLE READ
 * the snapshot is taken before the lock and the cycle walk would be stale.
 */
async function lockDependencyGraph(
  db: ScopedDb,
  organizationId: string,
  graph: 'unit-conversions' | 'recipes'
) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`restaurant:${organizationId}:${graph}`}, 0))`
  );
}

// ── Units ────────────────────────────────────────────────────────────────────

export type CreateUnitInput = {
  name: string;
  abbreviation?: string | null;
};

export async function createUnit(db: ScopedDb, input: CreateUnitInput) {
  const organizationId = await catalogOrganizationId(db);
  const name = requireName(input.name, 'unit name');
  return db.restaurantUnit.create({
    data: { organizationId, name, abbreviation: input.abbreviation ?? null },
  });
}

export type UpdateUnitInput = {
  name?: string;
  abbreviation?: string | null;
};

export async function updateUnit(db: ScopedDb, id: string, patch: UpdateUnitInput) {
  const organizationId = await catalogOrganizationId(db);
  await requireUnit(db, id);
  const data: Prisma.RestaurantUnitUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'unit name');
  if (patch.abbreviation !== undefined) data.abbreviation = patch.abbreviation;
  return db.restaurantUnit.update({ where: { organizationId, id }, data });
}

export async function deleteUnit(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  await requireUnit(db, id);
  // Restrict FKs on ingredient.baseUnit, recipeLine.unit, recipeVersion.yieldUnit
  // surface as P2003; map to friendly REFERENCED in the router.
  await db.restaurantUnit.delete({ where: { organizationId, id } });
}

async function requireUnit(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const unit = await db.restaurantUnit.findUnique({
    where: { organizationId, id },
    select: { id: true },
  });
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
  if (fromUnitId === toUnitId) {
    throw new RecipeError('A unit cannot convert to itself.', 'CONVERSION_CYCLE');
  }
  return db.$transaction(async (tx) => {
    const scopedTx = tx as ScopedDb;
    const organizationId = await catalogOrganizationId(scopedTx);
    await lockDependencyGraph(scopedTx, organizationId, 'unit-conversions');
    await requireUnit(scopedTx, fromUnitId);
    await requireUnit(scopedTx, toUnitId);
    await assertNoConversionCycle(scopedTx, fromUnitId, toUnitId);
    return scopedTx.restaurantUnitConversion.upsert({
      where: { organizationId, fromUnitId_toUnitId: { fromUnitId, toUnitId } },
      create: { organizationId, fromUnitId, toUnitId, factor: decimal(factor) },
      update: { factor: decimal(factor) },
    });
  });
}

export async function deleteConversion(db: ScopedDb, fromUnitId: string, toUnitId: string) {
  const organizationId = await catalogOrganizationId(db);
  const existing = await db.restaurantUnitConversion.findUnique({
    where: { organizationId, fromUnitId_toUnitId: { fromUnitId, toUnitId } },
    select: { id: true },
  });
  if (!existing) throw new RecipeError('Conversion not found.', 'NOT_FOUND');
  await db.restaurantUnitConversion.delete({ where: { organizationId, id: existing.id } });
}

/** Walk outgoing conversions from `start`; if we reach `origin` it's a cycle. */
async function assertNoConversionCycle(db: ScopedDb, origin: string, start: string) {
  const organizationId = await catalogOrganizationId(db);
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
        where: { organizationId, fromUnitId: nodeId },
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
  const organizationId = await catalogOrganizationId(db);
  const name = requireName(input.name, 'allergen name');
  return db.restaurantAllergen.create({
    data: { organizationId, name, nameLocalized: localizedWrite(input.nameLocalized) },
  });
}

export type UpdateAllergenInput = {
  name?: string;
  nameLocalized?: LocalizedField | null;
};

export async function updateAllergen(db: ScopedDb, id: string, patch: UpdateAllergenInput) {
  const organizationId = await catalogOrganizationId(db);
  await requireAllergen(db, id);
  const data: Prisma.RestaurantAllergenUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'allergen name');
  if (patch.nameLocalized !== undefined) data.nameLocalized = localizedWrite(patch.nameLocalized);
  return db.restaurantAllergen.update({ where: { organizationId, id }, data });
}

export async function deleteAllergen(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  await requireAllergen(db, id);
  // Cascade FKs on productAllergens and ingredientAllergens remove junction rows.
  await db.restaurantAllergen.delete({ where: { organizationId, id } });
}

async function requireAllergen(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const allergen = await db.restaurantAllergen.findUnique({
    where: { organizationId, id },
    select: { id: true },
  });
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
  const organizationId = await catalogOrganizationId(db);
  const name = requireName(input.name, 'ingredient name');
  await requireUnit(db, input.baseUnitId);
  return db.restaurantIngredient.create({
    data: {
      organizationId,
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
  const organizationId = await catalogOrganizationId(db);
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
  return db.restaurantIngredient.update({ where: { organizationId, id }, data });
}

export async function deleteIngredient(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  await requireIngredient(db, id);
  // RESTRICT FK on recipeLine.ingredient blocks deletion if referenced.
  await db.restaurantIngredient.delete({ where: { organizationId, id } });
}

async function requireIngredient(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const ingredient = await db.restaurantIngredient.findUnique({
    where: { organizationId, id },
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
  const organizationId = await catalogOrganizationId(db);
  await requireIngredient(db, ingredientId);
  await requireAllergen(db, allergenId);
  const existing = await db.restaurantIngredientAllergen.findUnique({
    where: { organizationId, ingredientId_allergenId: { ingredientId, allergenId } },
    select: { id: true },
  });
  if (existing) {
    throw new RecipeError(
      'That allergen is already declared on this ingredient.',
      'ALREADY_ATTACHED'
    );
  }
  return db.restaurantIngredientAllergen.create({
    data: { organizationId, ingredientId, allergenId },
  });
}

export async function detachIngredientAllergen(
  db: ScopedDb,
  ingredientId: string,
  allergenId: string
) {
  const organizationId = await catalogOrganizationId(db);
  const link = await db.restaurantIngredientAllergen.findUnique({
    where: { organizationId, ingredientId_allergenId: { ingredientId, allergenId } },
    select: { id: true },
  });
  if (!link)
    throw new RecipeError('That allergen is not declared on this ingredient.', 'NOT_FOUND');
  await db.restaurantIngredientAllergen.delete({ where: { organizationId, id: link.id } });
}

// ── Recipes ───────────────────────────────────────────────────────────────────

export type CreateRecipeInput = {
  productId: string;
  variantId?: string | null;
  name: string;
};

/** Create the recipe identity. No version is created here; use `createRecipeVersion`. */
export async function createRecipe(db: ScopedDb, input: CreateRecipeInput) {
  const organizationId = await catalogOrganizationId(db);
  const name = requireName(input.name, 'recipe name');
  const product = await db.restaurantProduct.findUnique({
    where: { organizationId, id: input.productId },
    select: { id: true },
  });
  if (!product) throw new RecipeError('Product not found.', 'NOT_FOUND');
  return db.restaurantRecipe.create({
    data: { organizationId, productId: input.productId, variantId: input.variantId ?? null, name },
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
  const organizationId = await catalogOrganizationId(db);
  await requireRecipe(db, input.recipeId);
  if (input.yieldUnitId) await requireUnit(db, input.yieldUnitId);
  const existingVersions = await db.restaurantRecipeVersion.findMany({
    where: { organizationId, recipeId: input.recipeId },
    select: { id: true, versionNumber: true, status: true },
  });
  const versionNumber = nextVersionNumber(existingVersions);
  return db.restaurantRecipeVersion.create({
    data: {
      organizationId,
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
  const organizationId = await catalogOrganizationId(db);
  return db.$transaction(async (tx) => {
    await lockMutableRecipeVersion(tx as ScopedDb, organizationId, id);
    if (patch.yieldUnitId !== undefined && patch.yieldUnitId) {
      await requireUnit(tx as ScopedDb, patch.yieldUnitId);
    }
    const data: Prisma.RestaurantRecipeVersionUncheckedUpdateInput = {};
    if (patch.yieldQuantity !== undefined) {
      data.yieldQuantity = patch.yieldQuantity != null ? decimal(patch.yieldQuantity) : null;
    }
    if (patch.yieldUnitId !== undefined) data.yieldUnitId = patch.yieldUnitId;
    if (patch.portionCount !== undefined) data.portionCount = patch.portionCount;
    if (patch.notes !== undefined) data.notes = patch.notes;
    return tx.restaurantRecipeVersion.update({ where: { organizationId, id }, data });
  });
}

/**
 * Activate DRAFT version `versionId`. Uses `planActivation` (L1) which
 * simultaneously supersedes the prior ACTIVE version (if any) in one
 * transaction, preserving GOV-2.
 */
export async function activateRecipeVersion(db: ScopedDb, recipeId: string, versionId: string) {
  const organizationId = await catalogOrganizationId(db);
  return db.$transaction(async (tx) => {
    await requireRecipe(tx as ScopedDb, recipeId);
    await tx.$queryRaw`SELECT id FROM restaurant_recipe_versions WHERE "organizationId" = ${organizationId} AND "recipeId" = ${recipeId} ORDER BY id FOR UPDATE`;
    const allVersions = await tx.restaurantRecipeVersion.findMany({
      where: { organizationId, recipeId },
      select: { id: true, status: true, versionNumber: true },
    });
    const plan = planActivation(allVersions as VersionRecord[], versionId, new Date());
    if (plan.supersede) {
      await tx.restaurantRecipeVersion.update({
        where: { organizationId, id: plan.supersede.id },
        data: plan.supersede.patch,
      });
    }
    return tx.restaurantRecipeVersion.update({
      where: { organizationId, id: plan.activate.id },
      data: plan.activate.patch,
    });
  });
}

async function requireRecipe(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const recipe = await db.restaurantRecipe.findUnique({
    where: { organizationId, id },
    select: { id: true },
  });
  if (!recipe) throw new RecipeError('Recipe not found.', 'NOT_FOUND');
  return recipe;
}

async function requireRecipeVersion(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const version = await db.restaurantRecipeVersion.findUnique({
    where: { organizationId, id },
    select: { id: true, status: true, recipeId: true },
  });
  if (!version) throw new RecipeError('Recipe version not found.', 'NOT_FOUND');
  return version;
}

async function lockMutableRecipeVersion(db: ScopedDb, organizationId: string, id: string) {
  // Activation takes the same row lock. Re-read status only after acquiring it
  // so an edit queued behind activation cannot write using stale DRAFT state.
  await db.$queryRaw`SELECT id FROM restaurant_recipe_versions WHERE "organizationId" = ${organizationId} AND id = ${id} FOR UPDATE`;
  const version = await requireRecipeVersion(db, id);
  assertVersionMutable(version);
  return version;
}

// ── Recipe lines (BOM) ────────────────────────────────────────────────────────

export type CreateRecipeLineInput =
  | {
      recipeVersionId: string;
      ingredientId: string;
      subRecipeId?: never;
      quantity: string;
      unitId: string;
      sortOrder?: number;
    }
  | {
      recipeVersionId: string;
      subRecipeId: string;
      ingredientId?: never;
      quantity: string;
      unitId: string;
      sortOrder?: number;
    };

/**
 * Append a BOM line to a DRAFT version. Exactly one of `ingredientId` or
 * `subRecipeId` must be set (XOR). Sub-recipe lines are cycle-detected: a recipe
 * may not reference itself directly or transitively.
 */
export async function createRecipeLine(db: ScopedDb, input: CreateRecipeLineInput) {
  if ((!input.ingredientId && !input.subRecipeId) || (input.ingredientId && input.subRecipeId)) {
    throw new RecipeError('Exactly one of ingredientId or subRecipeId must be set.', 'INVALID');
  }
  return db.$transaction(async (tx) => {
    const scopedTx = tx as ScopedDb;
    const organizationId = await catalogOrganizationId(scopedTx);
    // Graph lock before the version row lock: activation/line edits only take
    // row locks, so this ordering cannot deadlock. Cycle detection below relies
    // on READ COMMITTED (withTenantDb default): each statement after the lock
    // sees the latest committed edges. Under REPEATABLE READ the snapshot would
    // predate the lock and the cycle walk could read stale data.
    if (input.subRecipeId) await lockDependencyGraph(scopedTx, organizationId, 'recipes');

    const version = await lockMutableRecipeVersion(scopedTx, organizationId, input.recipeVersionId);
    await requireUnit(scopedTx, input.unitId);

    let ingredientId: string | null = null;
    let subRecipeId: string | null = null;

    if (input.ingredientId) {
      await requireIngredient(scopedTx, input.ingredientId);
      ingredientId = input.ingredientId;
    } else {
      const subRecipe = await scopedTx.restaurantRecipe.findUnique({
        where: { organizationId, id: input.subRecipeId! },
        select: { id: true },
      });
      if (!subRecipe) throw new RecipeError('Sub-recipe not found.', 'NOT_FOUND');
      await assertNoRecipeCycle(scopedTx, version.recipeId, input.subRecipeId!);
      subRecipeId = input.subRecipeId!;
    }

    return scopedTx.restaurantRecipeLine.create({
      data: {
        organizationId,
        recipeVersionId: input.recipeVersionId,
        ingredientId,
        subRecipeId,
        quantity: decimal(input.quantity),
        unitId: input.unitId,
        sortOrder: input.sortOrder ?? 0,
      },
    });
  });
}

export type UpdateRecipeLineInput = {
  quantity?: string;
  unitId?: string;
  sortOrder?: number;
};

export async function updateRecipeLine(db: ScopedDb, id: string, patch: UpdateRecipeLineInput) {
  const organizationId = await catalogOrganizationId(db);
  return db.$transaction(async (tx) => {
    const scopedTx = tx as ScopedDb;
    const line = await tx.restaurantRecipeLine.findUnique({
      where: { organizationId, id },
      select: { id: true, recipeVersionId: true },
    });
    if (!line) throw new RecipeError('Recipe line not found.', 'NOT_FOUND');
    await lockMutableRecipeVersion(scopedTx, organizationId, line.recipeVersionId);
    if (patch.unitId) await requireUnit(scopedTx, patch.unitId);
    const data: Prisma.RestaurantRecipeLineUncheckedUpdateInput = {};
    if (patch.quantity !== undefined) data.quantity = decimal(patch.quantity);
    if (patch.unitId !== undefined) data.unitId = patch.unitId;
    if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
    return tx.restaurantRecipeLine.update({ where: { organizationId, id }, data });
  });
}

export async function deleteRecipeLine(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  await db.$transaction(async (tx) => {
    const line = await tx.restaurantRecipeLine.findUnique({
      where: { organizationId, id },
      select: { id: true, recipeVersionId: true },
    });
    if (!line) throw new RecipeError('Recipe line not found.', 'NOT_FOUND');
    await lockMutableRecipeVersion(tx as ScopedDb, organizationId, line.recipeVersionId);
    await tx.restaurantRecipeLine.delete({ where: { organizationId, id } });
  });
}

export async function addRecipeLineSubstitute(
  db: ScopedDb,
  input: { recipeLineId: string; substituteIngredientId: string }
) {
  const organizationId = await catalogOrganizationId(db);
  return db.$transaction(async (tx) => {
    const scopedTx = tx as ScopedDb;
    const line = await tx.restaurantRecipeLine.findUnique({
      where: { organizationId, id: input.recipeLineId },
      select: { id: true, recipeVersionId: true, ingredientId: true },
    });
    if (!line) throw new RecipeError('Recipe line not found.', 'NOT_FOUND');
    await lockMutableRecipeVersion(scopedTx, organizationId, line.recipeVersionId);
    if (!line.ingredientId) {
      throw new RecipeError('Only ingredient recipe lines can declare substitutes.', 'INVALID');
    }
    if (line.ingredientId === input.substituteIngredientId) {
      throw new RecipeError('A recipe ingredient cannot substitute for itself.', 'INVALID');
    }
    await requireIngredient(scopedTx, input.substituteIngredientId);

    const existing = await tx.restaurantRecipeLineSubstitute.findUnique({
      where: { organizationId, recipeLineId_substituteIngredientId: input },
      select: { id: true },
    });
    if (existing) {
      throw new RecipeError(
        'This substitute is already approved for the recipe line.',
        'ALREADY_ATTACHED'
      );
    }
    return tx.restaurantRecipeLineSubstitute.create({ data: { ...input, organizationId } });
  });
}

export async function removeRecipeLineSubstitute(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  await db.$transaction(async (tx) => {
    const substitute = await tx.restaurantRecipeLineSubstitute.findUnique({
      where: { organizationId, id },
      select: { id: true, recipeLine: { select: { recipeVersionId: true } } },
    });
    if (!substitute) throw new RecipeError('Recipe line substitute not found.', 'NOT_FOUND');
    await lockMutableRecipeVersion(
      tx as ScopedDb,
      organizationId,
      substitute.recipeLine.recipeVersionId
    );
    await tx.restaurantRecipeLineSubstitute.delete({ where: { organizationId, id } });
  });
}

/**
 * Detect recipe cycles by walking the sub-recipe reference graph. Starting from
 * the candidate `subRecipeId`, collect all reachable recipe ids across any
 * version's lines. If `parentRecipeId` is reachable, the new line would close
 * a cycle.
 */
async function assertNoRecipeCycle(db: ScopedDb, parentRecipeId: string, subRecipeId: string) {
  const organizationId = await catalogOrganizationId(db);
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
        where: { organizationId, recipeVersion: { recipeId } },
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

// ── Read models: version history (GOV-2) ──────────────────────────────────────

export async function getActiveRecipeVersion(db: ScopedDb, recipeId: string) {
  const organizationId = await catalogOrganizationId(db);
  await requireRecipe(db, recipeId);
  const versions = await db.restaurantRecipeVersion.findMany({
    where: { organizationId, recipeId },
    select: { id: true, status: true, versionNumber: true },
  });
  return resolveActiveVersion(versions as VersionRecord[]);
}

/**
 * Read a single recipe version by id, whatever its status. SUPERSEDED versions
 * are never deleted (GOV-2), so this is the public, capability-gated path a
 * console uses to render historical recipe state; it does not resolve the active
 * version — it returns exactly the version asked for. Missing id is NOT_FOUND.
 */
export async function getRecipeVersion(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const version = await db.restaurantRecipeVersion.findUnique({ where: { organizationId, id } });
  if (!version) throw new RecipeError('Recipe version not found.', 'NOT_FOUND');
  return version;
}

/**
 * List every version of a recipe, newest version number first. Superseded and
 * draft versions are included so a console can render the full history/timeline
 * (GOV-2); the recipe must exist in scope.
 */
export async function listRecipeVersions(db: ScopedDb, recipeId: string) {
  const organizationId = await catalogOrganizationId(db);
  await requireRecipe(db, recipeId);
  return db.restaurantRecipeVersion.findMany({
    where: { organizationId, recipeId },
    orderBy: { versionNumber: 'desc' },
  });
}
