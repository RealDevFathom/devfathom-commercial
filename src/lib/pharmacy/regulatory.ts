import type { PrismaClient } from '@/generated/prisma/client';
import { recordAudit } from '@/server/audit';

export type BranchOperationDenialReason =
  | 'ORGANIZATION_NOT_ACTIVE'
  | 'PROFILE_MISSING'
  | 'BRANCH_INACTIVE'
  | 'PROFILE_PREMISES_MISMATCH'
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

/** The platform placeholder rule set a SuperAdmin applies before real licences exist. */
export const PLACEHOLDER_RULE_SET_ID = 'pk_pb_placeholder_v1';

/** The branch a profile describes, as the binding check needs it. */
export type RegulatoryProfileBranchSite = {
  active: boolean;
  provinceCode: string;
  addressLine: string;
  city: string;
};

/** The parts of a stored profile that bind it to its branch. */
export type RegulatoryProfileBindingFields = {
  provinceCode: string;
  premises: unknown;
  isPlaceholder?: boolean | null;
  jurisdictionRuleSetId?: string | null;
};

export function normalizeRegulatoryProvince(value: string): string {
  return value.trim().toUpperCase().replace(/^PK-/, '');
}

export function normalizeRegulatoryPremises(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

function premisesFields(premises: unknown): { addressLine?: unknown; city?: unknown } {
  return premises && typeof premises === 'object' && !Array.isArray(premises)
    ? (premises as { addressLine?: unknown; city?: unknown })
    : {};
}

/**
 * Legacy placeholder (#660). Placeholder profiles issued on the
 * `pk_pb_placeholder_v1` rule set before premises binding existed recorded only
 * `{ label }` as their premises. These append-only rows cannot authorize branch
 * operations. Re-applying the placeholder closes them and appends an
 * effective-dated, audited successor bound to the branch address and city.
 */
export function isLegacyPlaceholderProfile(profile: RegulatoryProfileBindingFields): boolean {
  if (profile.isPlaceholder !== true || profile.jurisdictionRuleSetId !== PLACEHOLDER_RULE_SET_ID) {
    return false;
  }
  const premises = premisesFields(profile.premises);
  return premises.addressLine === undefined && premises.city === undefined;
}

/**
 * The single binding rule shared by the operation guard, the readiness gate and
 * the read-side status: a profile only speaks for an active branch whose
 * province, address and city it names. Returns the denial, or null when bound.
 */
export function regulatoryProfileBindingDenial(
  profile: RegulatoryProfileBindingFields,
  branch: RegulatoryProfileBranchSite
): Extract<BranchOperationDenialReason, 'BRANCH_INACTIVE' | 'PROFILE_PREMISES_MISMATCH'> | null {
  if (!branch.active) return 'BRANCH_INACTIVE';
  if (
    normalizeRegulatoryProvince(profile.provinceCode) !==
    normalizeRegulatoryProvince(branch.provinceCode)
  ) {
    return 'PROFILE_PREMISES_MISMATCH';
  }
  const premises = premisesFields(profile.premises);
  const address = normalizeRegulatoryPremises(premises.addressLine);
  const city = normalizeRegulatoryPremises(premises.city);
  if (
    !address ||
    !city ||
    address !== normalizeRegulatoryPremises(branch.addressLine) ||
    city !== normalizeRegulatoryPremises(branch.city)
  ) {
    return 'PROFILE_PREMISES_MISMATCH';
  }
  return null;
}

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
  binding?: { profile: RegulatoryProfileBindingFields; site: RegulatoryProfileBranchSite }
): BranchRegulatoryStatus {
  // The same branch binding the stored guard applies, so a profile that names
  // another province or premises is never shown "in force" while activation and
  // readiness refuse it.
  const bound = !binding || regulatoryProfileBindingDenial(binding.profile, binding.site) === null;
  let inForce = effective && bound;
  if (inForce) {
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
    include: { jurisdictionRuleSet: true, branch: true },
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

  const bindingDenial = regulatoryProfileBindingDenial(profile, profile.branch);
  if (bindingDenial) {
    auditDenied(bindingDenial, action);
    throw new BranchOperationDeniedError(bindingDenial);
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

/** Lifecycle states in which an organization may operate (docs/admin-platform/lifecycle.md). */
const OPERATING_ORGANIZATION_STATUSES = new Set(['ACTIVE', 'GRACE']);

/**
 * Runtime gate for regulated pharmacy operations. Tenant host access is also
 * available while onboarding, so operations must independently require the
 * persisted organization lifecycle state as well as the branch profile.
 *
 * Must run inside the transaction that performs the operation. The organization
 * row and the branch's open profile rows are share-locked so a concurrent
 * lifecycle transition or profile revocation either commits before this read
 * (and is seen) or waits until the operation's transaction ends.
 */
export async function assertStoredPharmacyMayOperate(
  db: PrismaClient,
  organizationId: string,
  branchId: string,
  action: BranchOperationAction
): Promise<void> {
  await db.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR SHARE`;
  await db.$queryRaw`SELECT id FROM pharmacy_branch_regulatory_profiles
    WHERE "organizationId" = ${organizationId} AND "branchId" = ${branchId}
      AND "effectiveTo" IS NULL
    FOR SHARE`;
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { status: true },
  });
  if (!organization || !OPERATING_ORGANIZATION_STATUSES.has(organization.status)) {
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
      errorCode: 'ORGANIZATION_NOT_ACTIVE',
      errorMessage: 'Branch operation denied by regulatory guard.',
      metadata: { operation: action.name, schedule: action.schedule ?? null },
    });
    throw new BranchOperationDeniedError('ORGANIZATION_NOT_ACTIVE');
  }
  await assertStoredBranchMayOperate(db, organizationId, branchId, action);
}
