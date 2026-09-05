import type { Metadata } from 'next';

import { KdsBoard } from '@/components/restaurant/kds/kds-board';
import { DemoToolbar } from '@/lib/demo/toolbar';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

export const metadata: Metadata = {
  title: 'Kitchen display',
  description: 'Device-authenticated restaurant kitchen display.',
  robots: { index: false, follow: false, nocache: true },
};

export default async function KdsPage() {
  const actor = await resolveTenantActor();
  const demo = actor?.organization.isDemo === true;
  return (
    <>
      {demo ? <DemoToolbar seatName={actor.organization.displayName} /> : null}
      <KdsBoard demo={demo} />
    </>
  );
}
