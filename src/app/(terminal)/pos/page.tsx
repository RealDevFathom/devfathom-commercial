import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import {
  resolveOrganizationByHost,
  isTenantLifecycleAccessible,
  TENANT_HOST_HEADER,
} from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { SessionProvider } from 'next-auth/react';

import { OrderPad } from '@/components/restaurant/pos/order-pad';
import { DemoToolbar } from '@/lib/demo/toolbar';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

export const metadata: Metadata = {
  title: 'Restaurant Register',
  description: 'Device-authenticated restaurant order and checkout console.',
  robots: { index: false, follow: false, nocache: true },
};

export default async function PosPage() {
  const actor = await resolveTenantActor();
  // Device-only terminals have no Auth.js session. Resolve their host without
  // requiring a staff login; terminal APIs still authenticate the device itself.
  const requestHeaders = await headers();
  const organization =
    actor?.organization ??
    (await resolveOrganizationByHost(
      requestHeaders.get(TENANT_HOST_HEADER) ??
        requestHeaders.get('x-forwarded-host') ??
        requestHeaders.get('host')
    ));
  if (!organization || !isTenantLifecycleAccessible(organization.status)) notFound();
  const entitlements = await withTenantDb(organization.id, (db) =>
    resolveOrganizationEntitlements(organization.id, db)
  );
  if (!hasModule(entitlements, 'restaurant-pos')) notFound();
  const demo = actor?.organization.isDemo === true;
  return (
    <>
      {demo ? (
        <SessionProvider session={actor.session} refetchOnWindowFocus>
          <DemoToolbar seatName={actor.organization.displayName} />
        </SessionProvider>
      ) : null}
      <OrderPad demo={demo} />
    </>
  );
}
