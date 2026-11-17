/**
 * DEV-860: why a counter cannot start a sale, in words that name what is missing.
 *
 * The server refuses a new bill (`pharmacySales.create`) or a line (`addLine`) with a
 * reason code: a regulatory gate denial (`BranchOperationDenialReason`), the caller's
 * own missing branch assignment, or a closed drawer. The ready-to-sell check on the
 * counter (`pharmacySales.saleReadiness`) reports the same codes before the first scan.
 * This module only maps those codes to text and to the setup page that clears them;
 * every check stays on the server.
 *
 * Pure and database-free, so the counter and its tests share one mapping.
 */

import type { BranchOperationDenialReason } from './regulatory';

/** A refusal the operator's own account causes: they are not assigned to the branch. */
export const BRANCH_NOT_ASSIGNED = 'BRANCH_NOT_ASSIGNED';

/** Ready-to-sell only: no second pharmacist holds an active staff PIN to countersign. */
export const NO_INDEPENDENT_PHARMACIST = 'NO_INDEPENDENT_PHARMACIST';

export type CounterSetupReason =
  | BranchOperationDenialReason
  | typeof BRANCH_NOT_ASSIGNED
  | typeof NO_INDEPENDENT_PHARMACIST
  | 'DRAWER_NOT_OPEN';

type SetupGuidance = {
  /** What is missing, in one sentence. */
  message: string;
  /** Where an owner or administrator clears it, when a page exists for it. */
  fix: ((branchId: string) => { href: string; label: string }) | null;
  /** The next step for an owner or administrator when no page clears it. */
  fixerNote?: string;
  /** The operator clears it on the counter itself (the drawer), so nobody else is asked. */
  selfService?: true;
};

const regulatoryFix = (label: string) => (branchId: string) => ({
  href: `/pharmacy/regulatory?branch=${encodeURIComponent(branchId)}`,
  label,
});

export const COUNTER_SETUP_GUIDANCE: Record<CounterSetupReason, SetupGuidance> = {
  ORGANIZATION_NOT_ACTIVE: {
    message: 'This workspace is not active, so the counter cannot sell.',
    fix: null,
    fixerNote: 'Contact DevFathom support to reactivate the workspace.',
  },
  PROFILE_MISSING: {
    message: 'This branch has no regulatory profile in force, so it cannot sell yet.',
    fix: regulatoryFix('Add the branch regulatory profile'),
  },
  BRANCH_INACTIVE: {
    message: 'This branch is not active, so it cannot sell.',
    fix: () => ({ href: '/organization', label: 'Open organization administration' }),
  },
  PROFILE_PREMISES_MISMATCH: {
    message:
      'The branch regulatory profile names a different province or address from this branch.',
    fix: regulatoryFix('Correct the branch regulatory profile'),
  },
  RULE_SET_UNCONFIRMED: {
    message:
      'The province rules for this branch are still provisional, so sales stay blocked until they are confirmed.',
    fix: null,
    fixerNote: 'Contact DevFathom support to confirm the province rules.',
  },
  LICENCE_INVALID: {
    message:
      'This branch has no valid licence on file: the licence category, its evidence document or its dates are missing or out of date.',
    fix: regulatoryFix('Update the branch licence'),
  },
  QUALIFIED_PERSON_COVERAGE_MISSING: {
    message:
      'This branch has no qualified pharmacist cover in date: the registration, the duty roster or the cover dates are missing.',
    fix: regulatoryFix('Update the qualified pharmacist cover'),
  },
  SCHEDULE_NOT_PERMITTED: {
    message: 'The branch licence does not permit selling medicines of this schedule.',
    fix: regulatoryFix('Review the permitted schedules'),
  },
  PHARMACIST_NOT_PRESENT: {
    message:
      'No pharmacist is on duty under this branch’s presence hours, so prescription, restricted and controlled medicines cannot be sold now.',
    fix: regulatoryFix('Review the pharmacist presence hours'),
  },
  BRANCH_NOT_ASSIGNED: {
    message: 'You are not assigned to this branch, so you cannot sell here.',
    fix: () => ({ href: '/pharmacy/settings/branches', label: 'Open branch assignments' }),
  },
  NO_INDEPENDENT_PHARMACIST: {
    message:
      'No second pharmacist has an active staff PIN, so controlled medicines cannot be countersigned.',
    fix: null,
    fixerNote: 'Give another pharmacist an active staff PIN.',
  },
  DRAWER_NOT_OPEN: {
    message: 'The cash drawer on this counter is not open. Open it before the first bill.',
    fix: null,
    selfService: true,
  },
};

/** Shown to an operator who cannot clear a setup gap themselves. */
export const ASK_OWNER_OR_MANAGER = 'Ask your owner or manager to set this up.';

/**
 * Shown before any branch loads, when the server says the caller is assigned to no
 * active branch (`counterBranches.setupReason`). It names only the caller's own standing.
 */
export const COUNTER_NO_ASSIGNED_BRANCH_MESSAGE =
  'You are not assigned to an active branch, so this counter cannot sell.';

export function isCounterSetupReason(value: unknown): value is CounterSetupReason {
  return typeof value === 'string' && Object.hasOwn(COUNTER_SETUP_GUIDANCE, value);
}

/**
 * The reason code a thrown counter failure carries, when it is a setup gap: the
 * refusal's declared `data.reason` (a missing branch assignment keeps its wording and
 * names its reason there), else a code raised as the message (a regulatory denial).
 */
export function counterSetupReason(error: unknown): CounterSetupReason | null {
  if (!(error instanceof Error)) return null;
  const data = (error as { data?: unknown }).data;
  const declared =
    typeof data === 'object' && data !== null ? (data as { reason?: unknown }).reason : undefined;
  if (isCounterSetupReason(declared)) return declared;
  return isCounterSetupReason(error.message) ? error.message : null;
}

export type CounterSetupAdvice = {
  reason: CounterSetupReason;
  message: string;
  /** Next step for whoever is reading: a fix the owner can make, or whom to ask. */
  nextStep: string | null;
  link: { href: string; label: string } | null;
};

/**
 * The plain message for one setup gap. Owners and administrators (`canFixSetup`) get
 * the link to the page that clears it; everyone else is told to ask their owner or
 * manager. A gap the operator clears on the counter (the drawer) asks nobody.
 */
export function counterSetupAdvice(
  reason: CounterSetupReason,
  options: { canFixSetup: boolean; branchId: string }
): CounterSetupAdvice {
  const guidance = COUNTER_SETUP_GUIDANCE[reason];
  if (guidance.selfService) {
    return { reason, message: guidance.message, nextStep: null, link: null };
  }
  if (!options.canFixSetup) {
    return { reason, message: guidance.message, nextStep: ASK_OWNER_OR_MANAGER, link: null };
  }
  const link = guidance.fix?.(options.branchId) ?? null;
  return { reason, message: guidance.message, nextStep: guidance.fixerNote ?? null, link };
}
