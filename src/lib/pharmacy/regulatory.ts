import type { PrismaClient } from '@/generated/prisma/client';
import { recordAudit } from '@/server/audit';

export type BranchOperationDenialReason =
  | 'PROFILE_MISSING'
  | 'RULE_SET_UNCONFIRMED'
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
    licenceCategories: unknown;
    permittedSchedules: unknown;
    pharmacistCoverageRule: unknown;
  };
  auditDenied: (reason: BranchOperationDenialReason, action: BranchOperationAction) => void;
};

type RuleField = { provisional?: boolean; values?: unknown };

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

  assertBranchMayOperate(
    {
      ...profile,
      ruleSet: profile.jurisdictionRuleSet,
      auditDenied,
    },
    { ...action, at }
  );
}
