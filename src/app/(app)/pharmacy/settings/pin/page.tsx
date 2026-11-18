import type { Metadata } from 'next';

import { OwnPinSettings } from '@/components/pharmacy/own-pin-settings';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hasModule } from '@/lib/entitlements';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Your PIN' };

const HEADER = {
  eyebrow: 'Pharmacy settings',
  heading: 'Your PIN',
  description:
    'Create or change the PIN you enter when an approval asks for your own PIN. You confirm it with your account password.',
};

/**
 * DEV-931 — every pharmacy member's own approval PIN. The server (`pharmacyPin`) enforces
 * the password re-entry, the PIN rules, the organization and the support-session refusal;
 * this page only frames the form.
 */
export default async function PharmacyOwnPinPage() {
  const ctx = await createTRPCContext();
  const user = ctx.session?.user;
  const member =
    !!user?.id &&
    !!ctx.organization?.id &&
    user.organizationId === ctx.organization.id &&
    hasModule(ctx.entitlements, 'pharmacy-core');

  if (!member) {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader {...HEADER} />
        <SectionCard title="Your PIN is not available here" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Sign in to your pharmacy workspace to create or change your PIN.
          </p>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader {...HEADER} />
      <OwnPinSettings onboardingHref={user.role === 'ADMIN' ? '/pharmacy' : undefined} />
    </div>
  );
}
