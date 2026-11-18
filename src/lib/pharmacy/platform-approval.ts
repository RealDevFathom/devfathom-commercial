/**
 * DEV-905 — the super admin's manual approval of a pharmacy, and the ONE place the
 * operating gates consult it.
 *
 * Owner decision (18 Nov): approval is totally manual, and once a super admin approves
 * a pharmacy "nothing is needed": the checks that would otherwise stop it from running
 * at all no longer refuse it. The fact is `Organization.platformApprovedAt`, which only
 * the platform control plane can write (the `organization.pharmacy.approve` and
 * `organization.pharmacy.approval.withdraw` commands, guarded again by a database
 * trigger). Nothing sets it automatically.
 *
 * What an approval overrides — the standing gates that stop a pharmacy operating at all:
 * - ORGANIZATION_NOT_ACTIVE while the organization is still ONBOARDING;
 * - the activation preflight (base activation gates, the regulatory profile and every
 *   pharmacy onboarding gate);
 * - the branch's regulatory standing for ordinary operations: PROFILE_MISSING,
 *   BRANCH_INACTIVE, PROFILE_PREMISES_MISMATCH, RULE_SET_UNCONFIRMED, LICENCE_INVALID
 *   and QUALIFIED_PERSON_COVERAGE_MISSING.
 *
 * What it never overrides:
 * - a later SUSPENDED, TERMINATED or PURGING state — a deliberate platform decision made
 *   after the approval; resuming the organization brings the approval back into effect;
 * - per-sale rules: an Rx, restricted or controlled line (an operation that needs the
 *   pharmacist present or names a schedule) still meets the full branch check, the
 *   prescription and pharmacist verification, controlled witnesses, refund and discount
 *   approvals, stock, tax and money rules, which all live outside these gates.
 *
 * Withdrawing the approval clears the fact, and every gate refuses exactly as before.
 */

import type { BranchOperationAction } from './regulatory';

/** Lifecycle states in which an approval lets a pharmacy run. */
const APPROVAL_OPERATING_STATUSES: ReadonlySet<string> = new Set(['ONBOARDING', 'ACTIVE', 'GRACE']);

export type PlatformApprovalFacts = {
  status: string;
  vertical?: string | null;
  platformApprovedAt?: Date | string | null;
};

/** True when a platform operator has approved this pharmacy and not withdrawn it. */
export function hasPlatformApproval(organization: PlatformApprovalFacts | null | undefined) {
  if (!organization || !organization.platformApprovedAt) return false;
  return organization.vertical === undefined || organization.vertical === 'PHARMACY';
}

/** True when the approval is in force now: approved, and not suspended or terminated since. */
export function platformApprovalInEffect(organization: PlatformApprovalFacts | null | undefined) {
  return Boolean(
    organization &&
    hasPlatformApproval(organization) &&
    APPROVAL_OPERATING_STATUSES.has(organization.status)
  );
}

/**
 * A per-sale regulated act: dispensing or paying for an Rx, restricted or controlled
 * line (pharmacist presence), or an act naming a schedule. Approval never waives these.
 */
export function isPerSaleRegulatedAction(action: BranchOperationAction): boolean {
  return action.requiresPharmacistPresence === true || Boolean(action.schedule);
}

/**
 * The operating gate's question: does the approval let this operation past the
 * organization- and branch-level standing checks? Ordinary operations, yes; per-sale
 * regulated acts, no (they still run the full branch check).
 */
export function platformApprovalWaivesBranchGate(
  organization: PlatformApprovalFacts | null | undefined,
  action: BranchOperationAction
): boolean {
  return platformApprovalInEffect(organization) && !isPerSaleRegulatedAction(action);
}

/** One unmet check recorded with an approval, as the queue and the organization page name it. */
export type PlatformApprovalCheck = { key: string; label: string };

/** Reads the stored `platformApprovalUnmetChecks` JSON back, dropping anything malformed. */
export function readPlatformApprovalChecks(value: unknown): PlatformApprovalCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { key, label } = item as { key?: unknown; label?: unknown };
    return typeof key === 'string' && typeof label === 'string' ? [{ key, label }] : [];
  });
}
