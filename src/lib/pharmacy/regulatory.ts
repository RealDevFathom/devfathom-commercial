import type { PrismaClient } from '@/generated/prisma/client';
import { recordAudit } from '@/server/audit';

export type BranchOperationDenialReason =
  | 'PROFILE_MISSING'
  | 'RULE_SET_UNCONFIRMED'
  | 'RULE_SET_PENDING_LEGAL_REVIEW'
  | 'LICENCE_INVALID'
  | 'QUALIFIED_PERSON_COVERAGE_MISSING'
  | 'SCHEDULE_NOT_PERMITTED';

export class BranchOperationDeniedError extends Error {
  constructor(readonly reason: BranchOperationDenialReason) {
    super(reason);
    this.name = 'BranchOperationDeniedError';
  }
}

export type BranchOperationAction = {
  name: string;
  at?: Date;
  schedule?: string;
  requiresQualifiedPerson?: boolean;
};

export type BranchRegulatoryState = {
  branchId: string;
  licenceCategory: string;
  licenceValidFrom: Date;
  licenceValidTo: Date;
  licenceEvidenceFileRef: string;
  permittedSchedules: readonly string[];
  qualifiedPersonRegistration: string;
  qualifiedPersonValidFrom: Date;
  qualifiedPersonValidTo: Date;
  qualifiedPersonCoverageRosterRef: string;
  ruleSet: {
    code?: string;
    licenceCategories: unknown;
    permittedSchedules: unknown;
    pharmacistCoverageRule: unknown;
  };
  auditDenied: (reason: BranchOperationDenialReason, action: BranchOperationAction) => void;
};

export type BranchRegulatoryStatus = {
  effective: boolean;
  inForce: boolean;
  licenceExpired: boolean;
  qualifiedPersonCoverageExpired: boolean;
};

type RuleField = { provisional?: boolean; pendingLegalReview?: boolean; values?: unknown };

const PENDING_LEGAL_REVIEW_ENVIRONMENTS = new Set(['staging', 'pilot']);

/**
 * Existing #129 legal-review contract: development/tests and explicit staging or
 * pilot builds may exercise these rules. Production fails closed, including an
 * absent or unrecognised APP_ENV; publishing choices is not legal confirmation.
 */
export function pendingLegalReviewAllowed(env: Record<string, string | undefined> = process.env) {
  if (env.NODE_ENV !== 'production') return true;
  return PENDING_LEGAL_REVIEW_ENVIRONMENTS.has(env.APP_ENV ?? '');
}

function ruleField(value: unknown): RuleField {
  return value && typeof value === 'object' ? (value as RuleField) : {};
}

function stringValues(value: unknown): readonly string[] {
  const values = ruleField(value).values;
  return Array.isArray(values) && values.every((item) => typeof item === 'string') ? values : [];
}

function permits(values: readonly string[], value: string): boolean {
  return values.includes('*') || values.includes(value);
}

/**
 * PLAT-02 fail-closed primitive. Every denial is typed and audited before it is
 * thrown; callers cannot downgrade it to a warning by inspecting a boolean.
 */
export function assertBranchMayOperate(
  branch: BranchRegulatoryState,
  action: BranchOperationAction
): void {
  const at = action.at ?? new Date();
  const deny = (reason: BranchOperationDenialReason): never => {
    branch.auditDenied(reason, action);
    throw new BranchOperationDeniedError(reason);
  };

  const relevantRules = [
    branch.ruleSet.licenceCategories,
    branch.ruleSet.permittedSchedules,
    branch.ruleSet.pharmacistCoverageRule,
  ];
  if (relevantRules.some((field) => ruleField(field).provisional !== false)) {
    deny('RULE_SET_UNCONFIRMED');
  }
  if (
    relevantRules.some((field) => {
      const rule = ruleField(field);
      // Old Sindh v1 had no review flag. Only explicit false can confirm it;
      // missing/malformed flags must not make a legacy profile production-ready.
      return (
        rule.pendingLegalReview === true ||
        (branch.ruleSet.code === 'PK-SD' && rule.pendingLegalReview !== false)
      );
    }) &&
    !pendingLegalReviewAllowed()
  ) {
    deny('RULE_SET_PENDING_LEGAL_REVIEW');
  }

  if (
    !branch.licenceCategory.trim() ||
    !branch.licenceEvidenceFileRef.trim() ||
    !permits(stringValues(branch.ruleSet.licenceCategories), branch.licenceCategory) ||
    at < branch.licenceValidFrom ||
    at >= branch.licenceValidTo
  ) {
    deny('LICENCE_INVALID');
  }

  if (
    action.requiresQualifiedPerson !== false &&
    (!branch.qualifiedPersonRegistration.trim() ||
      !branch.qualifiedPersonCoverageRosterRef.trim() ||
      at < branch.qualifiedPersonValidFrom ||
      at >= branch.qualifiedPersonValidTo)
  ) {
    deny('QUALIFIED_PERSON_COVERAGE_MISSING');
  }

  if (
    action.schedule &&
    (!branch.permittedSchedules.includes(action.schedule) ||
      !permits(stringValues(branch.ruleSet.permittedSchedules), action.schedule))
  ) {
    deny('SCHEDULE_NOT_PERMITTED');
  }
}

/** Resolve appended rules consistently for enforcement and the profile's displayed status. */
export async function resolveEffectiveJurisdictionRuleSet(
  db: Pick<PrismaClient, 'jurisdictionRuleSet'>,
  original: BranchRegulatoryState['ruleSet'] & { code: string },
  at: Date
) {
  // Equal effective dates are resolved by version, including when a profile
  // still references an older immutable rule set.
  const latestRules = await db.jurisdictionRuleSet.findFirst({
    where: {
      code: original.code,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
  });
  return latestRules ?? original;
}

/**
 * Read-side status for a regulatory profile, evaluated by the same fail-closed
 * primitive used by dispensing and activation. This prevents a profile from
 * being presented as "in force" after the operation gate has started refusing
 * it, including at the exact instant a licence or coverage period ends.
 */
export function evaluateBranchRegulatoryStatus(
  branch: Omit<BranchRegulatoryState, 'auditDenied'>,
  effective: boolean,
  at: Date
): BranchRegulatoryStatus {
  let inForce = effective;
  if (effective) {
    try {
      assertBranchMayOperate(
        { ...branch, auditDenied: () => undefined },
        { name: 'REGULATORY_PROFILE_VIEW', at, requiresQualifiedPerson: true }
      );
    } catch (error) {
      if (!(error instanceof BranchOperationDeniedError)) throw error;
      inForce = false;
    }
  }

  return {
    effective,
    inForce,
    licenceExpired: effective && at >= branch.licenceValidTo,
    qualifiedPersonCoverageExpired: effective && at >= branch.qualifiedPersonValidTo,
  };
}

export async function assertStoredBranchMayOperate(
  db: PrismaClient,
  organizationId: string,
  branchId: string,
  action: BranchOperationAction
): Promise<void> {
  const at = action.at ?? new Date();
  const profile = await db.branchRegulatoryProfile.findFirst({
    where: {
      organizationId,
      branchId,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    include: { jurisdictionRuleSet: true },
    orderBy: { effectiveFrom: 'desc' },
  });
  const auditDenied = (reason: BranchOperationDenialReason, deniedAction: BranchOperationAction) =>
    recordAudit({
      organizationId,
      actorType: 'SYSTEM',
      source: 'SYSTEM',
      category: 'PHARMACY_REGULATORY',
      operation: 'OTHER',
      action: 'pharmacy.branch_operation_denied',
      targetType: 'PharmacyBranch',
      targetId: branchId,
      outcome: 'FAILURE',
      errorCode: reason,
      errorMessage: 'Branch operation denied by regulatory guard.',
      metadata: { operation: deniedAction.name, schedule: deniedAction.schedule ?? null },
    });

  if (!profile) {
    auditDenied('PROFILE_MISSING', action);
    throw new BranchOperationDeniedError('PROFILE_MISSING');
  }

  const ruleSet = await resolveEffectiveJurisdictionRuleSet(db, profile.jurisdictionRuleSet, at);

  assertBranchMayOperate(
    {
      ...profile,
      ruleSet,
      auditDenied,
    },
    { ...action, at }
  );
}
