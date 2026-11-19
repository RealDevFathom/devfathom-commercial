import type { Metadata } from 'next';

import {
  RxSoloShiftSetting,
  type RxSoloShiftHistoryEntry,
} from '@/components/pharmacy/rx-solo-shift-setting';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import type { RxDeclaredSoloSignOff } from '@/lib/pharmacy/rx-solo-shift';
import { pharmacyRxSoloShiftRouter } from '@/server/routers/pharmacy-rx-solo-shift';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'One pharmacist per shift' };

const HEADER = {
  eyebrow: 'Pharmacy',
  heading: 'One pharmacist per shift',
  description:
    'For branches that have several pharmacists on the staff list but one on duty at a time: whether the pharmacist on duty may sign their own prescription check.',
};

/**
 * DEV-960 — the owner setting "One pharmacist per shift", per branch, and the declared solo
 * sign-offs it allowed. Only the owner sees and changes it; the server refuses anyone else
 * whatever this page shows.
 */
export default async function RxSoloShiftSettingPage() {
  const ctx = await createTRPCContext();
  const caller = pharmacyRxSoloShiftRouter.createCaller(ctx);
  let read: Awaited<ReturnType<typeof caller.overview>>;
  try {
    read = await caller.overview();
  } catch {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader {...HEADER} />
        <SectionCard title="This setting could not be shown" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Signatures follow the setting stored on the server. If it cannot be read, it stays off
            and each prescription line is signed by the staff-list rule. Reload the page to try
            again.
          </p>
        </SectionCard>
      </div>
    );
  }
  if (!read.canManage)
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader {...HEADER} />
        <SectionCard title="Only the pharmacy owner can open this" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Ask the owner if your branch runs one pharmacist per shift. At the counter you are told
            whether you can sign a prescription line yourself.
          </p>
        </SectionCard>
      </div>
    );
  // A failed read is null, never an empty list: an empty list would tell the owner there is
  // nothing to review when the records simply could not be read.
  const [signOffs, history] = await Promise.all([
    caller.declaredSignOffs().catch((): RxDeclaredSoloSignOff[] | null => null),
    caller.history().catch((): RxSoloShiftHistoryEntry[] | null => null),
  ]);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader {...HEADER} />
      <RxSoloShiftSetting
        branches={read.branches}
        disclaimerVersion={read.disclaimerVersion}
        signOffs={signOffs}
        history={history}
        timeZone={ctx.organization?.timezone}
      />
    </div>
  );
}
