type Rule = { capability: string; effect: string };

/** Tenant authority comes from the live database identity, never a session role.
 * Resource scope, PIN reauthentication and maker-checker remain separate checks.
 */
export function hasAllCapabilityAccess(user: {
  status?: string;
  role?: string;
  organizationRole?: { key?: string; isSystem?: boolean; permissions: readonly Rule[] } | null;
  permissionOverrides: readonly Rule[];
}): boolean {
  if (user.status !== 'ACTIVE') return false;
  const role = user.organizationRole;
  if (role?.isSystem && role.key === 'owner') return true;
  return (
    (user.role === 'ADMIN' || Boolean(role?.isSystem && role.key === 'owner-operator')) &&
    [...(role?.permissions ?? []), ...user.permissionOverrides].some(
      (rule) => rule.capability === '*' && rule.effect === 'ALLOW'
    )
  );
}
