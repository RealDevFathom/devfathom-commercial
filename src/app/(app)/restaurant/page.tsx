import { notFound, redirect } from 'next/navigation';

import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { moduleForPath } from '@/lib/module-catalog';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

/**
 * WHA-1164 — `/restaurant` is a navigational segment, not a surface: every
 * console lives one level below it, so the bare segment used to 404 for every
 * restaurant organization. The board is the operating default, so orders comes
 * first; the rest are the remaining restaurant modules in operating order, one
 * route per module, so an organization that licensed a narrower package still
 * lands somewhere it is entitled to. `/restaurant/reports` is last because it
 * belongs to mandatory Restaurant Core and therefore always resolves for a
 * restaurant organization.
 *
 * Route ownership is never restated here: each candidate is resolved through
 * `moduleForPath`, the same catalog the navigation and the direct-route guard
 * read, so this landing order can never disagree with them.
 */
const RESTAURANT_LANDING_ROUTES = [
  '/restaurant/orders',
  '/restaurant/inventory',
  '/restaurant/purchasing',
  '/restaurant/sop',
  '/restaurant/menus',
  '/restaurant/loyalty',
  '/restaurant/insights',
  '/restaurant/reports',
] as const;

export default async function RestaurantIndexPage() {
  const actor = await resolveTenantActor();
  // The `/(app)` layout already fails closed for an unusable session; this keeps
  // the page honest on its own rather than assuming its parent ran.
  if (!actor?.session.user) notFound();

  const target = await withTenantDb(actor.organization.id, async (db) => {
    const entitlements = await resolveOrganizationEntitlements(actor.organization.id, db);
    return (
      RESTAURANT_LANDING_ROUTES.find((route) => {
        const moduleKey = moduleForPath(route, entitlements.vertical);
        return moduleKey !== null && hasModule(entitlements, moduleKey);
      }) ?? null
    );
  });

  // An organization that holds no restaurant module at all — an AGENCY tenant,
  // for one — keeps exactly the behaviour this segment gave it before: a 404,
  // not a bounce into a console its package does not include.
  if (!target) notFound();

  redirect(target);
}
