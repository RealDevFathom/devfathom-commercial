import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { passwordResetDenial } from './admin-password-reset';

const base = { actorId: 'a1', actorRole: 'ADMIN', targetId: 't1', targetRole: 'EMPLOYEE' };

describe('passwordResetDenial', () => {
  it('lets an admin reset a lower or equal role', () => {
    expect(passwordResetDenial(base)).toBeNull();
    expect(passwordResetDenial({ ...base, targetRole: 'ADMIN' })).toBeNull();
  });

  it('refuses a reset of a higher role', () => {
    expect(passwordResetDenial({ ...base, actorRole: 'HR', targetRole: 'ADMIN' })).toMatch(
      /higher role/
    );
    expect(passwordResetDenial({ ...base, targetRole: 'SUPERUSER' })).toMatch(/higher role/);
  });

  it('refuses resetting your own password', () => {
    expect(passwordResetDenial({ ...base, targetId: 'a1', targetRole: 'ADMIN' })).toMatch(/own/);
  });
});
