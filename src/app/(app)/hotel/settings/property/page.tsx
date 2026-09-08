import type { Metadata } from 'next';

import { HotelPropertySettingsForm } from '@/components/hotel/property-settings-form';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hotelPropertyRouter } from '@/server/routers/hotel-property';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Property settings' };

/**
 * PROP-01 — the property settings page.
 *
 * The read runs through the router rather than a direct query, so the page and
 * the API cannot disagree about who may see a property: the same
 * `hotel:property-admin` gate answers both. A caller without it lands on the
 * explanation below instead of an empty form or a raw error.
 */
export default async function HotelPropertySettingsPage() {
  const ctx = await createTRPCContext();
  const caller = hotelPropertyRouter.createCaller(ctx);
  let initial: Awaited<ReturnType<typeof caller.get>>;
  try {
    initial = await caller.get();
  } catch {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Hospitality"
          heading="Property settings"
          description="How this property operates, and the facts every reservation, folio and audit is dated and taxed against."
        />
        <SectionCard title="This page is not available to you" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Property settings are maintained by your workspace administrator. If you are the
            administrator and this workspace has no hospitality package, your DevFathom account
            manager assigns it.
          </p>
        </SectionCard>
      </main>
    );
  }

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Hospitality"
        heading="Property settings"
        description="How this property operates, and the facts every reservation, folio and audit is dated and taxed against."
      />
      <HotelPropertySettingsForm initial={initial} />
    </main>
  );
}
