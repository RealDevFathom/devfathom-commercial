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
  organizationWide: boolean;
  branchIds: string[];
};

/** Resolve the authenticated actor's staff-administration scope, failing closed. */
export async function resolveStaffBranchAuthorization(
  db: ScopedDb,
  user: SessionUser
): Promise<StaffBranchAuthorization> {
  if (
    await can(subjectFromSession(user), 'restaurant:configure', undefined, {
      db,
      source: 'TRPC',
    })
  ) {
    const branches = await db.restaurantBranch.findMany({ select: { id: true } });
    const actor = await db.restaurantStaffProfile.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
    return {
      actorStaffProfileId: actor?.id ?? null,
      organizationWide: true,
      branchIds: branches.map((branch) => branch.id),
    };
  }

  const actor = await db.restaurantStaffProfile.findFirst({
    where: { userId: user.id, status: 'ACTIVE' },
    select: {
      id: true,
      jobRoles: { select: { branchId: true } },
      directCapabilityGrants: { select: { branchId: true } },
    },
  });
  if (!actor) denyStaffBranchAccess();

  const candidates = new Set([
    ...actor.jobRoles.map((row) => row.branchId),
    ...actor.directCapabilityGrants.map((row) => row.branchId),
  ]);
  const decisions = await Promise.all(
    [...candidates].map(async (branchId) => ({
      branchId,
      allowed: (await resolveStaffCapabilities(db, actor.id, branchId)).has('staff:manage'),
    }))
  );
  const branchIds = decisions.filter((row) => row.allowed).map((row) => row.branchId);
  if (branchIds.length === 0) denyStaffBranchAccess();
  return { actorStaffProfileId: actor.id, organizationWide: false, branchIds };
}

export function assertAuthorizedBranch(
  authorization: StaffBranchAuthorization,
  branchId: string | null | undefined
): asserts branchId is string {
  if (!branchId || !authorization.branchIds.includes(branchId)) denyStaffBranchAccess();
}

export function assertOrganizationWide(authorization: StaffBranchAuthorization): void {
  if (!authorization.organizationWide) denyStaffBranchAccess();
}

/** Authorize a global profile operation through one of its effective branch links. */
export async function assertAuthorizedStaffProfile(
  db: ScopedDb,
  authorization: StaffBranchAuthorization,
  staffProfileId: string
): Promise<void> {
  if (authorization.organizationWide) {
    const profile = await db.restaurantStaffProfile.findUnique({
      where: { id: staffProfileId },
      select: { id: true },
    });
    if (!profile) denyStaffBranchAccess();
    return;
  }

  const profile = await db.restaurantStaffProfile.findUnique({
    where: { id: staffProfileId },
    select: {
      primaryBranchId: true,
      jobRoles: { select: { branchId: true } },
      directCapabilityGrants: { select: { branchId: true } },
    },
  });
  const linked = new Set([
    ...(profile?.primaryBranchId ? [profile.primaryBranchId] : []),
    ...(profile?.jobRoles.map((row) => row.branchId) ?? []),
    ...(profile?.directCapabilityGrants.map((row) => row.branchId) ?? []),
  ]);
  if (![...linked].some((branchId) => authorization.branchIds.includes(branchId))) {
    denyStaffBranchAccess();
  }
}
