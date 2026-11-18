/**
 * DEV-905: where a pharmacy stands with DevFathom approval, in the owner's words.
 *
 * A pharmacy organization starts in ONBOARDING and cannot sell until a super admin
 * approves it by hand, which makes it ACTIVE (DEV-905, owner decision 18 Nov). Nothing
 * approves a pharmacy automatically. While it waits, the
 * dashboard and the counter say which of two things is true: onboarding is complete and
 * DevFathom has still to approve it, or which onboarding steps are still open.
 *
 * Pure and database-free, so the counter (a client component), the dashboard and their
 * tests share one wording. The server decides the state; this module only names it.
 */

export type PharmacyApprovalStatus =
  /** ACTIVE: DevFathom approved the pharmacy, and it can sell. */
  | { state: 'APPROVED'; approvedAt: string | null }
  /** ONBOARDING with every onboarding step done: only DevFathom approval is left. */
  | { state: 'AWAITING_APPROVAL' }
  /** ONBOARDING with steps still open, named in walk order. */
  | { state: 'ONBOARDING_OPEN'; openSteps: readonly string[] }
  /** Any other lifecycle state (suspended, in grace, terminated): not an approval question. */
  | { state: 'NOT_ACTIVE' };

export const PHARMACY_AWAITING_APPROVAL_MESSAGE =
  'Onboarding is complete. This pharmacy is waiting for DevFathom approval before it can sell.';

export const PHARMACY_APPROVED_MESSAGE = 'DevFathom has approved this pharmacy. It can sell now.';

/** The onboarding page an owner or administrator finishes the open steps on. */
export const PHARMACY_ONBOARDING_HREF = '/pharmacy';

function joined(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function pharmacyOnboardingOpenMessage(openSteps: readonly string[]): string {
  if (openSteps.length === 0) {
    return 'This pharmacy is still onboarding, so it cannot sell yet.';
  }
  const open = openSteps.length === 1 ? 'This onboarding step is' : 'These onboarding steps are';
  return `This pharmacy is still onboarding, so it cannot sell yet. ${open} still open: ${joined(openSteps)}.`;
}

/**
 * The status for an organization's lifecycle state and its onboarding readiness.
 * `readiness` is only read for an ONBOARDING organization.
 */
export function pharmacyApprovalStatus(input: {
  status: string;
  activatedAt?: Date | string | null;
  readiness?: { ready: boolean; openSteps: readonly string[] } | null;
}): PharmacyApprovalStatus {
  if (input.status === 'ACTIVE') {
    const at = input.activatedAt ?? null;
    return { state: 'APPROVED', approvedAt: at instanceof Date ? at.toISOString() : at };
  }
  if (input.status !== 'ONBOARDING') return { state: 'NOT_ACTIVE' };
  if (input.readiness?.ready) return { state: 'AWAITING_APPROVAL' };
  return { state: 'ONBOARDING_OPEN', openSteps: input.readiness?.openSteps ?? [] };
}

/** The one-line message for a waiting or approved pharmacy, or null when none applies. */
export function pharmacyApprovalMessage(status: PharmacyApprovalStatus): string | null {
  switch (status.state) {
    case 'APPROVED':
      return PHARMACY_APPROVED_MESSAGE;
    case 'AWAITING_APPROVAL':
      return PHARMACY_AWAITING_APPROVAL_MESSAGE;
    case 'ONBOARDING_OPEN':
      return pharmacyOnboardingOpenMessage(status.openSteps);
    default:
      return null;
  }
}

/** How long the dashboard keeps telling the owner the pharmacy was just approved. */
export const RECENT_APPROVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function isRecentApproval(status: PharmacyApprovalStatus, now: Date): boolean {
  if (status.state !== 'APPROVED' || !status.approvedAt) return false;
  const at = Date.parse(status.approvedAt);
  return Number.isFinite(at) && now.getTime() - at >= 0 && now.getTime() - at < RECENT_APPROVAL_MS;
}

/** True when the dashboard has something to say: waiting, open steps, or a recent approval. */
export function showsPharmacyApprovalNotice(
  status: PharmacyApprovalStatus | null,
  now: Date
): status is PharmacyApprovalStatus {
  if (!status || pharmacyApprovalMessage(status) === null) return false;
  return status.state !== 'APPROVED' || isRecentApproval(status, now);
}
