import { liveDemoAccessExpiry } from '@/lib/auth/session-state';
import type { TRPCContext } from '@/server/trpc';
import { TRPCError } from '@trpc/server';

import { can, subjectFromSession } from '@/lib/abac';
import { resolveStaffCapabilities } from '@/lib/restaurant/job-roles';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type SessionUser = Parameters<typeof subjectFromSession>[0] & {
  organizationId?: string | null;
};

async function activeBranchIds(db: ScopedDb, organizationId: string, ids?: string[]) {
  const rows = await db.restaurantBranch.findMany({
    where: {
      organizationId,
      active: true,
      ...(ids ? { id: { in: ids } } : {}),
    },
    select: { id: true },
  });
  if (!ids) return rows.map((row) => row.id);
  const present = new Set(rows.map((row) => row.id));
  return ids.filter((id) => present.has(id));
}

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

/**
 * Resolve an authenticated staff actor's effective branch scope for one capability.
 * `organizationId` is the active tenant (`ctx.entitlements.organizationId`). A missing
 * tenant fails closed and is never taken from the session user.
 */
export async function resolveCapabilityBranchAuthorization(
  db: ScopedDb,
  user: SessionUser,
  capability: string,
  options: { organizationId: string | null | undefined; requireExactlyOneActiveActor?: boolean }
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

  const organizationId = options.organizationId;
  if (!organizationId) denyStaffBranchAccess();

  if (
    await can(subjectFromSession(user), 'restaurant:configure', undefined, {
      db,
      source: 'TRPC',
    })
  ) {
    return {
      actorStaffProfileId: actor?.id ?? null,
      actorBranchIds,
      organizationWide: true,
      branchIds: await activeBranchIds(db, organizationId),
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
  const activeIds = await activeBranchIds(db, organizationId, branchIds);
  if (activeIds.length === 0) denyStaffBranchAccess();
  return {
    actorStaffProfileId: actor.id,
    actorBranchIds,
    organizationWide: false,
    branchIds: activeIds,
  };
}

/** Resolve the authenticated actor's staff-administration scope, failing closed. */
export function resolveStaffBranchAuthorization(
  db: ScopedDb,
  user: SessionUser,
  organizationId: string | null | undefined
): Promise<StaffBranchAuthorization> {
  return resolveCapabilityBranchAuthorization(db, user, 'staff:manage', { organizationId });
}

export function assertAuthorizedBranch(
  authorization: StaffBranchAuthorization,
  branchId: string | null | undefined
): asserts branchId is string {
  if (!branchId || !authorization.branchIds.includes(branchId)) denyStaffBranchAccess();
}

/**
 * Require the derived staff identity itself to be linked to the target branch.
 * An organization-wide administrator (the owner) is eligible on every branch.
 */
export function assertActorEligibleForBranch(
  authorization: StaffBranchAuthorization,
  branchId: string
): void {
  if (authorization.organizationWide) return;
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

export type DemoDirectoryPolicy = {
  seatFromOrganizationId: (organizationId: string) => number | null;
  isCanonicalOrganization: (organization: NonNullable<TRPCContext['organization']>) => boolean;
  personaForUser: (seat: number, user: SessionUser) => string | null;
};

/** Console directories disclose only branches covered by the actor's existing read duty. */
export async function resolveDemoDirectoryScope(
  ctx: TRPCContext,
  directory: 'branches' | 'devices',
  demo: DemoDirectoryPolicy
) {
  if (!ctx.organization?.isDemo) return null;
  const user = ctx.session?.user;
  const seat = demo.seatFromOrganizationId(ctx.organization.id);
  if (
    !seat ||
    !user ||
    user.organizationId !== ctx.organization.id ||
    !demo.isCanonicalOrganization(ctx.organization) ||
    !liveDemoAccessExpiry(user.demoAccessExpiresAt)
  )
    denyStaffBranchAccess();
  const persona = demo.personaForUser(seat, user);
  const capability =
    persona === 'finance'
      ? 'money:read'
      : persona === 'inventory' && directory === 'branches'
        ? 'inventory:read'
        : null;
  if (!capability) return null;
  if (!(await can(subjectFromSession(user), capability, undefined, { db: ctx.db, source: 'TRPC' })))
    denyStaffBranchAccess();
  return resolveCapabilityBranchAuthorization(ctx.db, user, capability, {
    organizationId: ctx.entitlements?.organizationId,
    requireExactlyOneActiveActor: true,
  });
}
