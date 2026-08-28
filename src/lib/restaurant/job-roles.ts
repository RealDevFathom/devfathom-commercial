import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

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
 * UNIONS, NEVER OVERRIDES. Everything derived from a person's roles is a union:
 * capabilities are the union over every held role plus their direct grants, and
 * SOP pool eligibility is the union over every held role. Holding two roles can
 * only ever add; it can never subtract, and there is no "primary role" tiebreak
 * because there is no tie to break.
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
 * The starter job roles a restaurant organization gets. These are the owner's own
 * examples; they are seeded as `isSystem` so the admin UI can mark them as
 * built-in, but they are ordinary rows — renameable, deactivatable, and in no way
 * privileged over roles an operator adds later.
 */
export const DEFAULT_JOB_ROLES: ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  capabilities: readonly string[];
}> = [
  {
    key: 'barista',
    name: 'Barista',
    description: 'Prepares beverages at the bar station.',
    capabilities: ['sop:complete'],
  },
  {
    key: 'cashier',
    name: 'Cashier',
    description: 'Operates the register and handles guest checkout.',
    capabilities: ['sop:complete'],
  },
  {
    key: 'kitchen',
    name: 'Kitchen',
    description: 'Works the kitchen line and prep stations.',
    capabilities: ['sop:complete'],
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Runs the shift floor and owns branch compliance.',
    capabilities: ['sop:complete', 'sop:manage', 'sop:verify'],
  },
];

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

  if (toRemove.length > 0) {
    await db.restaurantJobRoleCapability.deleteMany({ where: { id: { in: toRemove } } });
  }
  if (toAdd.length > 0) {
    await db.restaurantJobRoleCapability.createMany({
      data: toAdd.map((capability) => ({ jobRoleId, capability })),
    });
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

// ── Resolution (the unions) ──────────────────────────────────────────────────

/**
 * This person's effective capabilities AT THIS BRANCH: the union over every
 * ACTIVE role they hold there, plus their direct per-staff grants. Deactivating a
 * role withdraws what it granted without deleting anyone's holding, so the change
 * is reversible; a capability reachable by several paths resolves once.
 */
export async function resolveStaffCapabilities(
  db: ScopedDb,
  staffProfileId: string,
  branchId: string
): Promise<Set<string>> {
  const [holdings, directGrants] = await Promise.all([
    db.restaurantStaffJobRole.findMany({
      where: { staffProfileId, branchId, jobRole: { active: true } },
      select: { jobRole: { select: { capabilities: { select: { capability: true } } } } },
    }),
    db.restaurantStaffCapabilityGrant.findMany({
      where: { staffProfileId, branchId },
      select: { capability: true },
    }),
  ]);

  const capabilities = new Set<string>();
  for (const holding of holdings) {
    for (const row of holding.jobRole.capabilities) capabilities.add(row.capability);
  }
  for (const row of directGrants) capabilities.add(row.capability);
  return capabilities;
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
