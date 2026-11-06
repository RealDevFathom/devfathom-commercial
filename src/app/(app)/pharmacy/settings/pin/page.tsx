import type { Metadata } from 'next';

import { OperatorPinConsole } from '@/components/pharmacy/operator-pin-console';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { pharmacyOperatorPinRouter } from '@/server/routers/pharmacy-operator-pin';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy approval PIN' };

/**
 * Owner/manager approval PIN enrolment for pharmacy-only tenants. Licensed by
 * `pharmacy-core`; the session organization is the only tenant.
 */
export default async function PharmacyOperatorPinPage() {
  const ctx = await createTRPCContext();
  const caller = pharmacyOperatorPinRouter.createCaller(ctx);
  let initial: Awaited<ReturnType<typeof caller.status>>;
  try {
    initial = await caller.status();
  } catch {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy"
          heading="Approval PIN"
          description="Owners and managers confirm sensitive actions, such as lost-demand drafts, with a personal PIN."
        />
        <SectionCard title="This page is not available to you" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Only a pharmacy owner or manager can set an approval PIN. Ask the owner to assign you
            the Manager role.
          </p>
        </SectionCard>
      </main>
    );
  }
  const user = ctx.session!.user;
  const isOwner = user.role === 'ADMIN';
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Approval PIN"
        description={
          isOwner
            ? 'Set or reset the personal PIN each owner and manager uses to confirm sensitive actions.'
            : 'Set or change the personal PIN you use to confirm sensitive actions.'
        }
      />
      <SectionCard title={isOwner ? 'Owners and managers' : 'Your PIN'} titleLevel={2}>
        <OperatorPinConsole initial={initial} currentUserId={user.id} isOwner={isOwner} />
      </SectionCard>
    </main>
  );
}
