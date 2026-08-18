import type { Metadata } from 'next';

import {
  RestaurantMenusConsole,
  type MenusSnapshot,
} from '@/components/restaurant/menus/menus-console';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

export const metadata: Metadata = { title: 'Restaurant menus' };

async function loadMenus() {
  const actor = await resolveTenantActor();
  if (!actor?.session.user) {
    return {
      snapshot: null,
      canRead: false,
      canWrite: false,
      canPrice: false,
      canPublish: false,
      loadError: true,
    };
  }

  return withTenantDb(actor.organization.id, async (db) => {
    const entitlements = await resolveOrganizationEntitlements(actor.organization.id, db);
    if (!hasModule(entitlements, 'restaurant-menu')) {
      return {
        snapshot: null,
        canRead: false,
        canWrite: false,
        canPrice: false,
        canPublish: false,
        loadError: false,
      };
    }

    const subject = subjectFromSession(actor.session.user);
    const canRead = await can(subject, 'menu:read', undefined, { db, source: 'TRPC' });
    if (!canRead) {
      return {
        snapshot: null,
        canRead: false,
        canWrite: false,
        canPrice: false,
        canPublish: false,
        loadError: false,
      };
    }

    const [
      canWrite,
      canPrice,
      canPublish,
      brands,
      branches,
      products,
      menus,
      priceLists,
      publications,
    ] = await Promise.all([
      can(subject, 'menu:write', undefined, { db, source: 'TRPC' }),
      can(subject, 'menu:price' as Action, undefined, { db, source: 'TRPC' }),
      can(subject, 'menu:publish' as Action, undefined, { db, source: 'TRPC' }),
      db.restaurantBrand.findMany({
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: { id: true, name: true, status: true, isDefault: true },
      }),
      db.restaurantBranch.findMany({
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: { id: true, name: true, timezone: true, active: true, isDefault: true },
      }),
      db.restaurantProduct.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          status: true,
          variants: {
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            select: { id: true, productId: true, name: true },
          },
        },
      }),
      db.restaurantMenu.findMany({
        orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          brandId: true,
          name: true,
          description: true,
          sections: {
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            select: {
              id: true,
              menuId: true,
              name: true,
              sortOrder: true,
              items: {
                orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
                select: {
                  id: true,
                  sectionId: true,
                  productId: true,
                  variantId: true,
                  displayName: true,
                  sortOrder: true,
                },
              },
            },
          },
        },
      }),
      db.restaurantPriceList.findMany({
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          isDefault: true,
          versions: {
            orderBy: { versionNumber: 'desc' },
            select: {
              id: true,
              priceListId: true,
              versionNumber: true,
              effectiveFrom: true,
              status: true,
              activatedAt: true,
              supersededAt: true,
              entries: {
                orderBy: { createdAt: 'asc' },
                select: {
                  id: true,
                  priceListVersionId: true,
                  productId: true,
                  variantId: true,
                  price: true,
                },
              },
            },
          },
        },
      }),
      db.restaurantBranchMenuPublication.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          branchId: true,
          menuId: true,
          priceListId: true,
          status: true,
          channels: true,
          publishedAt: true,
          retiredAt: true,
          windows: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              publicationId: true,
              menuItemId: true,
              label: true,
              daysOfWeek: true,
              startMinutes: true,
              endMinutes: true,
            },
          },
          exceptions: {
            orderBy: { date: 'asc' },
            select: {
              id: true,
              publicationId: true,
              date: true,
              isClosed: true,
              label: true,
            },
          },
          itemOverrides: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              publicationId: true,
              menuItemId: true,
              isAvailable: true,
              priceOverride: true,
            },
          },
        },
      }),
    ]);

    const snapshot = JSON.parse(
      JSON.stringify({ brands, branches, products, menus, priceLists, publications })
    ) as MenusSnapshot;
    return { snapshot, canRead, canWrite, canPrice, canPublish, loadError: false };
  });
}

export default async function RestaurantMenusPage() {
  let state;
  try {
    state = await loadMenus();
  } catch {
    state = {
      snapshot: null,
      canRead: false,
      canWrite: false,
      canPrice: false,
      canPublish: false,
      loadError: true,
    };
  }
  return <RestaurantMenusConsole {...state} />;
}
