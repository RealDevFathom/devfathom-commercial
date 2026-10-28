/** Tenant ownership is server-loaded role state, never a caller-selected staff ID. */
export function isTenantAdministrator(
  user:
    | {
        role?: string | null;
        organizationRole?: { key?: string | null } | null;
      }
    | null
    | undefined
): boolean {
  return (
    user?.role === 'ADMIN' ||
    ['owner', 'admin', 'owner-operator'].includes(user?.organizationRole?.key ?? '')
  );
}
