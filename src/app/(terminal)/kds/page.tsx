import { redirect } from 'next/navigation';
import { can, subjectFromSession } from '@/lib/abac';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import type { Metadata } from 'next';
import { SessionProvider } from 'next-auth/react';

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
  if (
    actor &&
    !(await withTenantDb(actor.session.user.organizationId, (db) =>
      can(subjectFromSession(actor.session.user), 'kitchen:operate', undefined, {
        db,
        source: 'TRPC',
      })
    ))
  )
    redirect('/dashboard');
  const demo = actor?.organization.isDemo === true;
  return (
    <>
      {demo ? (
        <SessionProvider session={actor.session} refetchOnWindowFocus>
          <DemoToolbar seatName={actor.organization.displayName} />
        </SessionProvider>
      ) : null}
      <KdsBoard demo={demo} />
    </>
  );
}
