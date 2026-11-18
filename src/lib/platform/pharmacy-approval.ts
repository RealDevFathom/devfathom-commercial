/**
 * DEV-905 — the super admin's manual approval of a pharmacy after onboarding.
 *
 * Approval is not a command of its own. It is the existing lifecycle transition to
 * ACTIVE (`organization.transition`), so the server's activation preflight (commercial
 * package, modules, administrator, production deployment, the pharmacy regulatory
 * profile and every onboarding gate) runs exactly as it always has, and only an
 * operator holding `organizations:security:write` can run it. Nothing approves a
 * pharmacy automatically.
 *
 * The transition requires an operator reason. The approval note is optional, so the
 * reason written to the immutable lifecycle and audit ledgers is a fixed approval
 * sentence, followed by the note when the operator gave one. The ledger already
 * records who ran the transition and when.
 *
 * Pure, so the approval form and its tests share one wording.
 */

export const PHARMACY_APPROVAL_REASON = 'Pharmacy approved by DevFathom after onboarding review.';

/** The transition reason allows 500 characters; the fixed sentence and "Note: " take the rest. */
export const PHARMACY_APPROVAL_NOTE_MAX_LENGTH = 400;

export function pharmacyApprovalReason(note?: string | null): string {
  const trimmed = (note ?? '').trim().slice(0, PHARMACY_APPROVAL_NOTE_MAX_LENGTH);
  return trimmed ? `${PHARMACY_APPROVAL_REASON} Note: ${trimmed}` : PHARMACY_APPROVAL_REASON;
}

/** The payload the approval sends: the same lifecycle transition the console has always run. */
export function pharmacyApprovalCommand(organizationId: string, note?: string | null) {
  return {
    action: 'organization.transition' as const,
    payload: {
      id: organizationId,
      status: 'ACTIVE' as const,
      reason: pharmacyApprovalReason(note),
    },
  };
}
