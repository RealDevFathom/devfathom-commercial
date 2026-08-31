import { TRPCError } from '@trpc/server';

import { can, subjectFromSession } from '@/lib/abac';
import { resolveStaffCapabilities } from '@/lib/restaurant/job-roles';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type SessionUser = Parameters<typeof subjectFromSession>[0];

const DENIED = new TRPCError({
  code: 'FORBIDDEN',
  message: 'You are not authorized to administer staff for this branch.',
});

export function denyStaffBranchAccess(): never {
  throw DENIED;
}

export type StaffBranchAuthorization = {
  actorStaffProfileId: string | null;
  actorBranchIds: string[];
  organizationWide: boolean;
  branchIds: string[];
};

/** Resolve an authenticated staff actor's effective branch scope for one capability. */
export async function resolveCapabilityBranchAuthorization(
  db: ScopedDb,
  user: SessionUser,
  capability: string,
  options: { requireExactlyOneActiveActor?: boolean } = {}
): Promise<StaffBranchAuthorization> {
  const actors = await db.restaurantStaffProfile.findMany({
    where: { userId: user.id, status: 'ACTIVE' },
    select: {
      id: true,
      primaryBranchId: true,
      jobRoles: { select: { branchId: true } },
      directCapabilityGrants: { select: { branchId: true } },
    },
    orderBy: { id: 'asc' },
    take: 2,
  });
  if (options.requireExactlyOneActiveActor && actors.length !== 1) denyStaffBranchAccess();
  const actor = actors[0] ?? null;
  const actorBranchIds = actor
    ? [
        ...new Set([
          ...(actor.primaryBranchId ? [actor.primaryBranchId] : []),
          ...actor.jobRoles.map((row) => row.branchId),
          ...actor.directCapabilityGrants.map((row) => row.branchId),
        ]),
      ]
    : [];

  if (
    await can(subjectFromSession(user), 'restaurant:configure', undefined, {
      db,
      source: 'TRPC',
    })
  ) {
    const branches = await db.restaurantBranch.findMany({ select: { id: true } });
    return {
      actorStaffProfileId: actor?.id ?? null,
      actorBranchIds,
      organizationWide: true,
      branchIds: branches.map((branch) => branch.id),
    };
  }

  if (!actor) denyStaffBranchAccess();

  const candidates = new Set([
    ...actor.jobRoles.map((row) => row.branchId),
    ...actor.directCapabilityGrants.map((row) => row.branchId),
  ]);
  const decisions = await Promise.all(
    [...candidates].map(async (branchId) => ({
      branchId,
      allowed: (await resolveStaffCapabilities(db, actor.id, branchId)).has(capability),
    }))
  );
  const branchIds = decisions.filter((row) => row.allowed).map((row) => row.branchId);
  if (branchIds.length === 0) denyStaffBranchAccess();
  return { actorStaffProfileId: actor.id, actorBranchIds, organizationWide: false, branchIds };
}

/** Resolve the authenticated actor's staff-administration scope, failing closed. */
export function resolveStaffBranchAuthorization(
  db: ScopedDb,
  user: SessionUser
): Promise<StaffBranchAuthorization> {
  return resolveCapabilityBranchAuthorization(db, user, 'staff:manage');
}

export function assertAuthorizedBranch(
  authorization: StaffBranchAuthorization,
  branchId: string | null | undefined
): asserts branchId is string {
  if (!branchId || !authorization.branchIds.includes(branchId)) denyStaffBranchAccess();
}

/** Require the derived staff identity itself to be linked to the target branch. */
export function assertActorEligibleForBranch(
  authorization: StaffBranchAuthorization,
  branchId: string
): void {
  if (!authorization.actorBranchIds.includes(branchId)) denyStaffBranchAccess();
}

export function assertOrganizationWide(authorization: StaffBranchAuthorization): void {
  if (!authorization.organizationWide) denyStaffBranchAccess();
}

/** Require an in-tenant profile without revealing whether a rejected id exists elsewhere. */
export async function assertStaffProfileExists(
  db: ScopedDb,
  staffProfileId: string
): Promise<void> {
  const profile = await db.restaurantStaffProfile.findUnique({
    where: { id: staffProfileId },
    select: { id: true },
  });
  if (!profile) denyStaffBranchAccess();
}

/** Authorize a global profile operation across every branch it can affect. */
export async function assertAuthorizedStaffProfile(
  db: ScopedDb,
  authorization: StaffBranchAuthorization,
  staffProfileId: string
): Promise<void> {
  const profile = await db.restaurantStaffProfile.findUnique({
    where: { id: staffProfileId },
    select: {
      primaryBranchId: true,
      jobRoles: { select: { branchId: true } },
      directCapabilityGrants: { select: { branchId: true } },
    },
  });
  if (!profile) denyStaffBranchAccess();
  if (authorization.organizationWide) return;

  const linked = new Set([
    ...(profile.primaryBranchId ? [profile.primaryBranchId] : []),
    ...profile.jobRoles.map((row) => row.branchId),
    ...profile.directCapabilityGrants.map((row) => row.branchId),
  ]);
  if (
    linked.size === 0 ||
    [...linked].some((branchId) => !authorization.branchIds.includes(branchId))
  ) {
    denyStaffBranchAccess();
  }
}
