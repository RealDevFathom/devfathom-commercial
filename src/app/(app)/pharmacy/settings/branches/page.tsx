import type { Metadata } from 'next';

import { BranchAssignmentsConsole } from '@/components/pharmacy/branch-assignments';
import { CashMemoSettings } from '@/components/pharmacy/cash-memo-settings';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { pharmacyBranchAssignmentsRouter } from '@/server/routers/pharmacy-branch-assignments';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy branch assignments' };

/**
 * Owner and administrator assignment of pharmacy members to active branches.
 * The session organization is the only tenant; the page never accepts an
 * organization id from the query string.
 */
export default async function PharmacyBranchAssignmentsPage() {
  const ctx = await createTRPCContext();
  const caller = pharmacyBranchAssignmentsRouter.createCaller(ctx);
  let initial: Awaited<ReturnType<typeof caller.list>>;
  try {
    initial = await caller.list();
  } catch {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy"
          heading="Branch assignments"
          description="Choose which active members may work at each pharmacy branch."
        />
        <SectionCard title="This page is not available to you" titleLevel={2}>
          <p className="text-sm text-text-muted">
            A workspace administrator assigns cashiers and pharmacists to branches.
          </p>
        </SectionCard>
      </main>
    );
  }

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Branch assignments"
        description="Assign pharmacy members to branches and configure the cash memo buyer-name policy. Administrators can still open every branch."
      />
      <SectionCard title="Who works at which branch" titleLevel={2}>
        <BranchAssignmentsConsole initial={initial} />
      </SectionCard>
      <SectionCard title="Cash memo policy" titleLevel={2}>
        <CashMemoSettings branches={initial.branches} />
      </SectionCard>
    </main>
  );
}
