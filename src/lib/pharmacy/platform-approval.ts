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
 * What an approval overrides — the gates that stop a pharmacy operating at all:
 * - ORGANIZATION_NOT_ACTIVE while the organization is still ONBOARDING;
 * - the activation preflight (base activation gates, the regulatory profile and every
 *   pharmacy onboarding gate);
 * - the branch's regulatory gate on every operation, ordinary or regulated: a missing or
 *   inoperable profile (PROFILE_MISSING, BRANCH_INACTIVE, PROFILE_PREMISES_MISMATCH,
 *   RULE_SET_UNCONFIRMED, LICENCE_INVALID), no qualified person
 *   (QUALIFIED_PERSON_COVERAGE_MISSING), and the profile's own presence-hours and
 *   schedule limits (PHARMACIST_NOT_PRESENT, SCHEDULE_NOT_PERMITTED), which need that
 *   profile and its pharmacist ("even if there's no pharmacist ... nothing is needed").
 *
 * What it never overrides:
 * - a later SUSPENDED, TERMINATED or PURGING state — a deliberate platform decision made
 *   after the approval; resuming the organization brings the approval back into effect;
 * - per-sale rules, which live outside these gates and run on every sale whether or not
 *   the pharmacy is approved: the pharmacist's dispensing grant for an Rx or restricted
 *   line, the pharmacist-attached prescription and signed review, the controlled-medicine
 *   witness PIN and register entry, refund and discount approvals, expired or recalled
 *   stock, stock, tax and money rules.
 *
 * Withdrawing the approval clears the fact, and every gate refuses exactly as before.
 */

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
 * The operating gate's question: does the approval let this operation past the branch's
 * regulatory gate? Yes, for every operation, while the approval is in effect. The
 * per-sale rules are separate code that this answer never reaches.
 */
export function platformApprovalWaivesBranchGate(
  organization: PlatformApprovalFacts | null | undefined
): boolean {
  return platformApprovalInEffect(organization);
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
