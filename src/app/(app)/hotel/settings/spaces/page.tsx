import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';

import { HotelFunctionSpacesPanel } from '@/components/hotel/function-spaces-panel';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hotelPropertyRouter } from '@/server/routers/hotel-property';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Function spaces' };

/**
 * PROP-07 — the function spaces settings page.
 *
 * The read runs through the router rather than a direct query, so the page and the
 * API cannot disagree about who may see a property's halls: the same
 * `hotel:property-admin` gate answers both. A caller without it lands on the
 * explanation below instead of an empty list or a raw error.
 *
 * Deliberately minimal: this lane owns spaces, their buffers and the exclusion
 * constraint underneath them. The diary that shows what is booked in each space is
 * the banquet lane's (H6).
 */
export default async function HotelFunctionSpacesPage() {
  const ctx = await createTRPCContext();
  const caller = hotelPropertyRouter.createCaller(ctx);
  let initial: Awaited<ReturnType<typeof caller.spaces.list>>;
  try {
    initial = await caller.spaces.list();
  } catch (error) {
    const code = error instanceof TRPCError ? error.code : null;
    const denied = code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
    const missingProperty = code === 'NOT_FOUND';
    // Unexpected failures belong to the route error boundary, including its retry action.
    if (!denied && !missingProperty) throw error;
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Hospitality"
          heading="Function spaces"
          description="The halls, lawns and boardrooms this property sells, how they can be laid out, and how long each one takes to turn around."
        />
        <SectionCard
          title={
            denied ? 'This page is not available to you' : 'This workspace has no property yet'
          }
          titleLevel={2}
        >
          <p className="text-sm text-text-muted">
            {denied
              ? 'Function spaces are maintained by your workspace administrator. Sign in with an account that can manage this property, or ask your administrator for access.'
              : 'Ask your DevFathom account manager to complete property provisioning, then reload this page.'}
          </p>
        </SectionCard>
      </main>
    );
  }

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Hospitality"
        heading="Function spaces"
        description="The halls, lawns and boardrooms this property sells, how they can be laid out, and how long each one takes to turn around."
      />
      <HotelFunctionSpacesPanel initial={initial} />
    </main>
  );
}
