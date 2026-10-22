import type { Metadata } from 'next';

import {
  RestaurantCatalogConsole,
  type CatalogSnapshot,
} from '@/components/restaurant/catalog/catalog-console';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

export const metadata: Metadata = { title: 'Restaurant catalog' };

async function loadCatalog() {
  const actor = await resolveTenantActor();
  if (!actor?.session.user) {
    return { snapshot: null, canRead: false, canWrite: false, loadError: true };
  }

  return withTenantDb(actor.organization.id, async (db) => {
    const entitlements = await resolveOrganizationEntitlements(actor.organization.id, db);
    if (!hasModule(entitlements, 'restaurant-menu')) {
      return { snapshot: null, canRead: false, canWrite: false, loadError: false };
    }

    const subject = subjectFromSession(actor.session.user);
    const canRead = await can(subject, 'menu:read', undefined, { db, source: 'TRPC' });
    if (!canRead) {
      return { snapshot: null, canRead: false, canWrite: false, loadError: false };
    }
    const canWrite = await can(subject, 'menu:write', undefined, { db, source: 'TRPC' });
    const [
      categories,
      products,
      modifierGroups,
      allergens,
      units,
      conversions,
      ingredients,
      recipes,
    ] = await Promise.all([
      db.restaurantCategory.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, parentId: true, name: true, sortOrder: true },
      }),
      db.restaurantProduct.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          categoryId: true,
          type: true,
          status: true,
          name: true,
          description: true,
          sortOrder: true,
          variants: {
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            select: { id: true, productId: true, name: true, sortOrder: true },
          },
          modifierGroups: {
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, modifierGroupId: true, sortOrder: true },
          },
          comboComponentGroups: {
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              comboProductId: true,
              name: true,
              minChoose: true,
              maxChoose: true,
              sortOrder: true,
              options: {
                orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
                select: {
                  id: true,
                  componentGroupId: true,
                  productId: true,
                  variantId: true,
                  priceDelta: true,
                  sortOrder: true,
                },
              },
            },
          },
          allergens: { select: { id: true, allergenId: true } },
        },
      }),
      db.restaurantModifierGroup.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          minSelect: true,
          maxSelect: true,
          options: {
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            select: {
              id: true,
              modifierGroupId: true,
              name: true,
              priceDelta: true,
              sortOrder: true,
            },
          },
        },
      }),
      db.restaurantAllergen.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      db.restaurantUnit.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, abbreviation: true },
      }),
      db.restaurantUnitConversion.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true, fromUnitId: true, toUnitId: true, factor: true },
      }),
      db.restaurantIngredient.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          baseUnitId: true,
          referenceCost: true,
          allergens: { select: { id: true, allergenId: true } },
        },
      }),
      db.restaurantRecipe.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          productId: true,
          variantId: true,
          name: true,
          versions: {
            orderBy: { versionNumber: 'desc' },
            select: {
              id: true,
              recipeId: true,
              versionNumber: true,
              status: true,
              yieldQuantity: true,
              yieldUnitId: true,
              portionCount: true,
              notes: true,
              activatedAt: true,
              supersededAt: true,
              lines: {
                orderBy: { sortOrder: 'asc' },
                select: {
                  id: true,
                  recipeVersionId: true,
                  ingredientId: true,
                  subRecipeId: true,
                  quantity: true,
                  unitId: true,
                  sortOrder: true,
                  approvedSubstitutes: {
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                    select: { id: true, substituteIngredientId: true },
                  },
                },
              },
            },
          },
        },
      }),
    ]);

    const snapshot = JSON.parse(
      JSON.stringify({
        categories,
        products,
        modifierGroups,
        allergens,
        units,
        conversions,
        ingredients,
        recipes,
      })
    ) as CatalogSnapshot;
    return { snapshot, canRead, canWrite, loadError: false };
  });
}

export default async function RestaurantCatalogPage() {
  let state;
  try {
    state = await loadCatalog();
  } catch {
    state = { snapshot: null, canRead: false, canWrite: false, loadError: true };
  }
  return <RestaurantCatalogConsole {...state} />;
}
