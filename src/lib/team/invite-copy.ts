import type { OrganizationVertical } from '@/lib/vertical-catalog';

export type BaseRole = 'EMPLOYEE' | 'HR' | 'ADMIN';

export interface InviteCopy {
  staffRoleLabel: string;
  staffRoleHelp: string;
  noRoleOption: string;
  namePlaceholder: string;
  emailPlaceholder: string;
  titlePlaceholder: string;
  phonePlaceholder: string;
  baseRoleLabels: Record<BaseRole, string>;
}

const PHONE_PLACEHOLDER = '+92 300 1234567';
const WORKSPACE_BASE_ROLES: Record<BaseRole, string> = {
  EMPLOYEE: 'Employee',
  HR: 'HR',
  ADMIN: 'Admin',
};

/**
 * Team invite and member-edit copy for the tenant's operating vertical.
 * A missing vertical (e.g. the anonymous invite-accept page) gets the neutral
 * workspace copy. The switch is exhaustive so a new vertical fails typecheck.
 */
export function inviteCopyForVertical(
  vertical: OrganizationVertical | null | undefined
): InviteCopy {
  const v: OrganizationVertical = vertical ?? 'AGENCY';
  switch (v) {
    case 'PHARMACY':
      return {
        staffRoleLabel: 'Pharmacy staff role',
        staffRoleHelp:
          'Choose the pharmacy role that controls dispensing, catalogue and counter access.',
        noRoleOption: 'No pharmacy role',
        namePlaceholder: 'Ali Raza',
        emailPlaceholder: 'ali@pharmacy.pk',
        titlePlaceholder: 'Pharmacist',
        phonePlaceholder: PHONE_PLACEHOLDER,
        baseRoleLabels: { EMPLOYEE: 'Staff', HR: 'Manager', ADMIN: 'Admin' },
      };
    case 'RESTAURANT':
      return {
        staffRoleLabel: 'Restaurant staff role',
        staffRoleHelp: 'Choose the workspace role that controls restaurant access.',
        noRoleOption: 'No staff role',
        namePlaceholder: 'Ali Raza',
        emailPlaceholder: 'ali@restaurant.pk',
        titlePlaceholder: 'Shift Manager',
        phonePlaceholder: PHONE_PLACEHOLDER,
        baseRoleLabels: WORKSPACE_BASE_ROLES,
      };
    case 'HOSPITALITY':
      return {
        staffRoleLabel: 'Hotel staff role',
        staffRoleHelp: 'Choose the hotel role that controls front desk and housekeeping access.',
        noRoleOption: 'No hotel role',
        namePlaceholder: 'Ali Raza',
        emailPlaceholder: 'ali@hotel.pk',
        titlePlaceholder: 'Front Desk Agent',
        phonePlaceholder: PHONE_PLACEHOLDER,
        baseRoleLabels: WORKSPACE_BASE_ROLES,
      };
    case 'AGENCY':
      return {
        staffRoleLabel: 'Workspace role',
        staffRoleHelp: 'Choose the workspace role that controls access.',
        noRoleOption: 'No workspace role',
        namePlaceholder: 'Ali Raza',
        emailPlaceholder: 'ali@company.pk',
        titlePlaceholder: 'Project Manager',
        phonePlaceholder: PHONE_PLACEHOLDER,
        baseRoleLabels: WORKSPACE_BASE_ROLES,
      };
    default: {
      const unreachable: never = v;
      throw new Error(`Unhandled vertical: ${String(unreachable)}`);
    }
  }
}
