import type { Metadata } from 'next';
import { OperatingModeSettings } from '@/components/pharmacy/operating-mode-settings';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { pharmacyOperatingModeRouter } from '@/server/routers/pharmacy-operating-mode';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy operating mode' };

export default async function OperatingModePage() {
  const caller = pharmacyOperatingModeRouter.createCaller(await createTRPCContext());
  const settings = await caller.get().catch(() => null);
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
