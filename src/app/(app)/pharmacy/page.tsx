import type { Metadata } from 'next';
import Link from 'next/link';

import { PharmacyOnboardingConsole } from '@/components/pharmacy/onboarding-console';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
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
      <main className="min-w-0 space-y-6">
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
      </main>
    );
  }

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Onboarding"
        description="The twelve steps between a new pharmacy workspace and its first legal sale. Each step says what it needs and where to do it."
      />
      <PharmacyOnboardingConsole initial={overview} />
      {ctx.session?.user?.role === 'ADMIN' ? (
        <SectionCard title="Your data" titleLevel={2}>
          <p className="text-sm text-text-body">
            Download a complete copy of your pharmacy&apos;s data as CSV files you can open anywhere
            or import back into DevFathom.{' '}
            <Link
              className="font-semibold text-text-strong underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              href="/pharmacy/settings/data-export"
            >
              Download my data
            </Link>
          </p>
        </SectionCard>
      ) : null}
    </main>
  );
}
