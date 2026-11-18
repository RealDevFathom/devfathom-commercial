import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  PHARMACY_ONBOARDING_HREF,
  pharmacyApprovalMessage,
  showsPharmacyApprovalNotice,
  type PharmacyApprovalStatus,
} from '@/lib/pharmacy/approval-status';

/**
 * DEV-905 — the pharmacy dashboard's approval notice.
 *
 * While the pharmacy waits, it says plainly whether onboarding is complete and only
 * DevFathom approval is left, or which onboarding steps are still open (with the page
 * that finishes them, for someone who can). For a week after approval it says the
 * pharmacy is approved and can sell; the server reads the state on every load, so
 * nobody has to sign out and in again to see it. It renders nothing otherwise.
 */
export function PharmacyApprovalNotice({
  approval,
  canFinishOnboarding,
  now = new Date(),
}: {
  approval: PharmacyApprovalStatus | null;
  canFinishOnboarding: boolean;
  now?: Date;
}) {
  if (!showsPharmacyApprovalNotice(approval, now)) return null;
  const message = pharmacyApprovalMessage(approval);

  const approved = approval.state === 'APPROVED';
  const waiting = approval.state === 'AWAITING_APPROVAL';
  return (
    <SectionCard
      eyebrow="DevFathom approval"
      title={approved ? 'Pharmacy approved' : waiting ? 'Waiting for approval' : 'Onboarding open'}
      titleLevel={2}
      className={approved ? 'border-success/40' : 'border-warning/40'}
      actions={
        <StatusPill
          status={approval.state}
          tone={approved ? 'success' : 'warning'}
          label={approved ? 'Approved' : waiting ? 'Awaiting approval' : 'Onboarding'}
        />
      }
      data-pharmacy-approval={approval.state}
    >
      <div className="space-y-3 text-sm">
        <p role="status" className="text-text-body">
          {message}
        </p>
        {approval.state === 'ONBOARDING_OPEN' ? (
          canFinishOnboarding ? (
            <Link
              href={PHARMACY_ONBOARDING_HREF}
              className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
            >
              Finish the onboarding steps
            </Link>
          ) : (
            <p className="text-text-muted">Ask your owner or manager to finish these steps.</p>
          )
        ) : null}
      </div>
    </SectionCard>
  );
}
