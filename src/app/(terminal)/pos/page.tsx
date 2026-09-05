import type { Metadata } from 'next';

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
  const demo = actor?.organization.isDemo === true;
  return (
    <>
      {demo ? <DemoToolbar seatName={actor.organization.displayName} /> : null}
      <OrderPad demo={demo} />
    </>
  );
}
