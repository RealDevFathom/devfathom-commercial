import { Prisma, type PrismaClient } from '@/generated/prisma/client';
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

export class PharmacyOrganizationNotOperationalError extends Error {
  constructor() {
    super('PHARMACY_ORGANIZATION_NOT_OPERATIONAL');
    this.name = 'PharmacyOrganizationNotOperationalError';
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
    !stringValues(branch.ruleSet.licenceCategories).includes(branch.licenceCategory) ||
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

  assertBranchMayOperate(
    {
      ...profile,
      ruleSet: profile.jurisdictionRuleSet,
      auditDenied,
    },
    { ...action, at }
  );
}

/**
 * Transactional admission gate for every pharmacy sale write. The organization
 * and branch locks serialize lifecycle/profile changes with the decision, so a
 * profile cannot be withdrawn between admission and the protected write.
 */
export async function assertPharmacySaleMayProceed(
  db: PrismaClient,
  organizationId: string,
  branchId: string,
  operation: 'SALE_CREATE' | 'SALE_SETTLE'
): Promise<void> {
  const organizations = await db.$queryRaw<Array<{ status: string }>>(Prisma.sql`
    SELECT status FROM organizations
    WHERE id = ${organizationId}
    FOR SHARE
  `);
  if (!organizations[0] || !['ACTIVE', 'GRACE'].includes(organizations[0].status)) {
    throw new PharmacyOrganizationNotOperationalError();
  }

  const branches = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM pharmacy_branches
    WHERE id = ${branchId} AND "organizationId" = ${organizationId} AND active = true
    FOR SHARE
  `);
  if (!branches[0]) throw new BranchOperationDeniedError('PROFILE_MISSING');

  await assertStoredBranchMayOperate(db, organizationId, branchId, {
    name: operation,
    requiresQualifiedPerson: true,
  });
}
