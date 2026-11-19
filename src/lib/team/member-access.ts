/**
 * DEV-959A — "What this person can do": a pharmacy member's sub-roles, read-only.
 *
 * Each catalogue action is decided by `can()`, the same engine every pharmacy
 * procedure enforces with (role template or custom role, per-person exceptions,
 * deny wins, static tenant-admin fallbacks). Nothing here grants or changes access.
 */
import { TRPCError } from '@trpc/server';
import { can, type Action } from '@/lib/abac';
import type { AuthzDb } from '@/lib/authz';
import {
  PHARMACY_SUB_ROLE_ACTIONS,
  pharmacySubRoleGroups,
  type PharmacySubRoleGroup,
} from '@/lib/abac/pharmacy-sub-roles';

export type MemberAccess = {
  member: {
    id: string;
    name: string;
    status: string;
    /** The person's role (ready-made or custom), or null when none is assigned. */
    roleName: string | null;
    customRole: boolean;
    /** Live per-person exceptions on top of the role. */
    exceptionCount: number;
    /**
     * A workspace administrator. Some pharmacy checks let an administrator through
     * before any permission is read (for example day close), so the ticks do not
     * show everything they can do until phase 2 makes the ticks binding.
     */
    workspaceAdmin: boolean;
  };
  groups: PharmacySubRoleGroup[];
};

export async function readPharmacyMemberAccess(
  db: AuthzDb,
  organizationId: string,
  userId: string,
  now: Date = new Date()
): Promise<MemberAccess> {
  const member = await db.user.findFirst({
    where: { id: userId, organizationId },
    select: {
      id: true,
      name: true,
      role: true,
      department: true,
      status: true,
      organizationRole: { select: { name: true, isSystem: true } },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { id: true },
      },
    },
  });
  if (!member) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });

  const subject = {
    id: member.id,
    role: member.role,
    department: member.department,
    status: member.status,
  };
  const allowed = new Set<Action>();
  // Sequential: the tenant client may be one interactive transaction.
  for (const action of PHARMACY_SUB_ROLE_ACTIONS) {
    if (await can(subject, action, undefined, { db, now, source: 'TRPC' })) allowed.add(action);
  }

  return {
    member: {
      id: member.id,
      name: member.name,
      status: member.status,
      roleName: member.organizationRole?.name ?? null,
      customRole: member.organizationRole ? !member.organizationRole.isSystem : false,
      exceptionCount: member.permissionOverrides.length,
      workspaceAdmin: member.role === 'ADMIN',
    },
    groups: pharmacySubRoleGroups(allowed),
  };
}
