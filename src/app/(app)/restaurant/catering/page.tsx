import type { Metadata } from 'next';

import { CateringConsole } from '@/components/restaurant/catering/catering-console';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

export const metadata: Metadata = { title: 'Restaurant catering' };

export default async function RestaurantCateringPage() {
  const actor = await resolveTenantActor();
  return <CateringConsole currency={actor?.organization.currency ?? null} />;
}
