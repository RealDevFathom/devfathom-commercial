import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { RESTAURANT_JOB_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

/**
 * SOP-1 / WHA-224 — restaurant JOB ROLES and their resolution.
 *
 * WHY A NEW ROLE CONCEPT (the audit the brief asked for, recorded once, here).
 * The platform already has `OrganizationRole`. It was evaluated and rejected for
 * restaurant job duties on two structural grounds, neither of which a convention
 * could paper over:
 *
 *   1. It is reached only through `User.organizationRoleId` — a SINGULAR, nullable
 *      column. One user, one role. The owner's requirement is the opposite: a
 *      person is a barista AND additionally granted cashier.
 *   2. It is keyed to a `User`. A restaurant operator need not have a web login at
 *      all (C3 — a staff profile is deliberately not a `User`), so a large part of
 *      the floor could hold no role under that model.
 *
 * So job roles are keyed to the STAFF PROFILE, held many-to-many, and scoped per
 * branch. This remains ONE role concept for job duties: nothing else in the
 * restaurant vertical grants one. `OrganizationRole` keeps governing back-office
 * web permissions and is not touched.
 *
 * ROLES ONLY EVER UNION. Everything derived from a person's ROLES is a union:
 * capabilities are the union over every held role, and SOP pool eligibility is
 * the union over every held role. Holding two roles can only ever add; it can
 * never subtract, and there is no "primary role" tiebreak because there is no
 * tie to break.
 *
 * B1/WHA-285 — THE ONE THING THAT SUBTRACTS. A person may also carry per-person
 * OVERRIDES at a branch, and those have a direction: `ALLOW` adds a capability
 * their roles did not grant, `DENY` removes one their roles did. Precedence is
 * stated once, here, and implemented in exactly one place
 * ({@link resolveStaffCapabilityDecision}):
 *
 *     effective = (union over active held roles ∪ direct ALLOW) \ direct DENY
 *
 * DENY is evaluated LAST and therefore beats both. The competing ordering —
 * "a direct ALLOW should be able to re-grant what a DENY took" — is not merely
 * rejected, it is unrepresentable: the overrides table is UNIQUE on
 * (staffProfileId, branchId, capability) with no `effect` in the key, so the
 * same person cannot hold an ALLOW and a DENY for one capability at one branch.
 * The only ordering left to state is deny-over-inherited.
 *
 * A DENY NEVER MUTATES THE ROLE. Taking `payments:refund` away from one shift
 * supervisor leaves the `shift-supervisor` role granting `payments:refund` to
 * everyone else who holds it. That is the whole reason this layer exists rather
 * than "edit the role" or "invent a narrower role".
 *
 * IMMEDIATELY EFFECTIVE + AUDITED. Membership edits take effect on the next read
 * (there is no cached capability set to invalidate), and every grant/revoke is
 * appended to `restaurant_staff_job_role_audits`, which the migration makes
 * DB-enforced append-only. A revoke therefore survives the deletion of the
 * membership row it removed, which is the only way "who could do what, when"
 * stays answerable.
 */

export type JobRoleErrorReason =
  'INVALID' | 'KEY_TAKEN' | 'NOT_FOUND' | 'BRANCH_NOT_FOUND' | 'STAFF_NOT_FOUND' | 'ROLE_INACTIVE';

export class JobRoleError extends Error {
  constructor(
    message: string,
    readonly reason: JobRoleErrorReason
  ) {
    super(message);
    this.name = 'JobRoleError';
  }
}

/**
 * Canonical role key: trimmed, lowercased, internal runs of non-alphanumerics
 * folded to single hyphens. `Barista`, `barista`, and ` BARISTA ` are the same
 * role — without this, an admin typo silently creates a second, empty role and
 * everyone who "has" it holds nothing.
 */
export function normalizeJobRoleKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The starter job roles a restaurant organization gets.
 *
 * B1/WHA-285: the profiles are no longer authored here. They are VERTICAL-SUPPLIED
 * — `RESTAURANT_JOB_ROLE_TEMPLATES` in `vertical-catalog.ts` §8 — so the catalog
 * stays the single place a vertical's shape is declared, and a second vertical
 * supplies its own floor roles without editing this module.
 *
 * The constant is imported directly rather than through the catalog's
 * `jobRoleTemplatesForVertical()` selector: this module is not an approved
 * consumer of the vertical enum under the §2.3 scattered-conditional audit
 * (`tests/vertical-foundation.test.ts`), and everything under
 * `src/lib/restaurant/` is already restaurant-only by construction, so there is
 * no vertical to branch on here. Callers that DO hold an organization's vertical
 * use the selector.
 *
 * They are seeded as `isSystem` so the admin UI can mark them as built-in, but
 * they are ordinary rows — renameable, deactivatable, and in no way privileged
 * over roles an operator adds later.
 */
export const DEFAULT_JOB_ROLES: ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  capabilities: readonly string[];
}> = RESTAURANT_JOB_ROLE_TEMPLATES;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

// ── Role records ─────────────────────────────────────────────────────────────

export type CreateJobRoleInput = {
  key: string;
  name: string;
  description?: string | null;
  isSystem?: boolean;
  capabilities?: readonly string[];
};

/** Create a job role. The key is normalised and unique within the organization. */
export async function createJobRole(db: ScopedDb, input: CreateJobRoleInput) {
  const key = normalizeJobRoleKey(input.key);
  if (key.length === 0) throw new JobRoleError('A job role requires a key.', 'INVALID');
  const name = input.name.trim();
  if (name.length === 0) throw new JobRoleError('A job role requires a name.', 'INVALID');

  const capabilities = dedupeCapabilities(input.capabilities ?? []);
  try {
    return await db.restaurantJobRole.create({
      data: {
        key,
        name,
        description: input.description?.trim() || null,
        isSystem: input.isSystem ?? false,
        capabilities: { create: capabilities.map((capability) => ({ capability })) },
      },
      include: { capabilities: true },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new JobRoleError(`A job role with key "${key}" already exists.`, 'KEY_TAKEN');
    }
    throw error;
  }
}

/**
 * Seed {@link DEFAULT_JOB_ROLES} for the current organization. Idempotent: an
 * existing key is left exactly as the operator has since edited it, so re-running
 * this never reverts a rename or re-grants a capability that was deliberately
 * removed.
 *
 * That contract has a consequence worth stating plainly: when the vertical
 * catalog later WIDENS a template's capabilities, organizations that already own
 * that key do NOT pick the additions up. Missing keys are created; existing rows
 * are never reconciled. Silently re-granting a capability an operator removed on
 * purpose would be a privilege escalation performed by a seed function, which is
 * strictly worse than a role that lags its template.
 */
export async function ensureDefaultJobRoles(db: ScopedDb) {
  const existing = await db.restaurantJobRole.findMany({ select: { key: true } });
  const have = new Set(existing.map((row) => row.key));
  const created: string[] = [];
  for (const role of DEFAULT_JOB_ROLES) {
    if (have.has(role.key)) continue;
    try {
      await createJobRole(db, { ...role, isSystem: true, capabilities: role.capabilities });
      created.push(role.key);
    } catch (error) {
      // A concurrent seeder won the unique(organizationId, key) race — that is the
      // idempotent outcome, not a failure.
      if (error instanceof JobRoleError && error.reason === 'KEY_TAKEN') continue;
      throw error;
    }
  }
  return { created };
}

export type UpdateJobRoleInput = {
  name?: string;
  description?: string | null;
  active?: boolean;
};

export async function updateJobRole(db: ScopedDb, id: string, patch: UpdateJobRoleInput) {
  const existing = await db.restaurantJobRole.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new JobRoleError(`Job role ${id} was not found.`, 'NOT_FOUND');

  const name = patch.name?.trim();
  if (patch.name !== undefined && (name === undefined || name.length === 0)) {
    throw new JobRoleError('A job role requires a name.', 'INVALID');
  }
  return db.restaurantJobRole.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description?.trim() || null }
        : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    },
  });
}

export function listJobRoles(db: ScopedDb, opts: { activeOnly?: boolean } = {}) {
  return db.restaurantJobRole.findMany({
    where: opts.activeOnly ? { active: true } : {},
    include: { capabilities: { select: { capability: true } } },
    orderBy: [{ name: 'asc' }],
  });
}

function dedupeCapabilities(capabilities: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of capabilities) {
    const capability = raw.trim();
    if (capability.length > 0) seen.add(capability);
  }
  return [...seen].sort();
}

/**
 * Replace a role's capability set. Diffed rather than delete-all-reinsert so
 * unchanged rows keep their `createdAt` — the audit story for "when did this role
 * gain this power" stays intact.
 */
export async function setJobRoleCapabilities(
  db: ScopedDb,
  jobRoleId: string,
  capabilities: readonly string[]
) {
  const role = await db.restaurantJobRole.findUnique({
    where: { id: jobRoleId },
    select: { id: true },
  });
  if (!role) throw new JobRoleError(`Job role ${jobRoleId} was not found.`, 'NOT_FOUND');

  const next = new Set(dedupeCapabilities(capabilities));
  const current = await db.restaurantJobRoleCapability.findMany({
    where: { jobRoleId },
    select: { id: true, capability: true },
  });
  const currentByCapability = new Map(current.map((row) => [row.capability, row.id]));

  const toAdd = [...next].filter((capability) => !currentByCapability.has(capability));
  const toRemove = current.filter((row) => !next.has(row.capability)).map((row) => row.id);

  // Establish a broader replacement grant before removing its narrower predecessor.
  if (toAdd.length > 0) {
    await db.restaurantJobRoleCapability.createMany({
      data: toAdd.map((capability) => ({ jobRoleId, capability })),
    });
  }
  if (toRemove.length > 0) {
    await db.restaurantJobRoleCapability.deleteMany({ where: { id: { in: toRemove } } });
  }
  return { added: toAdd.sort(), removed: toRemove.length };
}

// ── Holdings (the many-to-many) ──────────────────────────────────────────────

async function assertBranch(db: ScopedDb, branchId: string) {
  const branch = await db.restaurantBranch.findUnique({
    where: { id: branchId },
    select: { id: true },
  });
  if (!branch) throw new JobRoleError(`Branch ${branchId} was not found.`, 'BRANCH_NOT_FOUND');
}

async function assertStaff(db: ScopedDb, staffProfileId: string) {
  const staff = await db.restaurantStaffProfile.findUnique({
    where: { id: staffProfileId },
    select: { id: true },
  });
  if (!staff) {
    throw new JobRoleError(`Staff profile ${staffProfileId} was not found.`, 'STAFF_NOT_FOUND');
  }
}

export type GrantJobRoleInput = {
  staffProfileId: string;
  jobRoleId: string;
  branchId: string;
  actorStaffProfileId?: string | null;
};

/**
 * Grant one job role at one branch. Idempotent: re-granting an existing holding
 * is a no-op that appends NO audit entry, so a double-click in the admin console
 * cannot inflate the trail with events that changed nothing.
 */
export async function grantJobRole(db: ScopedDb, input: GrantJobRoleInput) {
  const role = await db.restaurantJobRole.findUnique({
    where: { id: input.jobRoleId },
    select: { id: true, key: true, active: true },
  });
  if (!role) throw new JobRoleError(`Job role ${input.jobRoleId} was not found.`, 'NOT_FOUND');
  if (!role.active) {
    throw new JobRoleError(`Job role "${role.key}" is inactive.`, 'ROLE_INACTIVE');
  }
  await Promise.all([assertStaff(db, input.staffProfileId), assertBranch(db, input.branchId)]);

  const existing = await db.restaurantStaffJobRole.findUnique({
    where: {
      staffProfileId_jobRoleId_branchId: {
        staffProfileId: input.staffProfileId,
        jobRoleId: input.jobRoleId,
        branchId: input.branchId,
      },
    },
    select: { id: true },
  });
  if (existing) return { holding: existing, changed: false };

  try {
    const holding = await db.restaurantStaffJobRole.create({
      data: {
        staffProfileId: input.staffProfileId,
        jobRoleId: input.jobRoleId,
        branchId: input.branchId,
        grantedByStaffId: input.actorStaffProfileId ?? null,
      },
      select: { id: true },
    });
    await db.restaurantStaffJobRoleAudit.create({
      data: {
        staffProfileId: input.staffProfileId,
        jobRoleId: input.jobRoleId,
        jobRoleKey: role.key,
        branchId: input.branchId,
        change: 'GRANTED',
        actorStaffProfileId: input.actorStaffProfileId ?? null,
      },
    });
    return { holding, changed: true };
  } catch (error) {
    // Lost the unique race against a concurrent grant of the same holding: the
    // desired state already exists, so report it as unchanged rather than error.
    if (isUniqueViolation(error)) return { holding: null, changed: false };
    throw error;
  }
}

export type RevokeJobRoleInput = GrantJobRoleInput;

/**
 * Revoke one job role at one branch. Idempotent, and audited BEFORE the row is
 * deleted so the trail records the revoke even if nothing survives to point at.
 */
export async function revokeJobRole(db: ScopedDb, input: RevokeJobRoleInput) {
  const holding = await db.restaurantStaffJobRole.findUnique({
    where: {
      staffProfileId_jobRoleId_branchId: {
        staffProfileId: input.staffProfileId,
        jobRoleId: input.jobRoleId,
        branchId: input.branchId,
      },
    },
    select: { id: true, jobRole: { select: { key: true } } },
  });
  if (!holding) return { changed: false };

  await db.restaurantStaffJobRoleAudit.create({
    data: {
      staffProfileId: input.staffProfileId,
      jobRoleId: input.jobRoleId,
      jobRoleKey: holding.jobRole.key,
      branchId: input.branchId,
      change: 'REVOKED',
      actorStaffProfileId: input.actorStaffProfileId ?? null,
    },
  });
  await db.restaurantStaffJobRole.delete({ where: { id: holding.id } });
  return { changed: true };
}

export type SetStaffJobRolesInput = {
  staffProfileId: string;
  branchId: string;
  jobRoleIds: readonly string[];
  actorStaffProfileId?: string | null;
};

/**
 * The admin console's multi-select save: make the person's roles AT THIS BRANCH
 * exactly `jobRoleIds`. Computed as a diff so untouched roles emit no audit noise,
 * and scoped strictly to the one branch — a save on the Downtown tab must never
 * strip the same person's roles at Airport.
 */
export async function setStaffJobRoles(db: ScopedDb, input: SetStaffJobRolesInput) {
  await Promise.all([assertStaff(db, input.staffProfileId), assertBranch(db, input.branchId)]);

  const desired = new Set(input.jobRoleIds);
  const current = await db.restaurantStaffJobRole.findMany({
    where: { staffProfileId: input.staffProfileId, branchId: input.branchId },
    select: { jobRoleId: true },
  });
  const held = new Set(current.map((row) => row.jobRoleId));

  const granted: string[] = [];
  const revoked: string[] = [];
  for (const jobRoleId of desired) {
    if (held.has(jobRoleId)) continue;
    const result = await grantJobRole(db, {
      staffProfileId: input.staffProfileId,
      jobRoleId,
      branchId: input.branchId,
      actorStaffProfileId: input.actorStaffProfileId,
    });
    if (result.changed) granted.push(jobRoleId);
  }
  for (const jobRoleId of held) {
    if (desired.has(jobRoleId)) continue;
    const result = await revokeJobRole(db, {
      staffProfileId: input.staffProfileId,
      jobRoleId,
      branchId: input.branchId,
      actorStaffProfileId: input.actorStaffProfileId,
    });
    if (result.changed) revoked.push(jobRoleId);
  }
  return { granted: granted.sort(), revoked: revoked.sort() };
}

export type StaffAccessOverrideChange = {
  capability: string;
  /** `null` CLEARS the override so the person falls back to their roles. */
  effect: StaffCapabilityEffect | null;
};

export type SetStaffAccessInput = {
  staffProfileId: string;
  branchId: string;
  jobRoleIds: readonly string[];
  overrides: readonly StaffAccessOverrideChange[];
  actorStaffProfileId?: string | null;
};

/**
 * WHA-1181 — the admin console's ONE commit: this person's roles AND their
 * per-capability overrides at one branch, applied together.
 *
 * WHY BOTH IN ONE CALL. The console used to save roles with
 * {@link setStaffJobRoles} while every Direct/Deny click fired its own
 * round-trip. That made "Save role profiles" a partial commit (it covered the
 * role selection only, and was therefore permanently disabled for an
 * organization with no roles), and it made an operator's intent — "give her
 * cashier, but not refunds" — reach the database as two independently failing
 * writes with a window in between where she had one and not the other.
 *
 * ORDER IS ROLES THEN OVERRIDES, and it matters. Overrides are the subtractive
 * layer (module header: `effective = (roles ∪ ALLOW) \ DENY`), so applying them
 * after the role change means a DENY saved in the same commit as the role that
 * grants it lands on top, never underneath. The reverse order would leave the
 * capability briefly effective.
 *
 * Everything underneath is the existing idempotent, individually-audited path —
 * this adds no new write, no new audit shape, and no new precedence rule. A
 * caller inside a transaction gets all-or-nothing; the router runs it in one.
 */
export async function setStaffAccess(db: ScopedDb, input: SetStaffAccessInput) {
  const roles = await setStaffJobRoles(db, {
    staffProfileId: input.staffProfileId,
    branchId: input.branchId,
    jobRoleIds: input.jobRoleIds,
    actorStaffProfileId: input.actorStaffProfileId,
  });

  const applied: StaffAccessOverrideChange[] = [];
  for (const override of input.overrides) {
    const result = override.effect
      ? await setStaffCapabilityOverride(db, {
          staffProfileId: input.staffProfileId,
          branchId: input.branchId,
          capability: override.capability,
          effect: override.effect,
          actorStaffProfileId: input.actorStaffProfileId,
        })
      : await clearStaffCapabilityOverride(db, {
          staffProfileId: input.staffProfileId,
          branchId: input.branchId,
          capability: override.capability,
          actorStaffProfileId: input.actorStaffProfileId,
        });
    if (result.changed) applied.push(override);
  }

  return { ...roles, overrides: applied };
}

/** Every role this person holds, optionally narrowed to one branch. */
export function listStaffJobRoles(
  db: ScopedDb,
  staffProfileId: string,
  opts: { branchId?: string } = {}
) {
  return db.restaurantStaffJobRole.findMany({
    where: { staffProfileId, ...(opts.branchId ? { branchId: opts.branchId } : {}) },
    include: { jobRole: { select: { id: true, key: true, name: true, active: true } } },
    orderBy: [{ branchId: 'asc' }, { grantedAt: 'asc' }],
  });
}

/** The append-only membership trail for one person, newest first. */
export function listStaffJobRoleAudit(
  db: ScopedDb,
  staffProfileId: string,
  opts: { branchId?: string; take?: number } = {}
) {
  return db.restaurantStaffJobRoleAudit.findMany({
    where: { staffProfileId, ...(opts.branchId ? { branchId: opts.branchId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: opts.take ?? 100,
  });
}

// ── Per-person overrides (the only subtractive layer) ────────────────────────

export type StaffCapabilityEffect = 'ALLOW' | 'DENY';

export type SetStaffCapabilityOverrideInput = {
  staffProfileId: string;
  branchId: string;
  capability: string;
  effect: StaffCapabilityEffect;
  actorStaffProfileId?: string | null;
};

/**
 * Set ONE person's override for ONE capability at ONE branch.
 *
 * Upsert, not insert-or-fail: flipping an existing ALLOW to a DENY is the normal
 * administrative act ("she may no longer refund"), and making the caller delete
 * first would leave a window in which the person had neither. The unique key
 * carries no `effect`, so the flip is a single row update — the person is never
 * momentarily un-overridden.
 *
 * Idempotent, and audited only when something actually changed. Re-asserting the
 * same effect writes no second audit entry, for the same reason
 * {@link grantJobRole} does not: a double-click must not manufacture a compliance
 * event that records no change.
 *
 * The capability string is NOT validated against the vertical catalog. Role
 * capabilities are not validated either, and the two must agree or a deny could
 * silently fail to match the grant it is meant to cancel. Denying a capability
 * nobody has is inert, which is the safe direction to be wrong in.
 */
export async function setStaffCapabilityOverride(
  db: ScopedDb,
  input: SetStaffCapabilityOverrideInput
) {
  const capability = input.capability.trim();
  if (capability.length === 0) {
    throw new JobRoleError('A capability override requires a capability.', 'INVALID');
  }
  await Promise.all([assertStaff(db, input.staffProfileId), assertBranch(db, input.branchId)]);

  const key = {
    staffProfileId_branchId_capability: {
      staffProfileId: input.staffProfileId,
      branchId: input.branchId,
      capability,
    },
  };
  const existing = await db.restaurantStaffCapabilityGrant.findUnique({
    where: key,
    select: { id: true, effect: true },
  });
  if (existing?.effect === input.effect) {
    return { override: existing, changed: false };
  }

  const override = existing
    ? await db.restaurantStaffCapabilityGrant.update({
        where: { id: existing.id },
        data: { effect: input.effect },
        select: { id: true, effect: true },
      })
    : await db.restaurantStaffCapabilityGrant.create({
        data: {
          staffProfileId: input.staffProfileId,
          branchId: input.branchId,
          capability,
          effect: input.effect,
        },
        select: { id: true, effect: true },
      });

  await db.restaurantStaffCapabilityAudit.create({
    data: {
      staffProfileId: input.staffProfileId,
      branchId: input.branchId,
      capability,
      change: input.effect === 'DENY' ? 'DENIED' : 'ALLOWED',
      actorStaffProfileId: input.actorStaffProfileId ?? null,
    },
  });
  return { override, changed: true };
}

export type ClearStaffCapabilityOverrideInput = {
  staffProfileId: string;
  branchId: string;
  capability: string;
  actorStaffProfileId?: string | null;
};

/**
 * Remove an override so the person falls back to whatever their roles grant.
 * Idempotent, and — like {@link revokeJobRole} — audited BEFORE the delete, so
 * "the deny was lifted" survives the row that carried it.
 */
export async function clearStaffCapabilityOverride(
  db: ScopedDb,
  input: ClearStaffCapabilityOverrideInput
) {
  const capability = input.capability.trim();
  const existing = await db.restaurantStaffCapabilityGrant.findUnique({
    where: {
      staffProfileId_branchId_capability: {
        staffProfileId: input.staffProfileId,
        branchId: input.branchId,
        capability,
      },
    },
    select: { id: true },
  });
  if (!existing) return { changed: false };

  await db.restaurantStaffCapabilityAudit.create({
    data: {
      staffProfileId: input.staffProfileId,
      branchId: input.branchId,
      capability,
      change: 'CLEARED',
      actorStaffProfileId: input.actorStaffProfileId ?? null,
    },
  });
  await db.restaurantStaffCapabilityGrant.delete({ where: { id: existing.id } });
  return { changed: true };
}

/** Every override on this person, optionally narrowed to one branch. */
export function listStaffCapabilityOverrides(
  db: ScopedDb,
  staffProfileId: string,
  opts: { branchId?: string } = {}
) {
  return db.restaurantStaffCapabilityGrant.findMany({
    where: { staffProfileId, ...(opts.branchId ? { branchId: opts.branchId } : {}) },
    select: { id: true, branchId: true, capability: true, effect: true, createdAt: true },
    orderBy: [{ branchId: 'asc' }, { capability: 'asc' }],
  });
}

/** The append-only override trail for one person, newest first. */
export function listStaffCapabilityAudit(
  db: ScopedDb,
  staffProfileId: string,
  opts: { branchId?: string; take?: number } = {}
) {
  return db.restaurantStaffCapabilityAudit.findMany({
    where: { staffProfileId, ...(opts.branchId ? { branchId: opts.branchId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: opts.take ?? 100,
  });
}

// ── Resolution (the union, then the one subtraction) ─────────────────────────

/**
 * Every layer of a resolution, kept separate rather than pre-collapsed. An admin
 * console has to be able to say "she has this BECAUSE of the supervisor role" and
 * "she lacks that DESPITE it", and a caller that only wants the answer takes
 * `effective`.
 */
export type StaffCapabilityResolution = {
  /** Union over every ACTIVE role held at this branch. */
  inherited: Set<string>;
  /** Direct per-person ALLOW overrides. */
  allowed: Set<string>;
  /** Direct per-person DENY overrides. */
  denied: Set<string>;
  /** `(inherited ∪ allowed) \ denied` — what authorization must consult. */
  effective: Set<string>;
};

/**
 * This person's capability resolution AT THIS BRANCH, layer by layer.
 *
 * Deactivating a role withdraws what it granted without deleting anyone's
 * holding, so the change is reversible; a capability reachable by several paths
 * resolves once. DENY is applied last and unconditionally — see the module
 * header for why that ordering is the only one representable.
 */
export async function resolveStaffCapabilityDecision(
  db: ScopedDb,
  staffProfileId: string,
  branchId: string
): Promise<StaffCapabilityResolution> {
  const [holdings, overrides] = await Promise.all([
    db.restaurantStaffJobRole.findMany({
      where: { staffProfileId, branchId, jobRole: { active: true } },
      select: { jobRole: { select: { capabilities: { select: { capability: true } } } } },
    }),
    db.restaurantStaffCapabilityGrant.findMany({
      where: { staffProfileId, branchId },
      select: { capability: true, effect: true },
    }),
  ]);

  const inherited = new Set<string>();
  for (const holding of holdings) {
    for (const row of holding.jobRole.capabilities) inherited.add(row.capability);
  }

  const allowed = new Set<string>();
  const denied = new Set<string>();
  for (const row of overrides) {
    (row.effect === 'DENY' ? denied : allowed).add(row.capability);
  }

  const effective = new Set<string>([...inherited, ...allowed]);
  for (const capability of denied) effective.delete(capability);

  return { inherited, allowed, denied, effective };
}

/**
 * This person's effective capabilities AT THIS BRANCH. The authorization-facing
 * shorthand for {@link resolveStaffCapabilityDecision}; identical to reading its
 * `effective` set, and the deny subtraction is already applied.
 */
export async function resolveStaffCapabilities(
  db: ScopedDb,
  staffProfileId: string,
  branchId: string
): Promise<Set<string>> {
  const { effective } = await resolveStaffCapabilityDecision(db, staffProfileId, branchId);
  return effective;
}

/** Convenience predicate over {@link resolveStaffCapabilities}. */
export async function staffHasCapability(
  db: ScopedDb,
  staffProfileId: string,
  branchId: string,
  capability: string
): Promise<boolean> {
  const capabilities = await resolveStaffCapabilities(db, staffProfileId, branchId);
  return capabilities.has(capability);
}

/**
 * The eligibility pool for a role at a branch: every ACTIVE staff profile holding
 * that role there.
 *
 * ON-DUTY NARROWING. The brief asks for on-duty holders, falling back to all
 * branch holders when shift data is absent. There is no shift model at this base
 * — a lane that adds one is explicitly out of scope here — so the fallback is
 * currently the only live path. Rather than hard-code that assumption, the
 * narrowing is a seam: `onDutyStaffProfileIds` is an optional filter, and passing
 * `null`/`undefined` (what "no shift data" looks like) yields all branch holders.
 * A shift lane then supplies the set without this module changing shape. An empty
 * ARRAY is honoured as a real "nobody is on duty" answer and is deliberately NOT
 * treated as absent data.
 */
export async function listRoleHoldersAtBranch(
  db: ScopedDb,
  jobRoleId: string,
  branchId: string,
  opts: { onDutyStaffProfileIds?: readonly string[] | null } = {}
) {
  const holders = await db.restaurantStaffJobRole.findMany({
    where: { jobRoleId, branchId, staffProfile: { status: 'ACTIVE' } },
    select: {
      staffProfileId: true,
      staffProfile: { select: { id: true, displayName: true, status: true } },
    },
    orderBy: { grantedAt: 'asc' },
  });

  const onDuty = opts.onDutyStaffProfileIds;
  if (onDuty === undefined || onDuty === null) return holders;
  const allowed = new Set(onDuty);
  return holders.filter((holder) => allowed.has(holder.staffProfileId));
}
