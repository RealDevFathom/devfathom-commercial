import { Download, ShieldCheck } from 'lucide-react';
import { TRPCError } from '@trpc/server';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PharmacyOnboardingConsole } from '@/components/pharmacy/onboarding-console';
import { FbrTier1Summary } from '@/components/pharmacy/fbr-tier1-summary';
import { LicenceRenewalBanner } from '@/components/pharmacy/licence-renewal-banner';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { buttonVariants } from '@/components/ui/button';
import { pharmacyLandingPath } from '@/lib/pharmacy/landing';
import { isLiveOrganizationOwner } from '@/lib/pharmacy/owner-data-export';
import { LOYALTY_EARN_PRESETS } from '@/lib/pharmacy/loyalty-program';
import { pharmacyAccessRouter } from '@/server/routers/pharmacy-access';
import { pharmacyLoyaltyRouter } from './loyalty/loyalty-router';
import { OnboardingLoyaltyStep } from './loyalty/onboarding-loyalty-step';
import { pharmacyOnboardingRouter } from '@/server/routers/pharmacy-onboarding';
import { createTRPCContext, type TRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy onboarding' };

/**
 * PLAT-03 — the pharmacy workspace home.
 *
 * Rendered on the server so the twelve steps are on screen in the first paint,
 * with no spinner between the operator and the thing they came to read.
 *
 * DEV-497: onboarding is administration. A member the server refuses it to
 * (a cashier, a pharmacist) is sent to their own working page instead of a
 * dead end. Any other failure keeps the card, in the same geometry as the
 * loaded content, so an administrator learns why.
 */
async function memberLanding(ctx: TRPCContext) {
  const access = await pharmacyAccessRouter
    .createCaller(ctx)
    .navigation()
    .catch(() => null);
  return pharmacyLandingPath(access?.capabilities ?? [], ctx.entitlements?.enabledModules);
}

export default async function PharmacyOnboardingPage() {
  const ctx = await createTRPCContext();
  const caller = pharmacyOnboardingRouter.createCaller(ctx);
  let overview: Awaited<ReturnType<typeof caller.overview>>;
  try {
    overview = await caller.overview();
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'FORBIDDEN')
      redirect(await memberLanding(ctx));
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
  // DEV-814 — the optional loyalty question, also additive. It reads the rate through the
  // loyalty router, so only a user who may set the rate is asked; a pharmacy already active
  // or with a rate set keeps the loyalty page's own notice instead.
  const [fbrTier1, renewals, earnRate] = await Promise.all([
    caller.fbrTier1Status().catch(() => null),
    caller.licenceRenewals().catch(() => []),
    overview.organization.status === 'ACTIVE'
      ? null
      : pharmacyLoyaltyRouter
          .createCaller(ctx)
          .earnRate()
          .catch(() => null),
  ]);
  const askLoyalty = !!earnRate && !earnRate.current;
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
            <div className="flex flex-wrap gap-2">
              <Link
                href="/pharmacy/settings/pharmacist-check"
                className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
              >
                <ShieldCheck aria-hidden /> Pharmacist check at each sale
              </Link>
              <Link
                href="/pharmacy/settings/data-export"
                className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
              >
                <Download aria-hidden /> Download my data
              </Link>
            </div>
          ) : null
        }
      />
      <LicenceRenewalBanner reminders={renewals} />
      <PharmacyOnboardingConsole initial={overview} />
      {askLoyalty ? (
        <OnboardingLoyaltyStep
          presets={LOYALTY_EARN_PRESETS.map((preset) => ({ id: preset.id, label: preset.label }))}
        />
      ) : null}
      {fbrTier1 ? <FbrTier1Summary status={fbrTier1} /> : null}
    </div>
  );
}
