import type { Metadata } from 'next';

import { ControlledWitnessSettings } from '@/components/pharmacy/controlled-witness-settings';
import { BranchAssignmentsConsole } from '@/components/pharmacy/branch-assignments';
import { OtherBranchAvailabilityConsole } from '@/components/pharmacy/other-branch-availability-setting';
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
  let availability: Awaited<ReturnType<typeof caller.otherBranchAvailability>>;
  let witnesses: Awaited<ReturnType<typeof caller.controlledWitnessSettings>>;
  try {
    [initial, availability, witnesses] = await Promise.all([
      caller.list(),
      caller.otherBranchAvailability(),
      caller.controlledWitnessSettings(),
    ]);
  } catch {
    return (
      <div className="min-w-0 space-y-6">
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
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Branch assignments"
        description="Assign an active pharmacy member to a branch, or remove an assignment. Administrators can still open every branch."
      />
      <SectionCard title="Who works at which branch" titleLevel={2}>
        <BranchAssignmentsConsole initial={initial} />
      </SectionCard>
      <SectionCard title="Require a second pharmacist for controlled medicines" titleLevel={2}>
        <ControlledWitnessSettings initial={witnesses} />
      </SectionCard>
      <SectionCard title="Availability at your other branches" titleLevel={2}>
        <OtherBranchAvailabilityConsole initial={availability} />
      </SectionCard>
    </div>
  );
}
