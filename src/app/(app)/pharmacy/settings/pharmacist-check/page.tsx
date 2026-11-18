import type { Metadata } from 'next';

import {
  PharmacistCheckSetting,
  type PharmacistCheckHistoryEntry,
} from '@/components/pharmacy/pharmacist-check-setting';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { pharmacyPharmacistCheckRouter } from '@/server/routers/pharmacy-pharmacist-check';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacist check at each sale' };

const HEADER = {
  eyebrow: 'Pharmacy',
  heading: 'Pharmacist check at each sale',
  description:
    'Whether a pharmacist must check prescription-only and controlled medicines, and a prescription be recorded, before they are sold.',
};

/**
 * DEV-911 — the owner setting for the pharmacist check and prescription record at each sale.
 * Everyone in the pharmacy can see the state; only the owner can change it, and the server
 * refuses anyone else whatever this page shows.
 */
export default async function PharmacistCheckSettingPage() {
  const ctx = await createTRPCContext();
  const caller = pharmacyPharmacistCheckRouter.createCaller(ctx);
  let read: Awaited<ReturnType<typeof caller.policy>>;
  try {
    read = await caller.policy();
  } catch {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader {...HEADER} />
        <SectionCard title="This setting could not be shown" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Sales follow the setting stored on the server. If it cannot be read, the pharmacist
            check stays on. Reload the page to try again.
          </p>
        </SectionCard>
      </div>
    );
  }
  const history: PharmacistCheckHistoryEntry[] = read.canManage
    ? await caller.history().catch(() => [])
    : [];

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader {...HEADER} />
      <PharmacistCheckSetting
        policy={read.policy}
        canManage={read.canManage}
        disclaimerVersion={read.disclaimerVersion}
        history={history}
        timeZone={ctx.organization?.timezone}
      />
    </div>
  );
}
