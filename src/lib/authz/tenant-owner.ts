import type { AuthzDb } from '@/lib/authz';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';

type OwnerRecord = {
  organizationId: string | null;
  status: string;
  role: string;
  organizationRole: { organizationId: string; key: string; isSystem: boolean } | null;
};

/** Persisted tenant authority, never a session role or a user-created role name. */
export function isTenantOwnerRecord(
  user: OwnerRecord | null,
  organizationId: string | null | undefined
): boolean {
  if (
    !organizationId ||
    !user ||
    user.organizationId !== organizationId ||
    !ACTIVE_STATUSES.has(user.status)
  )
    return false;
  const role = user.organizationRole;
  return (
    user.role === 'ADMIN' ||
    !!(
      role?.organizationId === organizationId &&
      role.isSystem &&
      ['owner', 'admin'].includes(role.key)
    )
  );
}

export async function isTenantOwner(
  db: AuthzDb,
  userId: string,
  organizationId: string
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      organizationId: true,
      status: true,
      role: true,
      organizationRole: { select: { organizationId: true, key: true, isSystem: true } },
    },
  });
  return isTenantOwnerRecord(user, organizationId);
}
