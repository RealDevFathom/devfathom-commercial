import { describe, expect, it } from 'vitest';
import { accountRoleView } from './account-role';

describe('accountRoleView', () => {
  it('reads the pharmacy administrator as the Owner with no single department', () => {
    const view = accountRoleView({ vertical: 'PHARMACY', role: 'ADMIN', department: 'COUNTER' });
    expect(view).toEqual({ role: 'Owner', department: null });
  });

  it('prefers the assigned organization role for pharmacy staff', () => {
    expect(
      accountRoleView({
        vertical: 'PHARMACY',
        role: 'EMPLOYEE',
        department: 'PROCUREMENT',
        organizationRole: { key: 'procurement-approver', name: 'Procurement approver' },
      })
    ).toEqual({ role: 'Procurement approver', department: 'Procurement' });
  });

  it('falls back to the vertical base-role label, never a raw enum', () => {
    expect(accountRoleView({ vertical: 'PHARMACY', role: 'EMPLOYEE' }).role).toBe('Staff');
    expect(accountRoleView({ vertical: 'PHARMACY', role: 'HR' }).role).toBe('Manager');
    expect(accountRoleView({ vertical: 'AGENCY', role: 'ADMIN' }).role).toBe('Admin');
  });

  it('keeps an unknown department key readable rather than blank', () => {
    const view = accountRoleView({ vertical: 'AGENCY', role: 'EMPLOYEE', department: 'X' });
    expect(view.department).toBe('X');
  });
});
