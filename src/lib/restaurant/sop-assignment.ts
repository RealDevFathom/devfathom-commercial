import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { listRoleHoldersAtBranch } from '@/lib/restaurant/job-roles';

/**
 * SOP-1 / WHA-224 — the two SOP assignment modes and the claim protocol.
 *
 * A template is scheduled to a branch by an ASSIGNMENT, and each assignment names
 * its assignee in exactly one of two ways:
 *
 *   PERSON — a named staff profile. Every generated occurrence is assigned
 *            directly to them; there is nothing to claim.
 *   ROLE   — a job role. Every generated occurrence becomes an UNCLAIMED item in
 *            that role's branch pool, and any eligible holder may take it.
 *
 * BOTH MODES RUN AT ONCE. They are exclusive per assignment row (a CHECK
 * constraint enforces that) but not per template, per branch, or per person. The
 * same template may legitimately be assigned to the `barista` role AND directly to
 * Sam — who is also a barista. Sam must then see that work ONCE, not twice, and
 * that is what {@link listStaffSopOccurrences} guarantees: it unions the direct
 * path with the pool path and de-duplicates by occurrence id.
 *
 * The owner path is frozen onto the occurrence AT GENERATION TIME, following the
 * same rule as the pinned template version: re-targeting an assignment tomorrow
 * must not silently rewrite who owed yesterday's checklist.
 */

export type AssigneeTargetErrorReason =
  'INVALID' | 'ROLE_NOT_FOUND' | 'ROLE_INACTIVE' | 'STAFF_NOT_FOUND';

export class AssigneeTargetError extends Error {
  constructor(
    message: string,
    readonly reason: AssigneeTargetErrorReason
  ) {
    super(message);
    this.name = 'AssigneeTargetError';
  }
}

/** The discriminated assignee target an assignment carries. */
export type AssigneeTarget =
  { type: 'person'; staffProfileId: string } | { type: 'role'; jobRoleId: string };

/** The persisted columns for a target — the shape the CHECK constraint expects. */
export type AssigneeTargetColumns = {
  assigneeTargetType: 'PERSON' | 'ROLE';
  assigneeStaffProfileId: string | null;
  assigneeJobRoleId: string | null;
};

export function assigneeTargetColumns(target: AssigneeTarget): AssigneeTargetColumns {
  return target.type === 'person'
    ? {
        assigneeTargetType: 'PERSON',
        assigneeStaffProfileId: target.staffProfileId,
        assigneeJobRoleId: null,
      }
    : {
        assigneeTargetType: 'ROLE',
        assigneeStaffProfileId: null,
        assigneeJobRoleId: target.jobRoleId,
      };
}

/** Read a persisted assignment row back into a {@link AssigneeTarget}. */
export function assigneeTargetOf(row: AssigneeTargetColumns): AssigneeTarget {
  if (row.assigneeTargetType === 'PERSON') {
    if (!row.assigneeStaffProfileId) {
      throw new AssigneeTargetError('A PERSON assignment is missing its staff profile.', 'INVALID');
    }
    return { type: 'person', staffProfileId: row.assigneeStaffProfileId };
  }
  if (!row.assigneeJobRoleId) {
    throw new AssigneeTargetError('A ROLE assignment is missing its job role.', 'INVALID');
  }
  return { type: 'role', jobRoleId: row.assigneeJobRoleId };
}

/**
 * Validate a target against the tenant before it is persisted. The DB CHECK only
 * proves the columns are internally coherent; this proves the thing they point at
 * actually exists and can still be assigned work.
 */
export async function assertAssigneeTarget(db: ScopedDb, target: AssigneeTarget): Promise<void> {
  if (target.type === 'person') {
    const staff = await db.restaurantStaffProfile.findUnique({
      where: { id: target.staffProfileId },
      select: { id: true },
    });
    if (!staff) {
      throw new AssigneeTargetError(
        `Staff profile ${target.staffProfileId} was not found.`,
        'STAFF_NOT_FOUND'
      );
    }
    return;
  }
  const role = await db.restaurantJobRole.findUnique({
    where: { id: target.jobRoleId },
    select: { id: true, key: true, active: true },
  });
  if (!role) {
    throw new AssigneeTargetError(`Job role ${target.jobRoleId} was not found.`, 'ROLE_NOT_FOUND');
  }
  if (!role.active) {
    throw new AssigneeTargetError(
      `Job role "${role.key}" is inactive and cannot be assigned SOPs.`,
      'ROLE_INACTIVE'
    );
  }
}

/**
 * The owner columns to stamp on a newly generated occurrence. A PERSON target
 * assigns directly and leaves the pool columns null; a ROLE target opens an
 * unclaimed pool item. The occurrence-level CHECK forbids setting both.
 *
 * Deliberately TOLERANT where {@link assigneeTargetOf} is strict. This runs inside
 * the batch generator, which walks every active assignment in the tenant: throwing
 * on one incoherent row would stop every OTHER branch's checklists from being
 * generated that cycle. A row with no usable target yields no owner — the
 * pre-SOP-1 status quo, which the rest of the pipeline already handles — instead
 * of taking the run down. The DB CHECK makes such a row unreachable in practice,
 * so this is a blast-radius guard, not an expected path.
 */
export function occurrenceOwnerColumns(row: AssigneeTargetColumns): {
  assignedStaffProfileId: string | null;
  poolJobRoleId: string | null;
} {
  if (row.assigneeTargetType === 'PERSON' && row.assigneeStaffProfileId) {
    return { assignedStaffProfileId: row.assigneeStaffProfileId, poolJobRoleId: null };
  }
  if (row.assigneeTargetType === 'ROLE' && row.assigneeJobRoleId) {
    return { assignedStaffProfileId: null, poolJobRoleId: row.assigneeJobRoleId };
  }
  return { assignedStaffProfileId: null, poolJobRoleId: null };
}

// ── Pools and claiming ───────────────────────────────────────────────────────

export type ClaimOutcome =
  /** This call took the occurrence. */
  | { status: 'CLAIMED'; claimedByStaffProfileId: string; claimedAt: Date }
  /** The same operator already held it — a retry, not an error. */
  | { status: 'ALREADY_CLAIMED_BY_CALLER'; claimedByStaffProfileId: string; claimedAt: Date }
  /** Someone else got there first. */
  | { status: 'CLAIMED_BY_OTHER'; claimedByStaffProfileId: string; claimedAt: Date }
  /** The occurrence cannot be claimed in its current state or by this caller. */
  | {
      status: 'NOT_CLAIMABLE';
      reason: 'NOT_A_POOL_OCCURRENCE' | 'NOT_ELIGIBLE' | 'NOT_FOUND' | 'INVALID_STATE';
    };

/**
 * Claim one pool occurrence for one operator.
 *
 * ATOMIC. The write is a single conditional UPDATE guarded by
 * `claimedByStaffProfileId IS NULL` and a SCHEDULED/REJECTED state. Under
 * PostgreSQL's READ COMMITTED, a second concurrent claimer blocks on the row
 * lock, re-evaluates the predicate against
 * the committed row, matches nothing, and reports zero rows affected. Exactly one
 * caller can ever observe `count === 1`. Read-then-write would race here; this
 * does not, and it needs no advisory lock or SERIALIZABLE retry loop.
 *
 * IDEMPOTENT. A zero-row result is ambiguous on its own, so the loser re-reads and
 * distinguishes the two cases: if the winner is the caller (a retried request, a
 * double-tap, an at-least-once job redelivery) the outcome is success; if it is
 * someone else, the caller is told plainly rather than handed a false success.
 */
export async function claimSopOccurrence(
  db: ScopedDb,
  occurrenceId: string,
  staffProfileId: string,
  opts: { now?: Date; onDutyStaffProfileIds?: readonly string[] | null } = {}
): Promise<ClaimOutcome> {
  const occurrence = await db.restaurantSopOccurrence.findUnique({
    where: { id: occurrenceId },
    select: {
      id: true,
      branchId: true,
      poolJobRoleId: true,
      claimedByStaffProfileId: true,
      claimedAt: true,
      status: true,
    },
  });
  if (!occurrence) return { status: 'NOT_CLAIMABLE', reason: 'NOT_FOUND' };
  if (!occurrence.poolJobRoleId) {
    return { status: 'NOT_CLAIMABLE', reason: 'NOT_A_POOL_OCCURRENCE' };
  }
  if (
    !occurrence.claimedByStaffProfileId &&
    occurrence.status !== 'SCHEDULED' &&
    occurrence.status !== 'REJECTED'
  ) {
    return { status: 'NOT_CLAIMABLE', reason: 'INVALID_STATE' };
  }

  // Eligibility is checked before the write, but it is NOT the concurrency guard —
  // two eligible holders racing is the case the conditional UPDATE below settles.
  const eligible = await listRoleHoldersAtBranch(
    db,
    occurrence.poolJobRoleId,
    occurrence.branchId,
    { onDutyStaffProfileIds: opts.onDutyStaffProfileIds }
  );
  if (!eligible.some((holder) => holder.staffProfileId === staffProfileId)) {
    return { status: 'NOT_CLAIMABLE', reason: 'NOT_ELIGIBLE' };
  }

  const claimedAt = opts.now ?? new Date();
  const { count } = await db.restaurantSopOccurrence.updateMany({
    where: {
      id: occurrenceId,
      claimedByStaffProfileId: null,
      status: { in: ['SCHEDULED', 'REJECTED'] },
    },
    data: { claimedByStaffProfileId: staffProfileId, claimedAt },
  });
  if (count === 1) {
    return { status: 'CLAIMED', claimedByStaffProfileId: staffProfileId, claimedAt };
  }

  const settled = await db.restaurantSopOccurrence.findUnique({
    where: { id: occurrenceId },
    select: { claimedByStaffProfileId: true, claimedAt: true, status: true },
  });
  if (!settled?.claimedByStaffProfileId || !settled.claimedAt) {
    if (settled && settled.status !== 'SCHEDULED' && settled.status !== 'REJECTED') {
      return { status: 'NOT_CLAIMABLE', reason: 'INVALID_STATE' };
    }
    // The row lost its claim between the UPDATE and this read (an unclaim). Report
    // it as not-claimable rather than inventing a winner.
    return { status: 'NOT_CLAIMABLE', reason: 'NOT_A_POOL_OCCURRENCE' };
  }
  return {
    status:
      settled.claimedByStaffProfileId === staffProfileId
        ? 'ALREADY_CLAIMED_BY_CALLER'
        : 'CLAIMED_BY_OTHER',
    claimedByStaffProfileId: settled.claimedByStaffProfileId,
    claimedAt: settled.claimedAt,
  };
}

export type PoolQuery = {
  branchId: string;
  businessDateFrom?: Date;
  businessDateTo?: Date;
};

/**
 * The unclaimed pool items at a branch that this operator is eligible to take —
 * i.e. those whose pool role is one of the roles they hold there. Returns nothing
 * (rather than everything) for someone who holds no roles at that branch.
 */
export async function listClaimablePoolOccurrences(
  db: ScopedDb,
  staffProfileId: string,
  query: PoolQuery
) {
  const holdings = await db.restaurantStaffJobRole.findMany({
    where: { staffProfileId, branchId: query.branchId, jobRole: { active: true } },
    select: { jobRoleId: true },
  });
  if (holdings.length === 0) return [];

  return db.restaurantSopOccurrence.findMany({
    where: {
      branchId: query.branchId,
      claimedByStaffProfileId: null,
      poolJobRoleId: { in: holdings.map((row) => row.jobRoleId) },
      ...businessDateRange(query),
    },
    orderBy: [{ dueAt: 'asc' }],
  });
}

function businessDateRange(query: PoolQuery) {
  if (!query.businessDateFrom && !query.businessDateTo) return {};
  return {
    businessDate: {
      ...(query.businessDateFrom ? { gte: query.businessDateFrom } : {}),
      ...(query.businessDateTo ? { lte: query.businessDateTo } : {}),
    },
  };
}

/** How an occurrence reached a given operator. An occurrence may arrive by both. */
export type SopArrivalPath = 'DIRECT' | 'ROLE_POOL' | 'CLAIMED';

export type ResolvedStaffOccurrence = {
  occurrenceId: string;
  branchId: string;
  businessDate: Date;
  dueAt: Date;
  status: string;
  /** Every distinct path this occurrence reached the operator by, sorted. */
  paths: SopArrivalPath[];
  claimedByStaffProfileId: string | null;
};

/**
 * EVERY SOP occurrence that is this operator's to do at a branch, from BOTH
 * assignment modes, unioned and de-duplicated.
 *
 * Three sources feed in:
 *   DIRECT    — a PERSON-target assignment named them.
 *   ROLE_POOL — an unclaimed pool item for a role they hold.
 *   CLAIMED   — a pool item they have already taken.
 *
 * A single occurrence can genuinely arrive by more than one route (the owner's
 * case: the same checklist assigned to the `barista` role and directly to a named
 * barista produces two assignment rows, hence two occurrences — but where one
 * occurrence is reachable both ways, it is returned ONCE with both paths recorded).
 * De-duplication is by occurrence id and the `paths` array preserves the "how",
 * because a UI that has to explain why something is on your list needs that and
 * collapsing it away is lossy.
 *
 * Claimed-by-someone-else pool items are excluded: they are no longer this
 * operator's work.
 */
export async function listStaffSopOccurrences(
  db: ScopedDb,
  staffProfileId: string,
  query: PoolQuery
): Promise<ResolvedStaffOccurrence[]> {
  const dateRange = businessDateRange(query);
  const holdings = await db.restaurantStaffJobRole.findMany({
    where: { staffProfileId, branchId: query.branchId, jobRole: { active: true } },
    select: { jobRoleId: true },
  });
  const heldRoleIds = holdings.map((row) => row.jobRoleId);

  const select = {
    id: true,
    branchId: true,
    businessDate: true,
    dueAt: true,
    status: true,
    assignedStaffProfileId: true,
    poolJobRoleId: true,
    claimedByStaffProfileId: true,
  } as const;

  const orFilters: object[] = [{ assignedStaffProfileId: staffProfileId }];
  if (heldRoleIds.length > 0) {
    orFilters.push({
      poolJobRoleId: { in: heldRoleIds },
      claimedByStaffProfileId: null,
    });
  }
  orFilters.push({ claimedByStaffProfileId: staffProfileId });

  const rows = await db.restaurantSopOccurrence.findMany({
    where: { branchId: query.branchId, ...dateRange, OR: orFilters },
    select,
    orderBy: [{ dueAt: 'asc' }],
  });

  const byId = new Map<string, ResolvedStaffOccurrence>();
  for (const row of rows) {
    const paths = new Set<SopArrivalPath>();
    if (row.assignedStaffProfileId === staffProfileId) paths.add('DIRECT');
    if (row.claimedByStaffProfileId === staffProfileId) paths.add('CLAIMED');
    if (
      row.poolJobRoleId &&
      row.claimedByStaffProfileId === null &&
      heldRoleIds.includes(row.poolJobRoleId)
    ) {
      paths.add('ROLE_POOL');
    }
    if (paths.size === 0) continue;

    const existing = byId.get(row.id);
    if (existing) {
      for (const path of paths) {
        if (!existing.paths.includes(path)) existing.paths.push(path);
      }
      existing.paths.sort();
      continue;
    }
    byId.set(row.id, {
      occurrenceId: row.id,
      branchId: row.branchId,
      businessDate: row.businessDate,
      dueAt: row.dueAt,
      status: row.status,
      paths: [...paths].sort(),
      claimedByStaffProfileId: row.claimedByStaffProfileId,
    });
  }
  return [...byId.values()].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}
