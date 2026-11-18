import 'server-only';

import { Prisma, type PharmacySopRecordType } from '@/generated/prisma/client';
import { can } from '@/lib/abac';
import { assignedRegisterBranchIds } from '@/lib/pharmacy/controlled-register';
import { BusinessDateError, parseCutoffMinutes } from '@/lib/restaurant/business-date';
import { grantJobRole, JobRoleError, revokeJobRole } from '@/lib/restaurant/job-roles';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { isIanaTimezone } from '@/lib/timezone';
import { formatLotExpiry } from './product-class';
import { pharmacySopPackForTemplateName } from './sop-library';

/**
 * DEV-751 — the pharmacy adapter onto the shared SOP engine.
 *
 * The engine (`src/lib/restaurant/sop-*.ts`) stores every template, assignment,
 * occurrence, evidence row and verification in the `restaurant_sop_*` tables,
 * keyed to an engine branch row, staff profile and job role. This module is the
 * only place pharmacy code translates its own scope into those keys:
 *
 * - **Branch.** Scope always comes from `pharmacy_branch_assignments` (the same
 *   source every other pharmacy surface uses). A pharmacy branch is bound to one
 *   engine branch row through `pharmacy_sop_sites`, created only by an explicit
 *   manager action. The engine branch is never used to decide access.
 * - **Actor.** Always derived from the authenticated session: the user must map
 *   to exactly one ACTIVE staff profile in the organization. Zero or several
 *   profiles fail closed. A client-supplied staff id is never accepted.
 * - **Roles.** Pharmacy duties use three job roles on the shared job-role
 *   tables. Holdings are per engine branch, so a holding at one pharmacy branch
 *   never reaches another.
 *
 * Nothing here grants restaurant access: the restaurant routers stay behind the
 * `restaurant-sop` module, which pharmacy packages do not license.
 */

export type PharmacySopAccessErrorReason =
  | 'UNAUTHENTICATED'
  | 'BRANCH_OUT_OF_SCOPE'
  | 'SITE_NOT_ENABLED'
  | 'NO_STAFF_PROFILE'
  | 'AMBIGUOUS_STAFF_PROFILE'
  | 'OCCURRENCE_OUT_OF_SCOPE'
  | 'ROLE_REQUIRED'
  | 'NOT_INDEPENDENT'
  | 'RECORD_OUT_OF_SCOPE'
  /** The procedure moved on (sent for review, checked, sent back) since it was read. */
  | 'STATE_CHANGED'
  | 'INVALID_INPUT';

export class PharmacySopAccessError extends Error {
  constructor(
    message: string,
    readonly reason: PharmacySopAccessErrorReason
  ) {
    super(message);
    this.name = 'PharmacySopAccessError';
  }
}

/** The three pharmacy job roles, materialised on the shared job-role tables. */
export const PHARMACY_SOP_ROLE_KEYS = [
  'pharmacy-manager',
  'pharmacy-qualified-person',
  'pharmacy-assistant',
] as const;
export type PharmacySopRoleKey = (typeof PHARMACY_SOP_ROLE_KEYS)[number];

export const PHARMACY_SOP_ROLES: Readonly<
  Record<PharmacySopRoleKey, { name: string; description: string }>
> = {
  'pharmacy-manager': {
    name: 'Pharmacy manager',
    description: 'Runs branch procedures, incidents and corrective actions.',
  },
  'pharmacy-qualified-person': {
    name: 'Qualified person (pharmacist)',
    description: 'Covers licensed duties and verifies pharmacy procedures.',
  },
  'pharmacy-assistant': {
    name: 'Pharmacy assistant',
    description: 'Completes routine storage, receiving and hygiene checks.',
  },
};

/** Roles allowed to verify a submitted pharmacy occurrence (independently). */
export const PHARMACY_SOP_VERIFIER_ROLE_KEYS: readonly PharmacySopRoleKey[] = [
  'pharmacy-qualified-person',
  'pharmacy-manager',
];

export type PharmacySopScope = { organizationId: string; userId: string };

export type PharmacySopBranchSummary = {
  pharmacyBranchId: string;
  name: string;
  /** Null until a manager enables SOPs at this branch. */
  sopBranchId: string | null;
  timezone: string | null;
};

export type PharmacySopSiteRef = {
  pharmacyBranchId: string;
  sopBranchId: string;
  timezone: string;
  businessDayCutoff: string;
};

export type PharmacySopActor = { staffProfileId: string; displayName: string; userId: string };

/**
 * Which storage zone a temperature step reads. COLD_CHAIN is a stock location
 * flagged `coldChain` (a validated refrigerator zone, the same flag the
 * temperature log uses for its range check); AMBIENT is any other location.
 */
export type PharmacySopTemperatureZone = 'COLD_CHAIN' | 'AMBIENT';

/**
 * What a linked (or linkable) pharmacy record says, in plain operator-facing
 * words: no raw status codes, ids or enum names. Built from tenant- and
 * branch-scoped reads only.
 */
export type PharmacySopRecordDetail = {
  kind: PharmacySopRecordType;
  /** One line, e.g. "QA Fridge · 11.5 °C at 15:20". */
  label: string;
  /** The reading or figure the record carries, e.g. "11.5 °C", "Balance 40". */
  value: string | null;
  /** The storage location, for a temperature reading. */
  location: string | null;
  /** When the record was taken, received or entered. */
  recordedAt: Date | null;
  /** Temperature readings only: outside the location's validated range. */
  outOfRange: boolean | null;
  /** The record's state in plain words, e.g. "Draft", "Posted", "In range". */
  statusLabel: string | null;
};

/** A record the picker may offer for one occurrence (and step). */
export type PharmacySopLinkableRecord = {
  id: string;
  recordType: PharmacySopRecordType;
  label: string;
  occurredAt: Date;
  outOfRange: boolean | null;
  detail: PharmacySopRecordDetail;
};

/** Record types an SOP step may link. */
export const PHARMACY_SOP_RECORD_TYPES: readonly PharmacySopRecordType[] = [
  'TEMPERATURE_LOG',
  'CONTROLLED_REGISTER_ENTRY',
  'GOODS_RECEIPT',
  'MANUFACTURING_BATCH',
  'RECALL_NOTICE',
];

/** Occurrence states that close it to new record links. */
const CLOSED_OCCURRENCE_STATUSES = ['VERIFIED', 'WAIVED'] as const;
const NOTE_MAX_LENGTH = 2000;
const RECORD_ID_MAX_LENGTH = 191;

/** How far before an occurrence's due time a linked event record may fall. */
export const PHARMACY_SOP_RECORD_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * The time window an EVENT record must fall in to be linked to an occurrence,
 * or null when the record type is not time-bounded. One definition, so the
 * record picker and the link check agree:
 *
 * - TEMPERATURE_LOG (`recordedAt`) and GOODS_RECEIPT (`receivedAt`): from
 *   `dueAt` − 24h to `windowEndsAt`. A reading or delivery is evidence for the
 *   round or receiving check it happened in, never for a later one.
 * - CONTROLLED_REGISTER_ENTRY: not bounded. A count reconciles to the running
 *   balance, and the entry carrying it may be weeks old when stock has not
 *   moved; entries are server-timestamped, so none can postdate the link.
 * - MANUFACTURING_BATCH and RECALL_NOTICE: state, not events, so not bounded.
 */
export function pharmacySopRecordTimeBounds(
  recordType: PharmacySopRecordType,
  occurrence: { dueAt: Date; windowEndsAt: Date }
): { gte: Date; lte: Date } | null {
  switch (recordType) {
    case 'TEMPERATURE_LOG':
    case 'GOODS_RECEIPT':
      return {
        gte: new Date(occurrence.dueAt.getTime() - PHARMACY_SOP_RECORD_LOOKBACK_MS),
        lte: occurrence.windowEndsAt,
      };
    default:
      return null;
  }
}

function refuse(reason: PharmacySopAccessErrorReason, message: string): never {
  throw new PharmacySopAccessError(message, reason);
}

/** Run `work` in one transaction; a request-level tx is reused (see scoped-db). */
function runSopTx<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  const transaction = db.$transaction.bind(db) as unknown as (
    fn: (tx: ScopedDb) => Promise<T>
  ) => Promise<T>;
  return transaction(work);
}

/** Transaction-scoped advisory lock; released at commit or rollback. */
async function advisoryLock(tx: ScopedDb, key: string) {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

function requireScope(scope: PharmacySopScope) {
  if (!scope.organizationId || !scope.userId) {
    refuse('UNAUTHENTICATED', 'Sign in to use pharmacy procedures.');
  }
}

/**
 * The one branch-scope check: an active assignment of this user to an active
 * pharmacy branch of this organization. Anything else, including a branch of
 * another tenant, reads as BRANCH_OUT_OF_SCOPE with no further detail.
 */
async function assertPharmacyBranchInScope(
  db: ScopedDb,
  organizationId: string,
  userId: string,
  pharmacyBranchId: string
): Promise<{ id: string; name: string }> {
  const assigned = await assignedRegisterBranchIds(db, organizationId, userId);
  if (!pharmacyBranchId || !assigned.includes(pharmacyBranchId)) {
    refuse('BRANCH_OUT_OF_SCOPE', 'This branch is outside your pharmacy scope.');
  }
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: pharmacyBranchId, organizationId, active: true },
    select: { id: true, name: true },
  });
  if (!branch) refuse('BRANCH_OUT_OF_SCOPE', 'This branch is outside your pharmacy scope.');
  return branch;
}

async function loadSite(
  db: ScopedDb,
  organizationId: string,
  pharmacyBranchId: string
): Promise<PharmacySopSiteRef | null> {
  const site = await db.pharmacySopSite.findFirst({
    where: { organizationId, pharmacyBranchId },
    select: { pharmacyBranchId: true, sopBranchId: true },
  });
  if (!site) return null;
  const engineBranch = await db.restaurantBranch.findFirst({
    where: { id: site.sopBranchId, organizationId },
    select: { timezone: true, businessDayCutoff: true },
  });
  if (!engineBranch) return null;
  return {
    pharmacyBranchId: site.pharmacyBranchId,
    sopBranchId: site.sopBranchId,
    timezone: engineBranch.timezone,
    businessDayCutoff: engineBranch.businessDayCutoff,
  };
}

/** Pharmacy branches the session user is actively assigned to, with SOP status. */
export async function listPharmacySopBranches(
  db: ScopedDb,
  scope: PharmacySopScope
): Promise<PharmacySopBranchSummary[]> {
  requireScope(scope);
  const { organizationId } = scope;
  const assigned = await assignedRegisterBranchIds(db, organizationId, scope.userId);
  if (assigned.length === 0) return [];
  const branches = await db.pharmacyBranch.findMany({
    where: { organizationId, id: { in: assigned }, active: true },
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  if (branches.length === 0) return [];
  const sites = await db.pharmacySopSite.findMany({
    where: { organizationId, pharmacyBranchId: { in: branches.map((branch) => branch.id) } },
    select: { pharmacyBranchId: true, sopBranchId: true },
  });
  const engineBranches =
    sites.length === 0
      ? []
      : await db.restaurantBranch.findMany({
          where: { organizationId, id: { in: sites.map((site) => site.sopBranchId) } },
          select: { id: true, timezone: true },
        });
  const siteByBranch = new Map(sites.map((site) => [site.pharmacyBranchId, site.sopBranchId]));
  const timezoneByEngineBranch = new Map(engineBranches.map((row) => [row.id, row.timezone]));
  return branches.map((branch) => {
    const sopBranchId = siteByBranch.get(branch.id) ?? null;
    return {
      pharmacyBranchId: branch.id,
      name: branch.name,
      sopBranchId,
      timezone: sopBranchId ? (timezoneByEngineBranch.get(sopBranchId) ?? null) : null,
    };
  });
}

/**
 * Resolve the SOP site for a pharmacy branch the user is actively assigned to.
 * Throws BRANCH_OUT_OF_SCOPE (no assignment / inactive / other tenant) or
 * SITE_NOT_ENABLED.
 */
export async function resolvePharmacySopSite(
  db: ScopedDb,
  scope: PharmacySopScope & { pharmacyBranchId: string }
): Promise<PharmacySopSiteRef> {
  requireScope(scope);
  await assertPharmacyBranchInScope(db, scope.organizationId, scope.userId, scope.pharmacyBranchId);
  const site = await loadSite(db, scope.organizationId, scope.pharmacyBranchId);
  if (!site) refuse('SITE_NOT_ENABLED', 'Procedures are not enabled at this branch yet.');
  return site;
}

/** Validate an SOP site's timezone and business-day cutoff; returns the trimmed values. */
export function validatePharmacySopSiteClock(input: {
  timezone: string;
  businessDayCutoff?: string;
}): { timezone: string; businessDayCutoff: string } {
  const timezone = (input.timezone ?? '').trim();
  if (!timezone || timezone.length > 100 || !isIanaTimezone(timezone)) {
    refuse('INVALID_INPUT', 'Choose a valid IANA timezone, such as Asia/Karachi.');
  }
  const businessDayCutoff = (input.businessDayCutoff ?? '00:00').trim();
  try {
    parseCutoffMinutes(businessDayCutoff);
  } catch (error) {
    if (error instanceof BusinessDateError) {
      refuse('INVALID_INPUT', 'The business-day cutoff must be a 24-hour HH:MM time.');
    }
    throw error;
  }
  return { timezone, businessDayCutoff };
}

/**
 * Explicitly enable SOPs at one pharmacy branch: idempotently create the engine
 * branch row and the site link (serialized per branch). Also ensures the three
 * pharmacy job roles exist. Creates no assignment, schedule or holding.
 *
 * Re-enabling an existing site returns it unchanged (`created: false`); the
 * timezone and cutoff given on the repeat call are not applied.
 */
export async function enablePharmacySopSite(
  db: ScopedDb,
  scope: PharmacySopScope & {
    pharmacyBranchId: string;
    timezone: string;
    businessDayCutoff?: string;
  }
): Promise<{ site: PharmacySopSiteRef; created: boolean }> {
  requireScope(scope);
  const clock = validatePharmacySopSiteClock(scope);
  const { organizationId, pharmacyBranchId } = scope;
  return runSopTx(db, async (tx) => {
    const branch = await assertPharmacyBranchInScope(
      tx,
      organizationId,
      scope.userId,
      pharmacyBranchId
    );
    await advisoryLock(tx, `pharmacy-sop-site:${organizationId}:${pharmacyBranchId}`);
    await ensurePharmacySopJobRoles(tx, organizationId);

    const existing = await loadSite(tx, organizationId, pharmacyBranchId);
    if (existing) return { site: existing, created: false };

    const engineBranch = await tx.restaurantBranch.create({
      data: {
        organizationId,
        name: `${branch.name} · SOP`,
        timezone: clock.timezone,
        businessDayCutoff: clock.businessDayCutoff,
        isDefault: false,
        active: true,
      },
      select: { id: true, timezone: true, businessDayCutoff: true },
    });
    await tx.pharmacySopSite.create({
      data: {
        organizationId,
        pharmacyBranchId,
        sopBranchId: engineBranch.id,
        enabledByUserId: scope.userId,
      },
      select: { id: true },
    });
    return {
      site: {
        pharmacyBranchId,
        sopBranchId: engineBranch.id,
        timezone: engineBranch.timezone,
        businessDayCutoff: engineBranch.businessDayCutoff,
      },
      created: true,
    };
  });
}

/** Server-derived actor: exactly one ACTIVE staff profile for the session user. */
export async function resolvePharmacySopActor(
  db: ScopedDb,
  scope: PharmacySopScope
): Promise<PharmacySopActor> {
  requireScope(scope);
  const profiles = await db.restaurantStaffProfile.findMany({
    where: {
      organizationId: scope.organizationId,
      userId: scope.userId,
      status: 'ACTIVE',
      user: { organizationId: scope.organizationId, status: 'ACTIVE' },
    },
    select: { id: true, displayName: true },
    orderBy: { id: 'asc' },
    take: 2,
  });
  if (profiles.length === 0) {
    refuse('NO_STAFF_PROFILE', 'Your account has no active staff profile in this workspace.');
  }
  if (profiles.length > 1) {
    refuse(
      'AMBIGUOUS_STAFF_PROFILE',
      'Your account is linked to more than one staff profile. Ask a manager to resolve it.'
    );
  }
  const [profile] = profiles;
  return { staffProfileId: profile.id, displayName: profile.displayName, userId: scope.userId };
}

/**
 * Idempotently ensure the three pharmacy job roles; returns key → jobRoleId.
 * Insert-if-absent (`ON CONFLICT DO NOTHING` on organization + key), so
 * concurrent callers cannot create duplicates. Existing rows are not changed:
 * an operator's rename or deactivation stands. No capability rows are written.
 * `organizationId` narrows the read when known; RLS scopes it either way.
 */
export async function ensurePharmacySopJobRoles(
  db: ScopedDb,
  organizationId?: string
): Promise<Record<PharmacySopRoleKey, string>> {
  await db.restaurantJobRole.createMany({
    data: PHARMACY_SOP_ROLE_KEYS.map((key) => ({
      ...(organizationId ? { organizationId } : {}),
      key,
      name: PHARMACY_SOP_ROLES[key].name,
      description: PHARMACY_SOP_ROLES[key].description,
      isSystem: true,
      active: true,
    })),
    skipDuplicates: true,
  });
  const rows = await db.restaurantJobRole.findMany({
    where: {
      ...(organizationId ? { organizationId } : {}),
      key: { in: [...PHARMACY_SOP_ROLE_KEYS] },
    },
    select: { id: true, key: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.id]));
  const result = {} as Record<PharmacySopRoleKey, string>;
  for (const key of PHARMACY_SOP_ROLE_KEYS) {
    const id = byKey.get(key);
    if (!id) throw new Error(`Pharmacy job role "${key}" could not be ensured.`);
    result[key] = id;
  }
  return result;
}

/**
 * The one serialized find-or-create of a user's staff profile, used for role
 * targets and for a person setting up their own profile. Must run inside a
 * transaction. One profile per user is not a database constraint, so creation
 * is serialized per (tenant, user); the read after the lock then sees any
 * concurrent create.
 *
 * - exactly one ACTIVE profile → reused (`created: false`);
 * - several ACTIVE profiles → AMBIGUOUS_STAFF_PROFILE;
 * - only SUSPENDED/ARCHIVED profiles → NO_STAFF_PROFILE (never re-activated);
 * - none at all → created and linked when `allowCreate`, else NO_STAFF_PROFILE.
 */
async function findOrCreatePharmacySopStaffProfile(
  tx: ScopedDb,
  input: {
    organizationId: string;
    userId: string;
    userName: string;
    sopBranchId: string;
    allowCreate: boolean;
    subject: 'self' | 'target';
  }
): Promise<{ staffProfileId: string; displayName: string; created: boolean }> {
  const self = input.subject === 'self';
  await advisoryLock(tx, `pharmacy-sop-staff:${input.organizationId}:${input.userId}`);
  const profiles = await tx.restaurantStaffProfile.findMany({
    where: { organizationId: input.organizationId, userId: input.userId },
    select: { id: true, status: true, displayName: true },
    orderBy: { id: 'asc' },
  });
  const active = profiles.filter((profile) => profile.status === 'ACTIVE');
  if (active.length > 1) {
    refuse(
      'AMBIGUOUS_STAFF_PROFILE',
      self
        ? 'Your account is linked to more than one staff profile. Ask a manager to resolve it.'
        : 'This person is linked to more than one staff profile. Resolve it before changing roles.'
    );
  }
  const [existing] = active;
  if (existing) {
    return { staffProfileId: existing.id, displayName: existing.displayName, created: false };
  }
  if (profiles.length > 0 || !input.allowCreate) {
    refuse(
      'NO_STAFF_PROFILE',
      self
        ? 'Your staff profile is suspended or archived. Ask an administrator to restore it.'
        : 'This person has no active staff profile.'
    );
  }
  const displayName = input.userName.trim() || 'Pharmacy staff';
  const created = await tx.restaurantStaffProfile.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      displayName,
      primaryBranchId: input.sopBranchId,
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  return { staffProfileId: created.id, displayName, created: true };
}

/**
 * Explicit, idempotent self-service: give the session user their own staff
 * profile so they can take part in procedures at one enabled SOP site. The
 * user must be ACTIVE and actively assigned to the pharmacy branch (the same
 * scope check every pharmacy surface uses). An existing ACTIVE profile is
 * returned unchanged; several ACTIVE profiles, or only SUSPENDED/ARCHIVED
 * ones, fail closed exactly as {@link resolvePharmacySopActor} does. Grants no
 * role and writes nothing else.
 */
export async function ensurePharmacySopStaffProfile(
  db: ScopedDb,
  scope: PharmacySopScope & { pharmacyBranchId: string }
): Promise<PharmacySopActor & { created: boolean }> {
  requireScope(scope);
  const { organizationId, userId, pharmacyBranchId } = scope;
  return runSopTx(db, async (tx) => {
    await assertPharmacyBranchInScope(tx, organizationId, userId, pharmacyBranchId);
    const site = await loadSite(tx, organizationId, pharmacyBranchId);
    if (!site) refuse('SITE_NOT_ENABLED', 'Procedures are not enabled at this branch yet.');
    const user = await tx.user.findFirst({
      where: { id: userId, organizationId, status: 'ACTIVE' },
      select: { id: true, name: true },
    });
    if (!user) refuse('UNAUTHENTICATED', 'Sign in to use pharmacy procedures.');
    const profile = await findOrCreatePharmacySopStaffProfile(tx, {
      organizationId,
      userId,
      userName: user.name,
      sopBranchId: site.sopBranchId,
      allowCreate: true,
      subject: 'self',
    });
    return {
      staffProfileId: profile.staffProfileId,
      displayName: profile.displayName,
      userId,
      created: profile.created,
    };
  });
}

/**
 * Grant (or revoke) a pharmacy SOP role to a tenant user at one SOP site. The
 * target user must be ACTIVE and actively assigned to the pharmacy branch. If
 * the user has no staff profile one is created and linked; if they have several
 * the grant fails closed (AMBIGUOUS_STAFF_PROFILE). Idempotent.
 *
 * A user whose only profiles are SUSPENDED/ARCHIVED is refused
 * (NO_STAFF_PROFILE) rather than silently re-activated, and revoking from a
 * user with no profile at all is refused the same way. Grants and revokes go
 * through the shared job-role helpers, so each change appends one entry to
 * `restaurant_staff_job_role_audits` and a no-op appends none.
 *
 * Verifier roles carry two extra grant checks (revoking stays unrestricted,
 * including revoking your own role):
 * - Nobody grants a verifier role to themselves: the grantor's staff profile
 *   and user must not be the target's (NOT_INDEPENDENT).
 * - `pharmacy-qualified-person` is granted only to a user the ABAC engine
 *   allows `pharmacy:dispense` (ROLE_REQUIRED).
 */
export async function setPharmacySopRoleHolding(
  db: ScopedDb,
  input: {
    organizationId: string;
    site: PharmacySopSiteRef;
    targetUserId: string;
    roleKey: PharmacySopRoleKey;
    held: boolean;
    grantedByStaffProfileId: string;
  }
): Promise<{ staffProfileId: string; changed: boolean }> {
  const { organizationId, site, targetUserId } = input;
  if (!organizationId) refuse('UNAUTHENTICATED', 'Sign in to use pharmacy procedures.');
  if (!(PHARMACY_SOP_ROLE_KEYS as readonly string[]).includes(input.roleKey)) {
    refuse('INVALID_INPUT', 'Unknown pharmacy role.');
  }
  return runSopTx(db, async (tx) => {
    const siteRow = await tx.pharmacySopSite.findFirst({
      where: {
        organizationId,
        pharmacyBranchId: site.pharmacyBranchId,
        sopBranchId: site.sopBranchId,
      },
      select: { id: true },
    });
    if (!siteRow) refuse('SITE_NOT_ENABLED', 'Procedures are not enabled at this branch yet.');

    const user = await tx.user.findFirst({
      where: { id: targetUserId, organizationId, status: 'ACTIVE' },
      include: {
        organizationRole: { include: { permissions: true } },
        permissionOverrides: true,
      },
    });
    if (!user) refuse('BRANCH_OUT_OF_SCOPE', 'This person is not assigned to this branch.');
    const assigned = await assignedRegisterBranchIds(tx, organizationId, targetUserId);
    if (!assigned.includes(site.pharmacyBranchId)) {
      refuse('BRANCH_OUT_OF_SCOPE', 'This person is not assigned to this branch.');
    }

    const grantsVerifierRole =
      input.held && PHARMACY_SOP_VERIFIER_ROLE_KEYS.includes(input.roleKey);
    if (grantsVerifierRole) {
      const grantor = await tx.restaurantStaffProfile.findFirst({
        where: { id: input.grantedByStaffProfileId, organizationId },
        select: { userId: true },
      });
      if (!grantor) {
        refuse('NO_STAFF_PROFILE', 'Your account has no active staff profile in this workspace.');
      }
      // The target's profile is found by user id, so a matching user covers
      // the grantor's own profile too.
      if (grantor.userId === targetUserId) {
        refuse('NOT_INDEPENDENT', 'You can’t give yourself a role that checks procedures.');
      }
    }
    if (
      input.held &&
      input.roleKey === 'pharmacy-qualified-person' &&
      !(await can(user, 'pharmacy:dispense', undefined, { db: tx }))
    ) {
      refuse(
        'ROLE_REQUIRED',
        'Only someone permitted to dispense can be made the qualified person.'
      );
    }

    const { staffProfileId } = await findOrCreatePharmacySopStaffProfile(tx, {
      organizationId,
      userId: targetUserId,
      userName: user.name,
      sopBranchId: site.sopBranchId,
      allowCreate: input.held,
      subject: 'target',
    });

    const roles = await ensurePharmacySopJobRoles(tx, organizationId);
    const holding = {
      staffProfileId,
      jobRoleId: roles[input.roleKey],
      branchId: site.sopBranchId,
      actorStaffProfileId: input.grantedByStaffProfileId,
    };
    try {
      const result = input.held
        ? await grantJobRole(tx, holding)
        : await revokeJobRole(tx, holding);
      return { staffProfileId, changed: result.changed };
    } catch (error) {
      if (error instanceof JobRoleError) refuse('INVALID_INPUT', error.message);
      throw error;
    }
  });
}

/** Pharmacy role keys the staff profile holds at this SOP site. */
export async function pharmacySopRolesAt(
  db: ScopedDb,
  input: { staffProfileId: string; sopBranchId: string }
): Promise<PharmacySopRoleKey[]> {
  if (!input.staffProfileId || !input.sopBranchId) return [];
  const holdings = await db.restaurantStaffJobRole.findMany({
    where: {
      staffProfileId: input.staffProfileId,
      branchId: input.sopBranchId,
      jobRole: { key: { in: [...PHARMACY_SOP_ROLE_KEYS] }, active: true },
    },
    select: { jobRole: { select: { key: true } } },
  });
  const held = new Set(holdings.map((holding) => holding.jobRole.key));
  return PHARMACY_SOP_ROLE_KEYS.filter((key) => held.has(key));
}

/**
 * Load an occurrence and assert it belongs to this SOP site (and so to the
 * user's pharmacy branch). Cross-branch or unknown ids throw
 * OCCURRENCE_OUT_OF_SCOPE with no detail about the other branch.
 */
export async function assertOccurrenceAtSite(
  db: ScopedDb,
  input: { occurrenceId: string; site: PharmacySopSiteRef }
): Promise<{
  id: string;
  status: string;
  templateVersionId: string;
  assignedStaffProfileId: string | null;
  claimedByStaffProfileId: string | null;
  poolJobRoleId: string | null;
}> {
  if (!input.occurrenceId || !input.site?.sopBranchId) {
    refuse('OCCURRENCE_OUT_OF_SCOPE', 'This checklist is not available at this branch.');
  }
  const occurrence = await db.restaurantSopOccurrence.findFirst({
    where: { id: input.occurrenceId, branchId: input.site.sopBranchId },
    select: {
      id: true,
      status: true,
      templateVersionId: true,
      assignedStaffProfileId: true,
      claimedByStaffProfileId: true,
      poolJobRoleId: true,
    },
  });
  if (!occurrence) {
    refuse('OCCURRENCE_OUT_OF_SCOPE', 'This checklist is not available at this branch.');
  }
  return occurrence;
}

/**
 * The verifier roles for an occurrence: the pack's own list when the template
 * is a pharmacy pack (controlled counts are qualified-person only), otherwise
 * PHARMACY_SOP_VERIFIER_ROLE_KEYS.
 */
export async function pharmacySopVerifierRolesFor(
  db: ScopedDb,
  templateVersionId: string
): Promise<readonly PharmacySopRoleKey[]> {
  const version = await db.restaurantSopTemplateVersion.findFirst({
    where: { id: templateVersionId },
    select: { template: { select: { name: true } } },
  });
  const pack = version ? pharmacySopPackForTemplateName(version.template.name) : undefined;
  return pack?.pharmacy.verifierRoleKeys ?? PHARMACY_SOP_VERIFIER_ROLE_KEYS;
}

/**
 * Independent verification: the verifier must hold a verifier role at the site
 * and must not be the assignee, claimer, any step completer or any evidence
 * uploader of the occurrence. Throws ROLE_REQUIRED / NOT_INDEPENDENT.
 *
 * Holdings are re-read on every call, so a role revoked after it was granted
 * stops verification at once. A verifier qualifying only through
 * `pharmacy-qualified-person` must also still be allowed `pharmacy:dispense`,
 * the same condition that granting that role requires.
 *
 * Linking a pharmacy record to the occurrence also counts as taking part.
 */
export async function assertIndependentPharmacyVerifier(
  db: ScopedDb,
  input: { occurrenceId: string; site: PharmacySopSiteRef; verifierStaffProfileId: string }
): Promise<void> {
  const occurrence = await assertOccurrenceAtSite(db, input);
  const verifier = input.verifierStaffProfileId;
  if (!verifier)
    refuse('ROLE_REQUIRED', 'You don’t hold a role that checks procedures at this branch.');

  const [allowed, held] = await Promise.all([
    pharmacySopVerifierRolesFor(db, occurrence.templateVersionId),
    pharmacySopRolesAt(db, { staffProfileId: verifier, sopBranchId: input.site.sopBranchId }),
  ]);
  const qualifying = held.filter((key) => allowed.includes(key));
  if (qualifying.length === 0) {
    refuse('ROLE_REQUIRED', 'You don’t hold a role that checks procedures at this branch.');
  }

  const notIndependent = () =>
    refuse('NOT_INDEPENDENT', 'You can’t check a procedure you worked on.');
  if (
    occurrence.assignedStaffProfileId === verifier ||
    occurrence.claimedByStaffProfileId === verifier
  ) {
    notIndependent();
  }
  const [completedStep, uploadedEvidence, linkedRecord] = await Promise.all([
    db.restaurantSopOccurrenceStep.findFirst({
      where: { occurrenceId: occurrence.id, completedByStaffProfileId: verifier },
      select: { id: true },
    }),
    db.restaurantSopEvidence.findFirst({
      where: { occurrenceId: occurrence.id, uploaderStaffProfileId: verifier },
      select: { id: true },
    }),
    db.pharmacySopRecordLink.findFirst({
      where: { occurrenceId: occurrence.id, linkedByStaffProfileId: verifier },
      select: { id: true },
    }),
  ]);
  if (completedStep || uploadedEvidence || linkedRecord) notIndependent();

  if (qualifying.every((key) => key === 'pharmacy-qualified-person')) {
    const profile = await db.restaurantStaffProfile.findFirst({
      where: { id: verifier, status: 'ACTIVE' },
      select: {
        user: {
          include: {
            organizationRole: { include: { permissions: true } },
            permissionOverrides: true,
          },
        },
      },
    });
    const user = profile?.user;
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      !(await can(user, 'pharmacy:dispense', undefined, { db }))
    ) {
      refuse('ROLE_REQUIRED', 'You don’t hold a role that checks procedures at this branch.');
    }
  }
}

/**
 * Confirm a pharmacy record exists in this tenant and, where it carries a
 * branch, at this branch. Batches are organization-wide, so a batch must have a
 * lot at this branch; recall notices are organization-wide and checked as such.
 */
async function pharmacyRecordAtBranch(
  db: ScopedDb,
  input: {
    organizationId: string;
    pharmacyBranchId: string;
    recordType: PharmacySopRecordType;
    recordId: string;
  }
): Promise<{
  outOfRange?: boolean;
  occurredAt?: Date;
  coldChain?: boolean;
  cancelled?: boolean;
} | null> {
  const { organizationId, pharmacyBranchId: branchId, recordId: id } = input;
  switch (input.recordType) {
    case 'TEMPERATURE_LOG': {
      const log = await db.pharmacyTemperatureLog.findFirst({
        where: { id, organizationId, branchId },
        select: { outOfRange: true, recordedAt: true, location: { select: { coldChain: true } } },
      });
      return log
        ? {
            outOfRange: log.outOfRange,
            occurredAt: log.recordedAt,
            coldChain: log.location?.coldChain,
          }
        : null;
    }
    case 'CONTROLLED_REGISTER_ENTRY':
      return (await db.pharmacyControlledRegisterEntry.findFirst({
        where: { id, organizationId, branchId },
        select: { id: true },
      }))
        ? {}
        : null;
    case 'GOODS_RECEIPT': {
      const receipt = await db.pharmacyGoodsReceipt.findFirst({
        where: { id, organizationId, branchId },
        select: { receivedAt: true, status: true },
      });
      return receipt
        ? {
            occurredAt: receipt.receivedAt,
            cancelled: receipt.status === 'CANCELLED' || receipt.status === 'REVERSED',
          }
        : null;
    }
    case 'MANUFACTURING_BATCH':
      return (await db.pharmacyManufacturingBatch.findFirst({
        where: { id, organizationId, lots: { some: { organizationId, branchId } } },
        select: { id: true },
      }))
        ? {}
        : null;
    case 'RECALL_NOTICE':
      return (await db.pharmacyRecallNotice.findFirst({
        where: { id, organizationId },
        select: { id: true },
      }))
        ? {}
        : null;
    default:
      return null;
  }
}

/**
 * Append-only link from an occurrence (optionally a step) to an EXISTING
 * pharmacy record at the same branch. Validates the record exists in the
 * tenant and, where the record carries a branch, at this branch. Never creates,
 * posts or edits the record. Idempotent on (occurrence, type, record).
 *
 * A repeat of an existing link returns it with `created: false`; the step and
 * note of the first link stand. Inside the transaction the occurrence row is
 * share-locked and re-read: it must be IN_PROGRESS and the actor must be its
 * owner (assignee, else claimer), otherwise STATE_CHANGED (it moved on) or
 * INVALID_INPUT (not the owner). A cancelled goods receipt is never linked.
 * Event records must
 * fall in {@link pharmacySopRecordTimeBounds} of the occurrence
 * (RECORD_OUT_OF_SCOPE otherwise).
 */
export async function linkPharmacySopRecord(
  db: ScopedDb,
  input: {
    site: PharmacySopSiteRef;
    occurrenceId: string;
    occurrenceStepId?: string | null;
    recordType: PharmacySopRecordType;
    recordId: string;
    note?: string | null;
    actor: PharmacySopActor;
    /**
     * A temperature step's storage zone (from the pack). When given, a
     * TEMPERATURE_LOG must be a reading of a location in that zone.
     */
    temperatureZone?: PharmacySopTemperatureZone | null;
  }
): Promise<{ linkId: string; created: boolean; outOfRange?: boolean }> {
  const recordId = (input.recordId ?? '').trim();
  if (!recordId || recordId.length > RECORD_ID_MAX_LENGTH) {
    refuse('INVALID_INPUT', 'Choose the record to link.');
  }
  if (!PHARMACY_SOP_RECORD_TYPES.includes(input.recordType)) {
    refuse('INVALID_INPUT', 'Unknown record type.');
  }
  const note = input.note?.trim() || null;
  if (note && note.length > NOTE_MAX_LENGTH) {
    refuse('INVALID_INPUT', `Keep the note under ${NOTE_MAX_LENGTH} characters.`);
  }
  if (!input.actor?.staffProfileId || !input.actor.userId) {
    refuse('NO_STAFF_PROFILE', 'Your account has no active staff profile in this workspace.');
  }

  return runSopTx(db, async (tx) => {
    // The actor's own tenant scopes every lookup below (RLS scopes them too).
    const actorProfile = await tx.restaurantStaffProfile.findFirst({
      where: { id: input.actor.staffProfileId, userId: input.actor.userId, status: 'ACTIVE' },
      select: { organizationId: true },
    });
    if (!actorProfile) {
      refuse('NO_STAFF_PROFILE', 'Your account has no active staff profile in this workspace.');
    }
    const site = await tx.pharmacySopSite.findFirst({
      where: {
        organizationId: actorProfile.organizationId,
        pharmacyBranchId: input.site.pharmacyBranchId,
        sopBranchId: input.site.sopBranchId,
      },
      select: { organizationId: true, pharmacyBranchId: true, sopBranchId: true },
    });
    if (!site) refuse('SITE_NOT_ENABLED', 'Procedures are not enabled at this branch yet.');
    const { organizationId, pharmacyBranchId } = site;

    // Share-lock the occurrence first so a concurrent submit, verify or
    // release waits for this link (or this read waits for it), then read the
    // committed state under that lock.
    await tx.$queryRaw(
      Prisma.sql`SELECT 1 FROM "restaurant_sop_occurrences" WHERE "id" = ${input.occurrenceId} AND "organizationId" = ${organizationId} AND "branchId" = ${site.sopBranchId} FOR SHARE`
    );
    const occurrence = await tx.restaurantSopOccurrence.findFirst({
      where: { id: input.occurrenceId, organizationId, branchId: site.sopBranchId },
      select: {
        id: true,
        status: true,
        resolvedAt: true,
        dueAt: true,
        windowEndsAt: true,
        assignedStaffProfileId: true,
        claimedByStaffProfileId: true,
      },
    });
    if (!occurrence) {
      refuse('OCCURRENCE_OUT_OF_SCOPE', 'This checklist is not available at this branch.');
    }
    if (
      occurrence.resolvedAt ||
      (CLOSED_OCCURRENCE_STATUSES as readonly string[]).includes(occurrence.status)
    ) {
      refuse('STATE_CHANGED', 'This procedure is already closed.');
    }
    if (occurrence.status !== 'IN_PROGRESS') {
      refuse('STATE_CHANGED', 'This procedure is not in progress.');
    }
    const owner = occurrence.assignedStaffProfileId ?? occurrence.claimedByStaffProfileId;
    if (owner !== input.actor.staffProfileId) {
      refuse(
        'INVALID_INPUT',
        'Only the person this procedure is assigned to, or who claimed it, can link records to it.'
      );
    }
    const occurrenceStepId = input.occurrenceStepId || null;
    if (occurrenceStepId) {
      const step = await tx.restaurantSopOccurrenceStep.findFirst({
        where: { id: occurrenceStepId, occurrenceId: occurrence.id, organizationId },
        select: { id: true },
      });
      if (!step) {
        refuse('OCCURRENCE_OUT_OF_SCOPE', 'This checklist step is not available at this branch.');
      }
    }

    const record = await pharmacyRecordAtBranch(tx, {
      organizationId,
      pharmacyBranchId,
      recordType: input.recordType,
      recordId,
    });
    if (!record) refuse('RECORD_OUT_OF_SCOPE', 'That record was not found at this branch.');
    if (record.cancelled)
      refuse('INVALID_INPUT', 'A cancelled or reversed receipt can’t be linked.');
    if (input.recordType === 'TEMPERATURE_LOG' && input.temperatureZone) {
      const zone = temperatureZoneOf(record.coldChain);
      if (zone !== input.temperatureZone)
        refuse('INVALID_INPUT', TEMPERATURE_ZONE_MESSAGE[input.temperatureZone]);
    }
    const bounds = pharmacySopRecordTimeBounds(input.recordType, occurrence);
    if (
      bounds &&
      (!record.occurredAt || record.occurredAt < bounds.gte || record.occurredAt > bounds.lte)
    ) {
      refuse('RECORD_OUT_OF_SCOPE', 'That record is outside this checklist’s time window.');
    }

    const inserted = await tx.pharmacySopRecordLink.createMany({
      data: [
        {
          organizationId,
          pharmacyBranchId,
          occurrenceId: occurrence.id,
          occurrenceStepId,
          recordType: input.recordType,
          recordId,
          linkedByStaffProfileId: input.actor.staffProfileId,
          linkedByUserId: input.actor.userId,
          note,
        },
      ],
      skipDuplicates: true,
    });
    const link = await tx.pharmacySopRecordLink.findFirst({
      where: {
        organizationId,
        occurrenceId: occurrence.id,
        recordType: input.recordType,
        recordId,
      },
      select: { id: true },
    });
    if (!link) throw new Error('The record link could not be read back.');
    return {
      linkId: link.id,
      created: inserted.count === 1,
      ...(record.outOfRange === undefined ? {} : { outOfRange: record.outOfRange }),
    };
  });
}

// ── Plain-language record details ────────────────────────────────────────────

/** A location's zone; a missing flag (an unknown location) reads as ambient. */
function temperatureZoneOf(coldChain: boolean | null | undefined): PharmacySopTemperatureZone {
  return coldChain ? 'COLD_CHAIN' : 'AMBIENT';
}

const TEMPERATURE_ZONE_MESSAGE: Record<PharmacySopTemperatureZone, string> = {
  COLD_CHAIN:
    'This step needs a refrigerator reading. Choose a reading from a cold-chain location.',
  AMBIENT: 'This step needs an ambient storage reading, not a refrigerator one.',
};

const REGISTER_KIND_WORDS: Record<string, string> = {
  SALE: 'Sale',
  PURCHASE: 'Purchase',
  CORRECTION: 'Correction',
};
const RECEIPT_STATUS_WORDS: Record<string, string> = {
  DRAFT: 'Draft',
  POSTED: 'Posted',
  REVERSED: 'Reversed',
  CANCELLED: 'Cancelled',
};
const BATCH_STATE_WORDS: Record<string, string> = {
  ACTIVE: 'Active',
  RECALLED: 'Recalled',
  QUARANTINED: 'Quarantined',
};
const RECALL_STATUS_WORDS: Record<string, string> = { OPEN: 'Open', CLOSED: 'Closed' };

/** A status in words; an unknown code is never shown as-is. */
function words(table: Record<string, string>, code: string | null | undefined): string | null {
  return code ? (table[code] ?? null) : null;
}

/** Branch-local 24-hour clock time ("15:20"); UTC when the zone is unusable. */
function localClock(date: Date, timeZone: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  try {
    return format(timeZone);
  } catch {
    return format('UTC');
  }
}

/** Branch-local calendar date ("2027-01-31"). */
function localDate(date: Date, timeZone: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  try {
    return format(timeZone);
  } catch {
    return format('UTC');
  }
}

const joinLabel = (...parts: Array<string | null | undefined>) =>
  parts.filter((part): part is string => Boolean(part?.trim())).join(' · ');

const TEMPERATURE_DETAIL_SELECT = {
  id: true,
  recordedAt: true,
  temperatureC: true,
  outOfRange: true,
  location: { select: { name: true, coldChain: true } },
} as const;
const REGISTER_DETAIL_SELECT = {
  id: true,
  serial: true,
  entryKind: true,
  batchNumber: true,
  runningBalance: true,
  createdAt: true,
  medicine: { select: { productName: true } },
} as const;
const RECEIPT_DETAIL_SELECT = {
  id: true,
  reference: true,
  status: true,
  receivedAt: true,
  supplierInvoiceRef: true,
  supplier: { select: { name: true } },
} as const;
const BATCH_DETAIL_SELECT = {
  id: true,
  batchNumber: true,
  expiresAt: true,
  state: true,
  medicine: { select: { productName: true } },
} as const;
const RECALL_DETAIL_SELECT = {
  id: true,
  reference: true,
  reason: true,
  status: true,
  createdAt: true,
} as const;

type TemperatureDetailRow = {
  id: string;
  recordedAt: Date;
  temperatureC: number;
  outOfRange: boolean;
  location?: { name: string; coldChain?: boolean | null } | null;
};
type RegisterDetailRow = {
  id: string;
  serial: number;
  entryKind: string;
  batchNumber: string;
  runningBalance: number;
  createdAt: Date;
  medicine?: { productName: string } | null;
};
type ReceiptDetailRow = {
  id: string;
  reference: string;
  status: string;
  receivedAt: Date;
  supplierInvoiceRef?: string | null;
  supplier?: { name: string } | null;
};
type BatchDetailRow = {
  id: string;
  batchNumber: string;
  expiresAt: Date;
  state: string;
  medicine?: { productName: string } | null;
};
type RecallDetailRow = {
  id: string;
  reference: string;
  reason: string;
  status: string;
  createdAt: Date;
};

function temperatureDetail(row: TemperatureDetailRow, timeZone: string): PharmacySopRecordDetail {
  const value = `${row.temperatureC.toFixed(1)} °C`;
  const location = row.location?.name ?? null;
  return {
    kind: 'TEMPERATURE_LOG',
    label: `${joinLabel(location ?? 'Temperature reading', value)} at ${localClock(row.recordedAt, timeZone)}`,
    value,
    location,
    recordedAt: row.recordedAt,
    outOfRange: row.outOfRange,
    statusLabel: row.outOfRange ? 'Out of range' : 'In range',
  };
}

function registerDetail(row: RegisterDetailRow): PharmacySopRecordDetail {
  const kind = words(REGISTER_KIND_WORDS, row.entryKind);
  return {
    kind: 'CONTROLLED_REGISTER_ENTRY',
    label: joinLabel(
      `Register entry ${row.serial}`,
      kind,
      row.medicine?.productName,
      `batch ${row.batchNumber ?? 'not recorded'}`,
      `balance ${row.runningBalance}`
    ),
    value: `Balance ${row.runningBalance}`,
    location: null,
    recordedAt: row.createdAt,
    outOfRange: null,
    statusLabel: kind,
  };
}

function receiptDetail(row: ReceiptDetailRow): PharmacySopRecordDetail {
  return {
    kind: 'GOODS_RECEIPT',
    label: joinLabel(`Receipt ${row.reference}`, row.supplier?.name),
    value: row.supplierInvoiceRef ? `Invoice ${row.supplierInvoiceRef}` : null,
    location: null,
    recordedAt: row.receivedAt,
    outOfRange: null,
    statusLabel: words(RECEIPT_STATUS_WORDS, row.status),
  };
}

function batchDetail(row: BatchDetailRow, timeZone: string): PharmacySopRecordDetail {
  return {
    kind: 'MANUFACTURING_BATCH',
    label: joinLabel(`Batch ${row.batchNumber ?? 'not recorded'}`, row.medicine?.productName),
    value: formatLotExpiry(row.expiresAt, (value) => `Expires ${localDate(value, timeZone)}`),
    location: null,
    recordedAt: null,
    outOfRange: null,
    statusLabel: words(BATCH_STATE_WORDS, row.state),
  };
}

function recallDetail(row: RecallDetailRow): PharmacySopRecordDetail {
  return {
    kind: 'RECALL_NOTICE',
    label: joinLabel(`Recall ${row.reference}`, row.reason),
    value: null,
    location: null,
    recordedAt: row.createdAt,
    outOfRange: null,
    statusLabel: words(RECALL_STATUS_WORDS, row.status),
  };
}

/** Shown for a link whose record cannot be read at this branch any more. */
export function unavailablePharmacySopRecordDetail(
  recordType: PharmacySopRecordType
): PharmacySopRecordDetail {
  return {
    kind: recordType,
    label: 'This record is no longer available at this branch.',
    value: null,
    location: null,
    recordedAt: null,
    outOfRange: null,
    statusLabel: null,
  };
}

export const pharmacySopRecordDetailKey = (recordType: PharmacySopRecordType, recordId: string) =>
  `${recordType}:${recordId}`;

/**
 * Plain-language details for linked records, keyed by
 * {@link pharmacySopRecordDetailKey}. Every read is scoped to the tenant and,
 * where the record carries a branch, to this pharmacy branch (a batch through
 * a lot at the branch; a recall notice is organization-wide). A record outside
 * that scope is simply absent from the map, never read from another branch.
 */
export async function describePharmacySopRecords(
  db: ScopedDb,
  input: {
    organizationId: string;
    pharmacyBranchId: string;
    timezone: string;
    records: ReadonlyArray<{ recordType: PharmacySopRecordType; recordId: string }>;
  }
): Promise<Map<string, PharmacySopRecordDetail>> {
  const { organizationId, pharmacyBranchId: branchId, timezone } = input;
  const idsOf = (type: PharmacySopRecordType) => [
    ...new Set(input.records.filter((r) => r.recordType === type).map((r) => r.recordId)),
  ];
  const details = new Map<string, PharmacySopRecordDetail>();
  const put = (type: PharmacySopRecordType, id: string, detail: PharmacySopRecordDetail) =>
    details.set(pharmacySopRecordDetailKey(type, id), detail);

  const temperatureIds = idsOf('TEMPERATURE_LOG');
  const registerIds = idsOf('CONTROLLED_REGISTER_ENTRY');
  const receiptIds = idsOf('GOODS_RECEIPT');
  const batchIds = idsOf('MANUFACTURING_BATCH');
  const recallIds = idsOf('RECALL_NOTICE');
  const [temperatures, registers, receipts, batches, recalls] = await Promise.all([
    temperatureIds.length
      ? db.pharmacyTemperatureLog.findMany({
          where: { id: { in: temperatureIds }, organizationId, branchId },
          select: TEMPERATURE_DETAIL_SELECT,
        })
      : [],
    registerIds.length
      ? db.pharmacyControlledRegisterEntry.findMany({
          where: { id: { in: registerIds }, organizationId, branchId },
          select: REGISTER_DETAIL_SELECT,
        })
      : [],
    receiptIds.length
      ? db.pharmacyGoodsReceipt.findMany({
          where: { id: { in: receiptIds }, organizationId, branchId },
          select: RECEIPT_DETAIL_SELECT,
        })
      : [],
    batchIds.length
      ? db.pharmacyManufacturingBatch.findMany({
          where: {
            id: { in: batchIds },
            organizationId,
            lots: { some: { organizationId, branchId } },
          },
          select: BATCH_DETAIL_SELECT,
        })
      : [],
    recallIds.length
      ? db.pharmacyRecallNotice.findMany({
          where: { id: { in: recallIds }, organizationId },
          select: RECALL_DETAIL_SELECT,
        })
      : [],
  ]);
  for (const row of temperatures as TemperatureDetailRow[]) {
    put('TEMPERATURE_LOG', row.id, temperatureDetail(row, timezone));
  }
  for (const row of registers as RegisterDetailRow[]) {
    put('CONTROLLED_REGISTER_ENTRY', row.id, registerDetail(row));
  }
  for (const row of receipts as ReceiptDetailRow[]) {
    put('GOODS_RECEIPT', row.id, receiptDetail(row));
  }
  for (const row of batches as BatchDetailRow[]) {
    put('MANUFACTURING_BATCH', row.id, batchDetail(row, timezone));
  }
  for (const row of recalls as RecallDetailRow[]) {
    put('RECALL_NOTICE', row.id, recallDetail(row));
  }
  return details;
}

/**
 * Records the picker may offer for one occurrence: the newest `take` of one
 * type at this branch (tenant- and branch-scoped like
 * {@link describePharmacySopRecords}), inside `bounds` when the type is
 * time-bounded and, for a temperature step with a zone, only readings of a
 * location in that zone. Each carries its plain-language detail; the label is
 * the detail's label, so no status code reaches the picker.
 */
export async function listPharmacySopLinkableRecords(
  db: ScopedDb,
  input: {
    organizationId: string;
    pharmacyBranchId: string;
    timezone: string;
    recordType: PharmacySopRecordType;
    bounds: { gte: Date; lte: Date } | null;
    temperatureZone?: PharmacySopTemperatureZone | null;
    take: number;
  }
): Promise<PharmacySopLinkableRecord[]> {
  const { organizationId, pharmacyBranchId: branchId, timezone, recordType, bounds, take } = input;
  const candidate = (
    id: string,
    occurredAt: Date,
    detail: PharmacySopRecordDetail
  ): PharmacySopLinkableRecord => ({
    id,
    recordType,
    label: detail.label,
    occurredAt,
    outOfRange: detail.outOfRange,
    detail,
  });
  switch (recordType) {
    case 'TEMPERATURE_LOG': {
      const zone = input.temperatureZone ?? null;
      const rows = (await db.pharmacyTemperatureLog.findMany({
        where: {
          organizationId,
          branchId,
          ...(bounds ? { recordedAt: bounds } : {}),
          ...(zone ? { location: { coldChain: zone === 'COLD_CHAIN' } } : {}),
        },
        orderBy: [{ recordedAt: 'desc' }, { id: 'asc' }],
        take,
        select: TEMPERATURE_DETAIL_SELECT,
      })) as TemperatureDetailRow[];
      return rows.map((row) => candidate(row.id, row.recordedAt, temperatureDetail(row, timezone)));
    }
    case 'CONTROLLED_REGISTER_ENTRY': {
      const rows = (await db.pharmacyControlledRegisterEntry.findMany({
        where: { organizationId, branchId },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take,
        select: REGISTER_DETAIL_SELECT,
      })) as RegisterDetailRow[];
      return rows.map((row) => candidate(row.id, row.createdAt, registerDetail(row)));
    }
    case 'GOODS_RECEIPT': {
      const rows = (await db.pharmacyGoodsReceipt.findMany({
        // A cancelled or reversed receipt no longer stands, so it is never offered.
        where: {
          organizationId,
          branchId,
          status: { notIn: ['CANCELLED', 'REVERSED'] },
          ...(bounds ? { receivedAt: bounds } : {}),
        },
        orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
        take,
        select: RECEIPT_DETAIL_SELECT,
      })) as ReceiptDetailRow[];
      return rows.map((row) => candidate(row.id, row.receivedAt, receiptDetail(row)));
    }
    case 'MANUFACTURING_BATCH': {
      const rows = (await db.pharmacyManufacturingBatch.findMany({
        where: { organizationId, lots: { some: { organizationId, branchId } } },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take,
        select: BATCH_DETAIL_SELECT,
      })) as BatchDetailRow[];
      return rows.map((row) => candidate(row.id, row.expiresAt, batchDetail(row, timezone)));
    }
    case 'RECALL_NOTICE': {
      const rows = (await db.pharmacyRecallNotice.findMany({
        where: { organizationId, status: 'OPEN' },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take,
        select: RECALL_DETAIL_SELECT,
      })) as RecallDetailRow[];
      return rows.map((row) => candidate(row.id, row.createdAt, recallDetail(row)));
    }
    default:
      return [];
  }
}
