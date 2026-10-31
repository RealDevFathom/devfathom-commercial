import type { PrismaClient } from '@/generated/prisma/client';
import { workspaceDateUtc, workspaceTimezone } from '@/lib/timezone';
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

export type BranchRegulatoryStatus = {
  effective: boolean;
  inForce: boolean;
  licenceExpired: boolean;
  qualifiedPersonCoverageExpired: boolean;
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
 * Regulatory profile windows mix two representations:
 *
 * - Operator-entered profiles store date-only boundaries (UTC midnight of the
 *   chosen calendar day). Their start is compared against the workspace
 *   calendar day so a profile effective "today" is in force from local midnight.
 * - Platform placeholder profiles are applied and locked at exact instants.
 *   Their boundaries keep instant semantics: a placeholder is in force from the
 *   moment it is applied and stops the moment it is locked.
 *
 * Ends of operator profiles are compared against the later of the instant and
 * the workspace day, so a date-only end closes at the start of that workspace
 * day while an end stamped at an instant (an operator profile superseded by a
 * placeholder) is never resurrected after that instant.
 */
function laterOf(a: Date, b: Date): Date {
  return a > b ? a : b;
}

export function effectiveRegulatoryProfileWhere(at: Date, calendarDate: Date) {
  const operatorEnd = laterOf(at, calendarDate);
  return {
    OR: [
      {
        isPlaceholder: true,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      {
        isPlaceholder: false,
        effectiveFrom: { lte: calendarDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: operatorEnd } }],
      },
    ],
  };
}

/** In-memory twin of `effectiveRegulatoryProfileWhere`. */
export function isRegulatoryProfileEffective(
  profile: { effectiveFrom: Date; effectiveTo: Date | null; isPlaceholder: boolean },
  at: Date,
  calendarDate: Date
): boolean {
  if (profile.isPlaceholder) {
    return (
      profile.effectiveFrom <= at && (profile.effectiveTo === null || profile.effectiveTo > at)
    );
  }
  return (
    profile.effectiveFrom <= calendarDate &&
    (profile.effectiveTo === null || profile.effectiveTo > laterOf(at, calendarDate))
  );
}

/**
 * PLAT-02 fail-closed primitive. Every denial is typed and audited before it is
 * thrown; callers cannot downgrade it to a warning by inspecting a boolean.
 */
export function assertBranchMayOperate(
  branch: BranchRegulatoryState,
  action: BranchOperationAction,
  timeZone = 'UTC'
): void {
  const at = action.at ?? new Date();
  const calendarDate = workspaceDateUtc(timeZone, at);
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
    calendarDate < branch.licenceValidFrom ||
    at >= branch.licenceValidTo
  ) {
    deny('LICENCE_INVALID');
  }

  if (
    action.requiresQualifiedPerson !== false &&
    (!branch.qualifiedPersonRegistration.trim() ||
      !branch.qualifiedPersonCoverageRosterRef.trim() ||
      calendarDate < branch.qualifiedPersonValidFrom ||
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

/**
 * Read-side status for a regulatory profile, evaluated by the same fail-closed
 * primitive used by dispensing and activation. This prevents a profile from
 * being presented as "in force" after the operation gate has started refusing
 * it, including at the exact instant a licence or coverage period ends.
 */
export function evaluateBranchRegulatoryStatus(
  branch: Omit<BranchRegulatoryState, 'auditDenied'>,
  effective: boolean,
  at: Date,
  timeZone = 'UTC'
): BranchRegulatoryStatus {
  let inForce = effective;
  if (effective) {
    try {
      assertBranchMayOperate(
        { ...branch, auditDenied: () => undefined },
        { name: 'REGULATORY_PROFILE_VIEW', at, requiresQualifiedPerson: true },
        timeZone
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
  const organization = await db.organization.findFirst({
    where: { id: organizationId },
    select: { timezone: true },
  });
  const timeZone = workspaceTimezone(organization?.timezone);
  const calendarDate = workspaceDateUtc(timeZone, at);
  const profile = await db.branchRegulatoryProfile.findFirst({
    where: {
      organizationId,
      branchId,
      ...effectiveRegulatoryProfileWhere(at, calendarDate),
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
    { ...action, at },
    timeZone
  );
}
