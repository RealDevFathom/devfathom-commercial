import type { Metadata } from 'next';

import { FbrTier1Check } from '@/components/pharmacy/fbr-tier1-check';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { pharmacyOnboardingRouter } from '@/server/routers/pharmacy-onboarding';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Am I FBR Tier-1?' };

/**
 * #709 — the FBR Tier-1 self-check. Reached from onboarding and from the
 * regulatory settings page; the permission-denied state keeps the same card
 * geometry as the loaded content.
 */
export default async function PharmacyFbrTier1Page() {
  const ctx = await createTRPCContext();
  const caller = pharmacyOnboardingRouter.createCaller(ctx);
  let initial: Awaited<ReturnType<typeof caller.fbrTier1Status>>;
  try {
    initial = await caller.fbrTier1Status();
  } catch {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy · FBR"
          heading="Am I Tier-1?"
          description="A self-check for whether FBR point-of-sale integration applies to this business."
        />
        <SectionCard title="This page is not available to you" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Your workspace administrator answers the Tier-1 self-check. Ask them for the latest
            result.
          </p>
        </SectionCard>
      </main>
    );
  }

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy · FBR"
        heading="Am I Tier-1?"
        description="Questions about chain membership, location, electricity, wholesale, card-payment POS, notified categories and turnover. The answers and the result are kept, and the check is asked again every twelve months."
      />
      <FbrTier1Check initial={initial} />
    </main>
  );
}
