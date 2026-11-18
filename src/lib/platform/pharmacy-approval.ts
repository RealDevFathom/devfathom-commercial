/**
 * DEV-905 — the super admin's manual approval of a pharmacy, as the console sends it.
 *
 * Owner decision (18 Nov): approval is totally manual, and a super admin may approve a
 * pharmacy whatever its state. The server recomputes the checks that are not met at
 * that moment and refuses unless the operator confirmed exactly that list, so approving
 * past an unmet check is always an explicit choice. The approval is recorded on the
 * organization (who, when, the note and the unmet checks) and in the platform audit
 * ledger; withdrawing it is a command of its own, audited the same way. Only an
 * operator holding the lifecycle permission (`organizations:security:write`) can run
 * either. Nothing approves a pharmacy automatically.
 *
 * Both commands are sensitive platform commands, so they carry an operator reason. The
 * approval note is optional, so the approval's reason is a fixed sentence, followed by
 * the note when the operator gave one.
 *
 * Pure, so the forms, the server and their tests share one wording.
 */

export const PHARMACY_APPROVE_ACTION = 'organization.pharmacy.approve';
export const PHARMACY_APPROVAL_WITHDRAW_ACTION = 'organization.pharmacy.approval.withdraw';

export const PHARMACY_APPROVAL_REASON = 'Pharmacy approved by DevFathom after onboarding review.';

/** The reason allows 500 characters; the fixed sentence and "Note: " take the rest. */
export const PHARMACY_APPROVAL_NOTE_MAX_LENGTH = 400;

/** The withdrawal reason has the sensitive-command bounds. */
export const PHARMACY_APPROVAL_WITHDRAW_REASON_MIN_LENGTH = 10;
export const PHARMACY_APPROVAL_WITHDRAW_REASON_MAX_LENGTH = 500;

export function pharmacyApprovalNote(note?: string | null): string | null {
  const trimmed = (note ?? '').trim().slice(0, PHARMACY_APPROVAL_NOTE_MAX_LENGTH);
  return trimmed || null;
}

export function pharmacyApprovalReason(note?: string | null): string {
  const trimmed = pharmacyApprovalNote(note);
  return trimmed ? `${PHARMACY_APPROVAL_REASON} Note: ${trimmed}` : PHARMACY_APPROVAL_REASON;
}

/**
 * The approval payload. `confirmedUnmetChecks` is the list of unmet check keys the
 * operator saw and confirmed; the server refuses unless it matches its own list now.
 */
export function pharmacyApprovalCommand(
  organizationId: string,
  note?: string | null,
  confirmedUnmetChecks: readonly string[] = []
) {
  const trimmed = pharmacyApprovalNote(note);
  return {
    action: PHARMACY_APPROVE_ACTION,
    payload: {
      id: organizationId,
      reason: pharmacyApprovalReason(note),
      ...(trimmed ? { note: trimmed } : {}),
      confirmedUnmetChecks: [...confirmedUnmetChecks],
    },
  };
}

export function pharmacyApprovalWithdrawCommand(organizationId: string, reason: string) {
  return {
    action: PHARMACY_APPROVAL_WITHDRAW_ACTION,
    payload: { id: organizationId, reason: reason.trim() },
  };
}

/** True when the operator confirmed exactly the checks the server finds unmet now. */
export function confirmsUnmetChecks(
  unmetKeys: readonly string[],
  confirmedKeys: readonly string[]
): boolean {
  const unmet = new Set(unmetKeys);
  const confirmed = new Set(confirmedKeys);
  return unmet.size === confirmed.size && [...unmet].every((key) => confirmed.has(key));
}
