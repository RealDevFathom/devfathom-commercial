import { departmentsForVertical, type OrganizationVertical } from '@/lib/vertical-catalog';
import { inviteCopyForVertical, type BaseRole } from '@/lib/team/invite-copy';

export type AccountRoleInput = {
  vertical: OrganizationVertical | null | undefined;
  /** The base access role on the session (`ADMIN` | `HR` | `EMPLOYEE`). */
  role: string | null | undefined;
  department?: string | null;
  /** The member's assigned organization role, when one is assigned. */
  organizationRole?: { key: string; name: string } | null;
};

export type AccountRoleView = {
  /** Human role label; never a raw enum such as `ADMIN` or `EMPLOYEE`. */
  role: string;
  /** Human department name, or null when the department should not be shown. */
  department: string | null;
};

function isBaseRole(role: string): role is BaseRole {
  return role === 'ADMIN' || role === 'HR' || role === 'EMPLOYEE';
}

/**
 * The role and department a signed-in member sees for their own account, shared
 * by the header and the Settings account card so the two can never disagree.
 *
 * Pharmacy: the provisioned administrator is the pharmacy owner, so it reads as
 * "Owner" and is not filed under a single department (provisioning files it
 * under Counter only because the catalog requires a department). Everyone else
 * reads as their assigned organization role, falling back to the vertical's
 * base-role label. Presentation only — never used for access decisions.
 */
export function accountRoleView({
  vertical,
  role,
  department,
  organizationRole,
}: AccountRoleInput): AccountRoleView {
  const baseRole = role ?? '';
  const departmentName = department
    ? (departmentsForVertical(vertical ?? 'AGENCY').find((entry) => entry.key === department)
        ?.name ?? department)
    : null;

  if (vertical === 'PHARMACY' && baseRole === 'ADMIN') {
    return { role: 'Owner', department: null };
  }

  const label =
    organizationRole?.name?.trim() ||
    (isBaseRole(baseRole) ? inviteCopyForVertical(vertical).baseRoleLabels[baseRole] : baseRole);
  return { role: label, department: departmentName };
}
