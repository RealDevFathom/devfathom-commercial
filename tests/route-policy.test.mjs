import { describe, expect, test } from 'bun:test';
import { canAccessRolePath } from '../app/utils/routePolicy.ts';

describe('firm route policy', () => {
  test('keeps finance, team stats, and audit evidence admin-only', () => {
    for (const path of ['/finance', '/finance/invoices/1/print', '/team/stats', '/audit-logs']) {
      expect(canAccessRolePath(path, 'ADMIN')).toBe(true);
      expect(canAccessRolePath(path, 'HR')).toBe(false);
      expect(canAccessRolePath(path, 'EMPLOYEE')).toBe(false);
    }
  });

  test('allows only people-ops roles into the HR console', () => {
    expect(canAccessRolePath('/hr', 'ADMIN')).toBe(true);
    expect(canAccessRolePath('/hr', 'HR')).toBe(true);
    expect(canAccessRolePath('/hr', 'EMPLOYEE')).toBe(false);
  });

  test('keeps reviews and API docs open to authenticated employees like legacy', () => {
    expect(canAccessRolePath('/reviews', 'EMPLOYEE')).toBe(true);
    expect(canAccessRolePath('/api-docs', 'EMPLOYEE')).toBe(true);
  });
});
