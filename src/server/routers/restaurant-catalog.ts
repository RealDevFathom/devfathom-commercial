import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { router, capabilityProcedure } from '../trpc';
import { annotateAudit } from '../audit';
import { CatalogError } from '@/lib/restaurant/catalog';
import { resolveEntitlementLimit, RESTAURANT_BRANDS_LIMIT } from '@/lib/entitlement-limits';
import {
  ensureDefaultBrand,
  createBrand,
  updateBrand,
  setDefaultBrand,
  setBrandStatus,
  createCategory,
  updateCategory,
  deleteCategory,
  createProduct,
  updateProduct,
  setProductStatus,
  listBrands,
  getBrand,
  listCategories,
  listProducts,
  getProduct,
  createVariant,
  updateVariant,
  deleteVariant,
  createModifierGroup,
  updateModifierGroup,
  deleteModifierGroup,
  createModifierOption,
  updateModifierOption,
  deleteModifierOption,
  attachModifierGroup,
  detachModifierGroup,
  createComboGroup,
  updateComboGroup,
  deleteComboGroup,
  createComboOption,
  updateComboOption,
  deleteComboOption,
  attachProductAllergen,
  detachProductAllergen,
} from '@/lib/restaurant/catalog';
import {
  RecipeError,
  createUnit,
  updateUnit,
  deleteUnit,
  upsertConversion,
  deleteConversion,
  createAllergen,
  updateAllergen,
  deleteAllergen,
  createIngredient,
  updateIngredient,
  attachIngredientAllergen,
  detachIngredientAllergen,
  createRecipe,
  createRecipeVersion,
  updateRecipeVersion,
  activateRecipeVersion,
  getActiveRecipeVersion,
  getRecipeVersion,
  listRecipeVersions,
  createRecipeLine,
  updateRecipeLine,
  deleteRecipeLine,
  addRecipeLineSubstitute,
  removeRecipeLineSubstitute,
} from '@/lib/restaurant/recipes';
import {
  VersionImmutabilityError,
  VersionTransitionError,
} from '@/lib/restaurant/effective-dating';
import {
  computeRecipeCost,
  RecipeCostingError,
  type RecipeCostResult,
} from '@/lib/restaurant/recipe-costing';

/**
 * M3-L2 — back-office server surface for canonical catalog + costing substrate.
 *
 * Read procedures gate on `menu:read`; mutations gate on `menu:write`. Both
 * require the `restaurant-menu` module (module-catalog.ts). Tenant scoping is
 * by the RLS-forced `organizationId` default on every row (C1); no input field
 * accepts a `branchId` on any canonical mutation (C2 shadow-copy guard — see
 * named checks in the issue description).
 *
 * C4: every Decimal field returned to the client is serialized as a string via
 * `.toString()` so tRPC/JSON transport stays float-free.
 */

const readProcedure = capabilityProcedure('menu:read');
const writeProcedure = capabilityProcedure('menu:write');

/** Translate catalog/recipe domain errors to tRPC status. Rethrows unknown errors. */
function mapCatalogError(err: unknown): never {
  if (err instanceof CatalogError) {
    const code =
      err.reason === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : err.reason === 'ALREADY_ATTACHED' || err.reason === 'BRAND_LIMIT_REACHED'
          ? 'CONFLICT'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  if (err instanceof RecipeError) {
    const code =
      err.reason === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : err.reason === 'ALREADY_ATTACHED' || err.reason === 'ALREADY_EXISTS'
          ? 'CONFLICT'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  if (err instanceof VersionImmutabilityError || err instanceof VersionTransitionError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  }
  if (err instanceof RecipeCostingError) {
    throw new TRPCError({
      code: err.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST',
      message: err.message,
    });
  }
  throw err;
}

/** Serialize a Decimal field to string (C4). */
function serializeDecimal(value: { toString(): string } | null | undefined): string | null {
  return value != null ? value.toString() : null;
}

/** Serialize the Decimal `yieldQuantity` on a recipe version for transport (C4). */
function serializeRecipeVersion<T extends { yieldQuantity: { toString(): string } | null }>(
  version: T
): Omit<T, 'yieldQuantity'> & { yieldQuantity: string | null } {
  return { ...version, yieldQuantity: serializeDecimal(version.yieldQuantity) };
}

function serializeRecipeCost(cost: RecipeCostResult) {
  return {
    ...cost,
    yieldQuantity: serializeDecimal(cost.yieldQuantity),
    batchCost: cost.batchCost.toString(),
    costPerPortion: serializeDecimal(cost.costPerPortion),
    costPerYieldUnit: serializeDecimal(cost.costPerYieldUnit),
    lines: cost.lines.map((line) => ({
      ...line,
      quantityInBaseUnit: line.quantityInBaseUnit.toString(),
      unitCost: line.unitCost.toString(),
      lineCost: line.lineCost.toString(),
    })),
  };
}

/** Locale-keyed companion for a customer-facing string (D20), matching the L3 menus surface. */
const LOCALIZED = z.record(z.string(), z.string());

const BRAND_STATUS = z.enum(['ACTIVE', 'ARCHIVED']);
const PRODUCT_STATUS = z.enum(['ACTIVE', 'ARCHIVED']);

// ── Shared no-branchId assertion (C2) ────────────────────────────────────────
// All canonical mutation inputs are defined without a `branchId` field. The
// canonical *creation* schemas (createBrand, createProduct) go further and are
// `.strict()`: a caller that tries to smuggle a branch-scoped or shadow-copy
// field (`branchId`, `shadowCopyOfId`, `sourceCanonicalId`, …) is rejected with
// BAD_REQUEST rather than having the field silently stripped — branches cannot
// shadow-copy canonical records.

export const restaurantCatalogRouter = router({
  // ── Brands ──────────────────────────────────────────────────────────────────

  ensureDefaultBrand: writeProcedure
    .input(z.object({ name: z.string().min(1).max(200).optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      try {
        const brand = await ensureDefaultBrand(ctx.db, input?.name);
        return brand;
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  createBrand: writeProcedure
    .input(
      z
        .object({
          name: z.string().min(1).max(200),
          nameLocalized: LOCALIZED.nullable().optional(),
        })
        // C2: canonical brands cannot shadow-copy a branch record. `.strict()`
        // rejects (not strips) any branch-scoped/shadow-copy field such as
        // `branchId` or `shadowCopyOfId` with a BAD_REQUEST at the schema edge.
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const resolution = resolveEntitlementLimit(
          ctx.entitlements.limits as Record<string, number>,
          RESTAURANT_BRANDS_LIMIT
        );
        if (resolution.status === 'missing') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'The restaurant brand entitlement is not configured correctly.',
          });
        }
        const brand = await createBrand(ctx.db, input, resolution.value);
        annotateAudit(ctx, {
          targetType: 'RestaurantBrand',
          targetId: brand.id,
          targetLabel: brand.name,
          description: `Created restaurant brand "${brand.name}"`,
        });
        return brand;
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  updateBrand: writeProcedure
    .input(z.object({ id: z.string(), name: z.string().min(1).max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        return await updateBrand(ctx.db, id, patch);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  setDefaultBrand: writeProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await setDefaultBrand(ctx.db, input.id);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  setBrandStatus: writeProcedure
    .input(z.object({ id: z.string(), status: BRAND_STATUS }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await setBrandStatus(ctx.db, input.id, input.status);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  // ── Read models (menu:read) — catalog console read-contract ───────────────────

  listBrands: readProcedure.query(async ({ ctx }) => {
    try {
      return await listBrands(ctx.db);
    } catch (err) {
      mapCatalogError(err);
    }
  }),

  getBrand: readProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    try {
      return await getBrand(ctx.db, input.id);
    } catch (err) {
      mapCatalogError(err);
    }
  }),

  listCategories: readProcedure.query(async ({ ctx }) => {
    try {
      return await listCategories(ctx.db);
    } catch (err) {
      mapCatalogError(err);
    }
  }),

  listProducts: readProcedure
    .input(
      z
        .object({
          categoryId: z.string().nullable().optional(),
          status: PRODUCT_STATUS.optional(),
          type: z.enum(['ITEM', 'COMBO']).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listProducts(ctx.db, input ?? {});
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  getProduct: readProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    try {
      return await getProduct(ctx.db, input.id);
    } catch (err) {
      mapCatalogError(err);
    }
  }),

  // ── Categories ───────────────────────────────────────────────────────────────

  createCategory: writeProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        parentId: z.string().nullable().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createCategory(ctx.db, input);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  updateCategory: writeProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        parentId: z.string().nullable().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        return await updateCategory(ctx.db, id, patch);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  deleteCategory: writeProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await deleteCategory(ctx.db, input.id);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  // ── Products & variants ──────────────────────────────────────────────────────

  createProduct: writeProcedure
    .input(
      z
        .object({
          name: z.string().min(1).max(200),
          nameLocalized: LOCALIZED.nullable().optional(),
          description: z.string().nullable().optional(),
          descriptionLocalized: LOCALIZED.nullable().optional(),
          type: z.enum(['ITEM', 'COMBO']).optional(),
          categoryId: z.string().nullable().optional(),
          sortOrder: z.number().int().optional(),
        })
        // C2: canonical products cannot shadow-copy a branch/source record.
        // `.strict()` rejects fields like `sourceCanonicalId` or `branchId`
        // rather than silently stripping them.
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const product = await createProduct(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantProduct',
          targetId: product.id,
          targetLabel: product.name,
          description: `Created product "${product.name}"`,
        });
        return product;
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  updateProduct: writeProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().nullable().optional(),
        categoryId: z.string().nullable().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        return await updateProduct(ctx.db, id, patch);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  setProductStatus: writeProcedure
    .input(z.object({ id: z.string(), status: PRODUCT_STATUS }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await setProductStatus(ctx.db, input.id, input.status);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  createVariant: writeProcedure
    .input(
      z.object({
        productId: z.string(),
        name: z.string().min(1).max(200),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createVariant(ctx.db, input);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  updateVariant: writeProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        return await updateVariant(ctx.db, id, patch);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  deleteVariant: writeProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await deleteVariant(ctx.db, input.id);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  // ── Modifier groups & options ────────────────────────────────────────────────

  createModifierGroup: writeProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        minSelect: z.number().int().min(0).optional(),
        maxSelect: z.number().int().min(0).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createModifierGroup(ctx.db, input);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  updateModifierGroup: writeProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        minSelect: z.number().int().min(0).optional(),
        maxSelect: z.number().int().min(0).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        return await updateModifierGroup(ctx.db, id, patch);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  deleteModifierGroup: writeProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await deleteModifierGroup(ctx.db, input.id);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  createModifierOption: writeProcedure
    .input(
      z.object({
        modifierGroupId: z.string(),
        name: z.string().min(1).max(200),
        priceDelta: z.string().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const option = await createModifierOption(ctx.db, input);
        return { ...option, priceDelta: serializeDecimal(option.priceDelta) };
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  updateModifierOption: writeProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        priceDelta: z.string().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        const option = await updateModifierOption(ctx.db, id, patch);
        return { ...option, priceDelta: serializeDecimal(option.priceDelta) };
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  deleteModifierOption: writeProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await deleteModifierOption(ctx.db, input.id);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  attachModifierGroup: writeProcedure
    .input(
      z.object({
        productId: z.string(),
        modifierGroupId: z.string(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await attachModifierGroup(
          ctx.db,
          input.productId,
          input.modifierGroupId,
          input.sortOrder
        );
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  detachModifierGroup: writeProcedure
    .input(z.object({ productId: z.string(), modifierGroupId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await detachModifierGroup(ctx.db, input.productId, input.modifierGroupId);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  // ── Combo component seam ─────────────────────────────────────────────────────

  createComboGroup: writeProcedure
    .input(
      z.object({
        comboProductId: z.string(),
        name: z.string().min(1).max(200),
        minChoose: z.number().int().min(0).optional(),
        maxChoose: z.number().int().min(0).nullable().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createComboGroup(ctx.db, input);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  updateComboGroup: writeProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        minChoose: z.number().int().min(0).optional(),
        maxChoose: z.number().int().min(0).nullable().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        return await updateComboGroup(ctx.db, id, patch);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  deleteComboGroup: writeProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await deleteComboGroup(ctx.db, input.id);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  createComboOption: writeProcedure
    .input(
      z.object({
        componentGroupId: z.string(),
        productId: z.string(),
        variantId: z.string().nullable().optional(),
        priceDelta: z.string().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const option = await createComboOption(ctx.db, input);
        return { ...option, priceDelta: serializeDecimal(option.priceDelta) };
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  updateComboOption: writeProcedure
    .input(
      z.object({
        id: z.string(),
        priceDelta: z.string().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        const option = await updateComboOption(ctx.db, id, patch);
        return { ...option, priceDelta: serializeDecimal(option.priceDelta) };
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  deleteComboOption: writeProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await deleteComboOption(ctx.db, input.id);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  // ── Product allergen links ───────────────────────────────────────────────────

  attachProductAllergen: writeProcedure
    .input(z.object({ productId: z.string(), allergenId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await attachProductAllergen(ctx.db, input.productId, input.allergenId);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  detachProductAllergen: writeProcedure
    .input(z.object({ productId: z.string(), allergenId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await detachProductAllergen(ctx.db, input.productId, input.allergenId);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  // ── Units ────────────────────────────────────────────────────────────────────

  createUnit: writeProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        abbreviation: z.string().max(20).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createUnit(ctx.db, input);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  updateUnit: writeProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(100).optional(),
        abbreviation: z.string().max(20).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        return await updateUnit(ctx.db, id, patch);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  deleteUnit: writeProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await deleteUnit(ctx.db, input.id);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  upsertConversion: writeProcedure
    .input(
      z.object({
        fromUnitId: z.string(),
        toUnitId: z.string(),
        factor: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const conv = await upsertConversion(ctx.db, input.fromUnitId, input.toUnitId, input.factor);
        return { ...conv, factor: serializeDecimal(conv.factor) };
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  deleteConversion: writeProcedure
    .input(z.object({ fromUnitId: z.string(), toUnitId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await deleteConversion(ctx.db, input.fromUnitId, input.toUnitId);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  // ── Allergens ────────────────────────────────────────────────────────────────

  createAllergen: writeProcedure
    .input(z.object({ name: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await createAllergen(ctx.db, input);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  updateAllergen: writeProcedure
    .input(z.object({ id: z.string(), name: z.string().min(1).max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        return await updateAllergen(ctx.db, id, patch);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  deleteAllergen: writeProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await deleteAllergen(ctx.db, input.id);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  // ── Ingredients ──────────────────────────────────────────────────────────────

  createIngredient: writeProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        baseUnitId: z.string(),
        referenceCost: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const ingredient = await createIngredient(ctx.db, input);
        return { ...ingredient, referenceCost: serializeDecimal(ingredient.referenceCost) };
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  updateIngredient: writeProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        baseUnitId: z.string().optional(),
        referenceCost: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        const ingredient = await updateIngredient(ctx.db, id, patch);
        return { ...ingredient, referenceCost: serializeDecimal(ingredient.referenceCost) };
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  attachIngredientAllergen: writeProcedure
    .input(z.object({ ingredientId: z.string(), allergenId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await attachIngredientAllergen(ctx.db, input.ingredientId, input.allergenId);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  detachIngredientAllergen: writeProcedure
    .input(z.object({ ingredientId: z.string(), allergenId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await detachIngredientAllergen(ctx.db, input.ingredientId, input.allergenId);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  // ── Recipes (C3) ─────────────────────────────────────────────────────────────

  createRecipe: writeProcedure
    .input(
      z.object({
        productId: z.string(),
        variantId: z.string().nullable().optional(),
        name: z.string().min(1).max(200),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createRecipe(ctx.db, input);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  createRecipeVersion: writeProcedure
    .input(
      z.object({
        recipeId: z.string(),
        yieldQuantity: z.string().nullable().optional(),
        yieldUnitId: z.string().nullable().optional(),
        portionCount: z.number().int().positive().nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const version = await createRecipeVersion(ctx.db, input);
        return {
          ...version,
          yieldQuantity: serializeDecimal(version.yieldQuantity),
        };
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  updateRecipeVersion: writeProcedure
    .input(
      z.object({
        id: z.string(),
        yieldQuantity: z.string().nullable().optional(),
        yieldUnitId: z.string().nullable().optional(),
        portionCount: z.number().int().positive().nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        const version = await updateRecipeVersion(ctx.db, id, patch);
        return {
          ...version,
          yieldQuantity: serializeDecimal(version.yieldQuantity),
        };
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  activateRecipeVersion: writeProcedure
    .input(z.object({ recipeId: z.string(), versionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const version = await activateRecipeVersion(ctx.db, input.recipeId, input.versionId);
        return {
          ...version,
          yieldQuantity: serializeDecimal(version.yieldQuantity),
        };
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  getActiveRecipeVersion: readProcedure
    .input(z.object({ recipeId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        return await getActiveRecipeVersion(ctx.db, input.recipeId);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  /**
   * Public historical read (GOV-2): fetch a recipe version by id whatever its
   * status. A SUPERSEDED version is never deleted, so this stays readable; the
   * read is capability-gated (menu:read) like every other catalog read.
   */
  getRecipeVersion: readProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        return serializeRecipeVersion(await getRecipeVersion(ctx.db, input.id));
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  listRecipeVersions: readProcedure
    .input(z.object({ recipeId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        const versions = await listRecipeVersions(ctx.db, input.recipeId);
        return versions.map(serializeRecipeVersion);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  getRecipeCost: readProcedure
    .input(z.object({ recipeId: z.string(), versionId: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      try {
        const selector = input.versionId
          ? { organizationId: ctx.entitlements.organizationId, recipeVersionId: input.versionId }
          : { organizationId: ctx.entitlements.organizationId, recipeId: input.recipeId };
        return serializeRecipeCost(await computeRecipeCost(selector));
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  listRecipeCosts: readProcedure
    .input(z.object({ recipeIds: z.array(z.string()).optional() }).optional())
    .query(async ({ ctx, input }) => {
      try {
        const recipeIds =
          input?.recipeIds ??
          (
            await ctx.db.restaurantRecipe.findMany({
              where: { organizationId: ctx.entitlements.organizationId },
              select: { id: true },
              orderBy: { createdAt: 'asc' },
            })
          ).map((recipe) => recipe.id);
        return await Promise.all(
          recipeIds.map(async (recipeId) =>
            serializeRecipeCost(
              await computeRecipeCost({
                organizationId: ctx.entitlements.organizationId,
                recipeId,
              })
            )
          )
        );
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  // ── Recipe lines ─────────────────────────────────────────────────────────────

  createRecipeLine: writeProcedure
    .input(
      z.object({
        recipeVersionId: z.string(),
        ingredientId: z.string().optional(),
        subRecipeId: z.string().optional(),
        quantity: z.string(),
        unitId: z.string(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const line = await createRecipeLine(
          ctx.db,
          input as Parameters<typeof createRecipeLine>[1]
        );
        return { ...line, quantity: serializeDecimal(line.quantity) };
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  updateRecipeLine: writeProcedure
    .input(
      z.object({
        id: z.string(),
        quantity: z.string().optional(),
        unitId: z.string().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        const line = await updateRecipeLine(ctx.db, id, patch);
        return { ...line, quantity: serializeDecimal(line.quantity) };
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  deleteRecipeLine: writeProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await deleteRecipeLine(ctx.db, input.id);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  addRecipeLineSubstitute: writeProcedure
    .input(
      z
        .object({ recipeLineId: z.string().min(1), substituteIngredientId: z.string().min(1) })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await addRecipeLineSubstitute(ctx.db, input);
      } catch (err) {
        mapCatalogError(err);
      }
    }),

  removeRecipeLineSubstitute: writeProcedure
    .input(z.object({ id: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        await removeRecipeLineSubstitute(ctx.db, input.id);
      } catch (err) {
        mapCatalogError(err);
      }
    }),
});
