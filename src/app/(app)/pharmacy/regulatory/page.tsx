import type { Metadata } from 'next';

import { PharmacyRegulatoryProfileForm } from '@/components/pharmacy/regulatory-profile-form';
import { FbrTier1Summary } from '@/components/pharmacy/fbr-tier1-summary';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { pharmacyOnboardingRouter } from '@/server/routers/pharmacy-onboarding';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Branch regulatory profile' };

type SearchParams = Promise<{ branch?: string | string[] }>;

/**
 * PLAT-02 — the branch regulatory profile.
 *
 * The branch may arrive in the query string (the checklist and the activation
 * panel both link here), but it is resolved against this organization's own
 * branches server-side; an id from anywhere else simply does not match and the
 * page opens on the operator's first branch instead of another tenant's.
 */
export default async function PharmacyRegulatoryPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const requested = typeof query.branch === 'string' ? query.branch : undefined;
  const ctx = await createTRPCContext();
  const caller = pharmacyOnboardingRouter.createCaller(ctx);
  let initial: Awaited<ReturnType<typeof caller.regulatory>>;
  try {
    initial = await caller.regulatory(requested ? { branchId: requested } : undefined);
  } catch {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy"
          heading="Branch regulatory profile"
          description="Province, premises, licence, permitted schedules, qualified person, tax and retention — effective-dated."
        />
        <SectionCard title="This page is not available to you" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Your workspace administrator maintains the regulatory profile. If you are the
            administrator and this workspace has no pharmacy licence, your DevFathom account manager
            assigns it.
          </p>
        </SectionCard>
      </div>
    );
  }

  // #709 — the Tier-1 self-check prompt is additive: if it cannot be read,
  // the rest of the page still renders.
  const fbrTier1 = await caller.fbrTier1Status().catch(() => null);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Branch regulatory profile"
        description="Province, premises, licence, permitted schedules, qualified person, tax and retention. Every version is kept, so what was true on any past day survives."
      />
      <PharmacyRegulatoryProfileForm initial={initial} />
      {fbrTier1 ? <FbrTier1Summary status={fbrTier1} /> : null}
    </div>
  );
}
