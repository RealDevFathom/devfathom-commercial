import type { PrismaClient } from '@/generated/prisma/client';
import { recordAudit } from '@/server/audit';
import { normalizeRegulatoryProvince } from './regulatory-profile-form';
import { regulatoryProfileInForceWhere, regulatoryStartInstant } from './regulatory-start';

export type BranchOperationDenialReason =
  | 'ORGANIZATION_NOT_ACTIVE'
  | 'PROFILE_MISSING'
  | 'BRANCH_INACTIVE'
  | 'PROFILE_PREMISES_MISMATCH'
  | 'RULE_SET_UNCONFIRMED'
  | 'LICENCE_INVALID'
  | 'QUALIFIED_PERSON_COVERAGE_MISSING'
  | 'SCHEDULE_NOT_PERMITTED'
  | 'PHARMACIST_NOT_PRESENT';

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
  /** The workspace's IANA zone; date-only start dates begin at its local midnight. */
  timeZone?: string | null;
  /**
   * DEV-86: the act needs the qualified person physically present (Rx, restricted or
   * controlled dispensing), so it is refused outside the rule set's presence hours.
   */
  requiresPharmacistPresence?: boolean;
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

export { normalizeRegulatoryProvince, regulatoryStartInstant };

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

const PRESENCE_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function presenceMinutes(value: unknown): number | null {
  if (typeof value !== 'string' || !PRESENCE_TIME.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  return hours! * 60 + minutes!;
}

/**
 * DEV-86: is the qualified person rostered on duty at `at`?
 *
 * `pharmacistCoverageRule.values.presenceHours` is
 * `{ timeZone?: string, windows: [{ days: number[] (0 = Sunday), start: 'HH:MM', end: 'HH:MM' }] }`,
 * evaluated in the rule set's time zone (Asia/Karachi when unset). A window runs from `start`
 * up to, not including, `end` on each listed local weekday; a shift across midnight is two
 * windows. A rule set that declares no `presenceHours` adds no hours restriction beyond the
 * coverage validity period. One that declares them but cannot be read fails closed.
 */
export function pharmacistPresentAt(pharmacistCoverageRule: unknown, at: Date): boolean {
  const values = ruleField(pharmacistCoverageRule).values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return true;
  if (!('presenceHours' in values)) return true;
  const hours = (values as { presenceHours?: unknown }).presenceHours;
  if (!hours || typeof hours !== 'object' || Array.isArray(hours)) return false;
  const { timeZone = 'Asia/Karachi', windows } = hours as { timeZone?: unknown; windows?: unknown };
  if (typeof timeZone !== 'string' || !Array.isArray(windows) || windows.length === 0) return false;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return false;
  }
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  const day = WEEKDAYS.indexOf(part('weekday') ?? '');
  const minute = Number(part('hour')) * 60 + Number(part('minute'));
  if (day < 0 || !Number.isInteger(minute)) return false;
  let present = false;
  for (const window of windows) {
    if (!window || typeof window !== 'object') return false;
    const { days, start, end } = window as { days?: unknown; start?: unknown; end?: unknown };
    const from = presenceMinutes(start);
    const to = presenceMinutes(end);
    if (
      from === null ||
      to === null ||
      from >= to ||
      !Array.isArray(days) ||
      days.length === 0 ||
      !days.every((item) => Number.isInteger(item) && item >= 0 && item <= 6)
    )
      return false;
    if (days.includes(day) && minute >= from && minute < to) present = true;
  }
  return present;
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
  const startedAt = regulatoryStartInstant(at, action.timeZone);
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
    startedAt < branch.licenceValidFrom ||
    at >= branch.licenceValidTo
  ) {
    deny('LICENCE_INVALID');
  }

  if (
    action.requiresQualifiedPerson !== false &&
    (!branch.qualifiedPersonRegistration.trim() ||
      !branch.qualifiedPersonCoverageRosterRef.trim() ||
      startedAt < branch.qualifiedPersonValidFrom ||
      at >= branch.qualifiedPersonValidTo)
  ) {
    deny('QUALIFIED_PERSON_COVERAGE_MISSING');
  }

  if (
    action.requiresPharmacistPresence === true &&
    !pharmacistPresentAt(branch.ruleSet.pharmacistCoverageRule, at)
  ) {
    deny('PHARMACIST_NOT_PRESENT');
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
  binding?: { profile: RegulatoryProfileBindingFields; site: RegulatoryProfileBranchSite },
  timeZone?: string | null
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
        { name: 'REGULATORY_PROFILE_VIEW', at, requiresQualifiedPerson: true, timeZone }
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
  await checkStoredBranch(db, organizationId, branchId, action, auditDenied);
}

/** The stored-profile checks of `assertStoredBranchMayOperate`, with the denial hook supplied. */
async function checkStoredBranch(
  db: PrismaClient,
  organizationId: string,
  branchId: string,
  action: BranchOperationAction,
  auditDenied: BranchRegulatoryState['auditDenied']
): Promise<void> {
  const at = action.at ?? new Date();
  const profile = await db.branchRegulatoryProfile.findFirst({
    where: {
      organizationId,
      branchId,
      ...regulatoryProfileInForceWhere(at, action.timeZone),
    },
    include: { jurisdictionRuleSet: true, branch: true },
    orderBy: { effectiveFrom: 'desc' },
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
    select: { status: true, timezone: true },
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
  await assertStoredBranchMayOperate(db, organizationId, branchId, {
    ...action,
    timeZone: action.timeZone ?? organization.timezone,
  });
}

/**
 * DEV-860: the reason `assertStoredPharmacyMayOperate` would refuse this action now, or
 * null when it would pass. The counter's ready-to-sell check reads it before the first
 * scan. It runs the same organization, profile, binding and rule checks, but takes no
 * locks and writes no denial audit: it answers a question and authorizes nothing. Every
 * operation still runs the asserting gate in its own transaction.
 */
export async function storedPharmacyOperationDenial(
  db: PrismaClient,
  organizationId: string,
  branchId: string,
  action: BranchOperationAction
): Promise<BranchOperationDenialReason | null> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { status: true, timezone: true },
  });
  if (!organization || !OPERATING_ORGANIZATION_STATUSES.has(organization.status)) {
    return 'ORGANIZATION_NOT_ACTIVE';
  }
  try {
    await checkStoredBranch(
      db,
      organizationId,
      branchId,
      { ...action, timeZone: action.timeZone ?? organization.timezone },
      () => undefined
    );
    return null;
  } catch (error) {
    if (error instanceof BranchOperationDeniedError) return error.reason;
    throw error;
  }
}
