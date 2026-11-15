import type { Metadata } from 'next';

import { SupplierPriceListsConsole } from '@/components/pharmacy/supplier-price-lists';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { actorCanProcure } from '@/lib/pharmacy/procurement-access';
import { AccessState, PurchasingHeader, PurchasingTabs } from '../_components/console-chrome';
import { PURCHASING_ROUTE, tenantContext } from '../_lib/console';

export const metadata: Metadata = { title: 'Price lists · Pharmacy purchasing' };

const ROUTE = `${PURCHASING_ROUTE}/price-lists`;
const HEADING = 'Supplier price lists';
const DESCRIPTION =
  'Import a distributor price list, see every trade-price and MRP change against your records, and approve shelf-price drafts one by one. Importing never changes a price.';

/** DEV-681 — supplier price-list import and price-change alerts. */
export default async function PharmacySupplierPriceListsPage() {
  const ctx = await tenantContext();
  if (!ctx)
    return <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled={false} />;
  const moduleEnabled = hasModule(ctx.entitlements, 'pharmacy-procurement');
  if (!moduleEnabled || !ctx.session?.user || !(await actorCanProcure(ctx.db, ctx.session.user.id)))
    return <AccessState heading={HEADING} description={DESCRIPTION} moduleEnabled={moduleEnabled} />;
  // The server refuses approvals without this capability; offer the control
  // only to the people it lets through (Manager, Owner and the solo owner).
  const canApprove = await can(
    subjectFromSession(ctx.session.user),
    'pharmacy:procurement-approve',
    undefined,
    { db: ctx.db, source: 'TRPC', ip: ctx.requestMeta?.ip ?? null }
  );
  return (
    <main className="min-w-0 space-y-6">
      <PurchasingHeader heading={HEADING} description={DESCRIPTION} />
      <PurchasingTabs active={ROUTE} />
      <SupplierPriceListsConsole canApprove={canApprove} />
    </main>
  );
}
