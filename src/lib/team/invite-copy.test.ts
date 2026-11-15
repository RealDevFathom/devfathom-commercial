import { describe, expect, it } from 'vitest';
import { verticalForModuleKey } from '@/lib/module-catalog';
import { inviteCopyForVertical } from './invite-copy';
import {
  INVITE_ROLE_MISMATCH,
  INVITE_ROLE_NOT_OFFERED,
  inviteRoleRefusal,
} from '@/lib/vertical-catalog';

const restaurantVertical = verticalForModuleKey('restaurant-core')!;
const flatten = (value: unknown): string => JSON.stringify(value);

describe('inviteCopyForVertical', () => {
  it('gives pharmacy tenants pharmacy copy', () => {
    const copy = inviteCopyForVertical('PHARMACY');
    expect(copy.staffRoleLabel).toBe('Pharmacy staff role');
    expect(copy.noRoleOption).toBe('No pharmacy role');
    expect(copy.titlePlaceholder).toBe('Pharmacist');
    expect(copy.phonePlaceholder.startsWith('+92')).toBe(true);
    expect(copy.baseRoleLabels).toEqual({ EMPLOYEE: 'Staff', HR: 'Manager', ADMIN: 'Admin' });
  });

  it('gives pharmacy one role picker whose labels match the grant (DEV-673, SEC-I)', () => {
    const copy = inviteCopyForVertical('PHARMACY');
    // Only the administrator role carries a base role above Staff.
    expect(copy.roleTemplateBaseRoles).toEqual({ admin: 'ADMIN' });
    expect(copy.inviteHiddenRoleTemplateKeys).toEqual(['owner', 'owner-operator']);
    expect(copy.roleTemplateDescriptions!.admin).toMatch(/billing and team/);
    // Hidden roles carry no description that could describe a grant they no longer get.
    expect(copy.roleTemplateDescriptions).not.toHaveProperty('owner');
    expect(copy.roleTemplateDescriptions).not.toHaveProperty('owner-operator');
    (copy.inviteHiddenRoleTemplateKeys as string[]).pop();
    expect(inviteCopyForVertical('PHARMACY').inviteHiddenRoleTemplateKeys).toHaveLength(2);
    // A caller mutating its copy never leaks into the next tenant's form.
    (copy.roleTemplateBaseRoles as Record<string, string>).pharmacist = 'ADMIN';
    expect(inviteCopyForVertical('PHARMACY').roleTemplateBaseRoles).not.toHaveProperty(
      'pharmacist'
    );
  });

  it.each(['AGENCY', 'HOSPITALITY', restaurantVertical] as const)(
    'keeps the separate base role switch for %s',
    (vertical) => {
      expect(inviteCopyForVertical(vertical).roleTemplateBaseRoles).toBeUndefined();
    }
  );

  it('keeps restaurant copy for restaurant tenants', () => {
    const copy = inviteCopyForVertical(restaurantVertical);
    expect(copy.staffRoleLabel).toBe('Restaurant staff role');
    expect(copy.staffRoleHelp).toBe('Choose the workspace role that controls restaurant access.');
    expect(copy.titlePlaceholder).toBe('Shift Manager');
    expect(copy.phonePlaceholder.startsWith('+92')).toBe(true);
  });

  it('gives hospitality tenants hotel copy', () => {
    const copy = inviteCopyForVertical('HOSPITALITY');
    expect(copy.staffRoleLabel).toBe('Hotel staff role');
    expect(copy.staffRoleHelp).toMatch(/front desk and housekeeping/);
    expect(copy.titlePlaceholder).toBe('Front Desk Agent');
    expect(copy.phonePlaceholder.startsWith('+92')).toBe(true);
  });

  it('gives agency tenants neutral workspace copy', () => {
    const copy = inviteCopyForVertical('AGENCY');
    expect(copy.staffRoleLabel).toBe('Workspace role');
    expect(copy.staffRoleHelp).toBe('Choose the workspace role that controls access.');
    expect(copy.titlePlaceholder).toBe('Project Manager');
    expect(copy.phonePlaceholder.startsWith('+92')).toBe(true);
    expect(copy.baseRoleLabels).toEqual({ EMPLOYEE: 'Employee', HR: 'HR', ADMIN: 'Admin' });
  });

  it('falls back to the neutral workspace copy without a vertical', () => {
    expect(inviteCopyForVertical(null)).toEqual(inviteCopyForVertical('AGENCY'));
    expect(inviteCopyForVertical(undefined)).toEqual(inviteCopyForVertical('AGENCY'));
  });

  it.each(['PHARMACY', 'HOSPITALITY', 'AGENCY'] as const)(
    'never mentions restaurants for %s',
    (vertical) => {
      expect(flatten(inviteCopyForVertical(vertical))).not.toMatch(/restaurant/i);
    }
  );

  it.each(['PHARMACY', restaurantVertical, 'HOSPITALITY', 'AGENCY'] as const)(
    'drops the US placeholder phone for %s',
    (vertical) => {
      expect(flatten(inviteCopyForVertical(vertical))).not.toMatch(/555-01|\+1 \(/);
    }
  );
});

// SEC-I (DEV-827): the server refuses an invite whose base role is not what the
// chosen role's label grants.
describe('inviteRoleRefusal', () => {
  it.each([
    ['admin', 'ADMIN'],
    ['manager', 'EMPLOYEE'],
    ['pharmacist', 'EMPLOYEE'],
    ['cashier', 'EMPLOYEE'],
    [null, 'EMPLOYEE'],
  ] as const)('accepts pharmacy %s at %s', (key, baseRole) => {
    expect(inviteRoleRefusal('PHARMACY', baseRole, key)).toBeNull();
  });

  it.each([
    ['manager', 'HR'],
    ['manager', 'ADMIN'],
    ['pharmacist', 'ADMIN'],
    ['admin', 'EMPLOYEE'],
    [null, 'HR'],
    [null, 'ADMIN'],
  ] as const)('refuses pharmacy %s at %s', (key, baseRole) => {
    expect(inviteRoleRefusal('PHARMACY', baseRole, key)).toBe(INVITE_ROLE_MISMATCH);
  });

  it.each(['owner', 'owner-operator'])('refuses pharmacy %s at any base role', (key) => {
    for (const baseRole of ['ADMIN', 'HR', 'EMPLOYEE'] as const) {
      expect(inviteRoleRefusal('PHARMACY', baseRole, key)).toBe(INVITE_ROLE_NOT_OFFERED);
    }
  });

  it.each(['AGENCY', 'HOSPITALITY', restaurantVertical, null, undefined] as const)(
    'leaves the separate base role switch of %s unconstrained',
    (vertical) => {
      expect(inviteRoleRefusal(vertical, 'ADMIN', 'owner')).toBeNull();
      expect(inviteRoleRefusal(vertical, 'HR', null)).toBeNull();
    }
  );
});
