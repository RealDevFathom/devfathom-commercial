import { describe, expect, it } from 'vitest';
import { verticalForModuleKey } from '@/lib/module-catalog';
import { inviteCopyForVertical } from './invite-copy';

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

  it('gives pharmacy one role picker with distinct owner-role descriptions (DEV-673)', () => {
    const copy = inviteCopyForVertical('PHARMACY');
    expect(copy.roleTemplateBaseRoles).toEqual({
      admin: 'ADMIN',
      owner: 'ADMIN',
      'owner-operator': 'ADMIN',
      manager: 'HR',
    });
    const descriptions = copy.roleTemplateDescriptions!;
    const owners = ['admin', 'owner', 'owner-operator'].map((key) => descriptions[key]);
    expect(owners.every((text) => typeof text === 'string' && text.length > 0)).toBe(true);
    expect(new Set(owners).size).toBe(3);
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
