type Rule = { capability: string; effect: string };

/** Tenant authority comes from the live database identity, never a session role.
 * Resource scope, PIN reauthentication and maker-checker remain separate checks.
 * Only the system `owner` role, or an ADMIN with a live `*` grant, qualifies. The
 * `owner-operator` template is an operational bundle, not tenant ownership: an
 * EMPLOYEE holding it must not gain cross-branch scope or self-approval.
 * An explicit DENY always wins: anyone with a live DENY rule (override or role) is
 * restricted, so they never hold all-capability access, system Owner included.
 */
export function hasAllCapabilityAccess(user: {
  status?: string;
  role?: string;
  organizationRole?: { key?: string; isSystem?: boolean; permissions: readonly Rule[] } | null;
  permissionOverrides: readonly Rule[];
}): boolean {
  if (user.status !== 'ACTIVE') return false;
  const role = user.organizationRole;
  const rules = [...user.permissionOverrides, ...(role?.permissions ?? [])];
  if (rules.some((rule) => rule.effect === 'DENY')) return false;
  if (role?.isSystem && role.key === 'owner') return true;
  return (
    user.role === 'ADMIN' &&
    rules.some((rule) => rule.capability === '*' && rule.effect === 'ALLOW')
  );
}
