import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';
import { CountVarianceThresholdSettings } from '@/components/pharmacy/count-variance-threshold-settings';
import { OperatingModeSettings } from '@/components/pharmacy/operating-mode-settings';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { pharmacyOperatingModeRouter } from '@/server/routers/pharmacy-operating-mode';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy operating mode' };

export default async function OperatingModePage() {
  const caller = pharmacyOperatingModeRouter.createCaller(await createTRPCContext());
  // Only an authorization refusal means "not available to you"; any other
  // failure (database, configuration) must surface instead of being disguised.
  const settings = await caller.get().catch((error: unknown) => {
    if (error instanceof TRPCError && (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED'))
      return null;
    throw error;
  });
  if (settings) {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy settings"
          heading="Operating mode"
          description="Choose whether this pharmacy uses a solo-owner exception or staffed role separation."
        />
        <SectionCard title="Role separation" titleLevel={2}>
          <OperatingModeSettings initialMode={settings.pharmacyOperatingMode} />
        </SectionCard>
        <SectionCard title="Stock count approval threshold" titleLevel={2}>
          <CountVarianceThresholdSettings
            initialUnits={settings.pharmacyCountVarianceThresholdUnits}
          />
        </SectionCard>
      </main>
    );
  } else {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy settings"
          heading="Operating mode"
          description="Owner-only pharmacy policy."
        />
        <SectionCard title="This setting is not available to you" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Only the pharmacy owner can view or change operating mode.
          </p>
        </SectionCard>
      </main>
    );
  }
}
