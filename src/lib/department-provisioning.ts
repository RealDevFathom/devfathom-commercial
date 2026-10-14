/**
 * WHA-290 — department resolution for the paths that provision a user WITHOUT
 * an operator choosing a department.
 *
 * WHA-278 made `User.department` a composite foreign key onto
 * `organization_departments`, so there is no longer any key that is valid in
 * every tenant: a Restaurant organization has KITCHEN/FRONT_OF_HOUSE and no
 * LEADERSHIP at all, and any tenant may deactivate or rename what it does not
 * use. The invite paths (tRPC `team.inviteMember`, the assistant's people
 * tools) take a key from the caller and validate it against the tenant's active
 * catalog. The identity paths cannot: an IdP asserts an identity, not a
 * department, so they must DERIVE one from the tenant's own catalog.
 */
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  adminDepartmentKeyForVertical,
  memberDepartmentKeyForVertical,
} from '@/lib/vertical-catalog';

/**
 * Raised when a tenant has deactivated every department, which
 * `organizationAdmin.updateDepartment` permits. Distinguishable so the SCIM
 * route can answer the directory with a stated SCIM error instead of a 500.
 */
export class EmptyDepartmentCatalogError extends Error {
  constructor() {
    super(
      'This organization has no active department to file the account under. Add one before provisioning users from a directory.'
    );
    this.name = 'EmptyDepartmentCatalogError';
  }
}

/**
 * The department key a directory-provisioned user is filed under, resolved
 * against the tenant's OWN active catalog.
 *
 * Prefers this vertical's declared default for the role; falls back to the
 * first active department when the tenant has removed that default. The
 * fallback is deliberate: a tenant with a perfectly valid catalog that happens
 * not to contain ENGINEERING must not have every SSO login fail. Only a tenant
 * with NO active department at all is unresolvable, and that is reported as a
 * stated error rather than left to surface as
 * `users_organizationId_department_fkey`.
 *
 * `db` must already be scoped to `organizationId` — the catalog read is
 * additionally filtered by it so the resolution cannot cross tenants even if a
 * caller passes a platform-scoped client.
 */
export async function resolveProvisionedDepartmentKey(
  db: ScopedDb,
  organizationId: string,
  role: string
): Promise<string> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { vertical: true },
  });
  if (!organization) {
    throw new Error('The organization this identity belongs to no longer exists.');
  }

  const preferred =
    role === 'ADMIN'
      ? adminDepartmentKeyForVertical(organization.vertical)
      : memberDepartmentKeyForVertical(organization.vertical);

  const departments = await db.organizationDepartment.findMany({
    where: { organizationId, active: true },
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    select: { key: true },
  });
  if (departments.some((department) => department.key === preferred)) return preferred;

  const fallback = departments[0]?.key;
  if (!fallback) throw new EmptyDepartmentCatalogError();
  return fallback;
}
