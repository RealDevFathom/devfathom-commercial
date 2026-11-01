import { licenceDateStarted, licenceDateValid } from './licence-validity';
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
  timezone?: string;
  branchId: string;
  licenceCategory: string;
  licenceValidFrom: Date;
  licenceValidTo: Date;
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

type RuleField = { provisional?: boolean; pendingLegalReview?: boolean; values?: unknown };

/**
 * Rule sets flagged `pendingLegalReview` (e.g. PK-SD until counsel signs off) may be
 * exercised in development, tests, staging and pilots, but production enforcement
 * refuses them. Fail closed: under NODE_ENV=production only an explicit
 * APP_ENV of `staging` or `pilot` allows them.
 */
export function pendingLegalReviewAllowed(env: Record<string, string | undefined> = process.env) {
  if (env.NODE_ENV !== 'production') return true;
  return env.APP_ENV === 'staging' || env.APP_ENV === 'pilot';
}

function ruleField(value: unknown): RuleField {
  return value && typeof value === 'object' ? (value as RuleField) : {};
}

/**
 * Whether a rule set is still awaiting legal sign-off. PK-SD rows written before
 * the explicit flag existed (v1) count as pending, so Sindh stays behind the
 * production gate until counsel publishes a confirmed version.
 */
export function ruleSetPendingLegalReview(ruleSet: {
  code?: string;
  licenceCategories: unknown;
  permittedSchedules: unknown;
  pharmacistCoverageRule: unknown;
}): boolean {
  const fields = [
    ruleSet.licenceCategories,
    ruleSet.permittedSchedules,
    ruleSet.pharmacistCoverageRule,
  ];
  return (
    fields.some((field) => ruleField(field).pendingLegalReview === true) ||
    (ruleSet.code === 'PK-SD' &&
      fields.some((field) => ruleField(field).pendingLegalReview === undefined))
  );
}

function stringValues(value: unknown): readonly string[] {
  const values = ruleField(value).values;
  return Array.isArray(values) && values.every((item) => typeof item === 'string') ? values : [];
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
  if (ruleSetPendingLegalReview(branch.ruleSet) && !pendingLegalReviewAllowed()) {
    deny('RULE_SET_PENDING_LEGAL_REVIEW');
  }

  if (
    !branch.licenceCategory.trim() ||
    !stringValues(branch.ruleSet.licenceCategories).includes(branch.licenceCategory) ||
    !licenceDateStarted(branch.licenceValidFrom, at, branch.timezone) ||
    !licenceDateValid(branch.licenceValidTo, at, branch.timezone)
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
      !stringValues(branch.ruleSet.permittedSchedules).includes(action.schedule))
  ) {
    deny('SCHEDULE_NOT_PERMITTED');
  }
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

  // Existing profiles can still reference v1; enforce the latest rules in force.
  const latestRules = await db.jurisdictionRuleSet.findFirst({
    where: {
      code: profile.jurisdictionRuleSet.code,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
  });

  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  });
  assertBranchMayOperate(
    {
      ...profile,
      timezone: organization?.timezone ?? undefined,
      ruleSet: latestRules ?? profile.jurisdictionRuleSet,
      auditDenied,
    },
    { ...action, at }
  );
}
