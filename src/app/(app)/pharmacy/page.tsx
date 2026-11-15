import { Download } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PharmacyOnboardingConsole } from '@/components/pharmacy/onboarding-console';
import { FbrTier1Summary } from '@/components/pharmacy/fbr-tier1-summary';
import { LicenceRenewalBanner } from '@/components/pharmacy/licence-renewal-banner';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { buttonVariants } from '@/components/ui/button';
import { isLiveOrganizationOwner } from '@/lib/pharmacy/owner-data-export';
import { pharmacyOnboardingRouter } from '@/server/routers/pharmacy-onboarding';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy onboarding' };

/**
 * PLAT-03 — the pharmacy workspace home.
 *
 * Rendered on the server so the twelve steps are on screen in the first paint,
 * with no spinner between the operator and the thing they came to read. The
 * permission-denied state is a card in the same geometry as the loaded content
 * rather than a redirect, so an operator without the module learns why.
 */
export default async function PharmacyOnboardingPage() {
  const ctx = await createTRPCContext();
  const caller = pharmacyOnboardingRouter.createCaller(ctx);
  let overview: Awaited<ReturnType<typeof caller.overview>>;
  try {
    overview = await caller.overview();
  } catch {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy"
          heading="Onboarding"
          description="The twelve steps between a new pharmacy workspace and its first legal sale."
        />
        <SectionCard title="Onboarding is not available to you" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Your workspace administrator can see these steps. If you are the administrator and this
            workspace has no pharmacy licence, your DevFathom account manager assigns it.
          </p>
        </SectionCard>
      </div>
    );
  }

  // #709 — the Tier-1 self-check prompt is additive: if it cannot be read,
  // the rest of the page still renders.
  // #720 — renewal reminders are additive in the same way.
  const [fbrTier1, renewals] = await Promise.all([
    caller.fbrTier1Status().catch(() => null),
    caller.licenceRenewals().catch(() => []),
  ]);
  // DEV-93 — the owner's "no lock-in" export, offered only to the live owner.
  const userId = ctx.session?.user?.id;
  const organizationId = ctx.organization?.id;
  const owner =
    !!userId &&
    !!organizationId &&
    !ctx.session?.user?.isSupportSession &&
    (await isLiveOrganizationOwner(ctx.db, organizationId, userId).catch(() => false));

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Onboarding"
        description="The twelve steps between a new pharmacy workspace and its first legal sale. Each step says what it needs and where to do it."
        actions={
          owner ? (
            <Link
              href="/pharmacy/settings/data-export"
              className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
            >
              <Download aria-hidden /> Download my data
            </Link>
          ) : null
        }
      />
      <LicenceRenewalBanner reminders={renewals} />
      <PharmacyOnboardingConsole initial={overview} />
      {fbrTier1 ? <FbrTier1Summary status={fbrTier1} /> : null}
    </div>
  );
}
