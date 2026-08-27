import type { Metadata } from 'next';

import {
  RestaurantMenuImportConsole,
  type MenuImportSnapshot,
} from '@/components/restaurant/menu-import/menu-import-console';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { listMenuImports } from '@/lib/restaurant/menu-import';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

export const metadata: Metadata = { title: 'Menu import' };

type PageState = {
  snapshot: MenuImportSnapshot | null;
  canImport: boolean;
  loadError: boolean;
};

const DENIED: PageState = { snapshot: null, canImport: false, loadError: false };

async function loadMenuImports(): Promise<PageState> {
  const actor = await resolveTenantActor();
  if (!actor?.session.user) {
    return { snapshot: null, canImport: false, loadError: true };
  }

  return withTenantDb(actor.organization.id, async (db) => {
    const entitlements = await resolveOrganizationEntitlements(actor.organization.id, db);
    if (!hasModule(entitlements, 'restaurant-menu')) return DENIED;

    const subject = subjectFromSession(actor.session.user);
    const canImport = await can(subject, 'menu:import', undefined, { db, source: 'TRPC' });
    if (!canImport) return DENIED;

    // Merge targets are read here rather than through the import router: the
    // R-lane server surface deliberately exposes only the import itself, and a
    // reviewer choosing "merge into existing" needs the ordinary catalog list.
    const [imports, mergeCandidates] = await Promise.all([
      listMenuImports(db),
      db.restaurantProduct.findMany({
        where: { status: 'ACTIVE' },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          variants: {
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            select: { id: true, name: true },
          },
        },
      }),
    ]);

    const snapshot = JSON.parse(JSON.stringify({ imports, mergeCandidates })) as MenuImportSnapshot;
    return { snapshot, canImport, loadError: false };
  });
}

export default async function RestaurantMenuImportPage() {
  let state: PageState;
  try {
    state = await loadMenuImports();
  } catch {
    state = { snapshot: null, canImport: false, loadError: true };
  }
  return <RestaurantMenuImportConsole {...state} />;
}
