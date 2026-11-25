import { describe, expect, it, vi } from 'vitest';
import { mayCorrectRole } from './provider-refunds';
vi.mock('server-only', () => ({}));
const reviewer = {
  ownerAuthority: false,
  roleIdentity: 'reviewer',
  roleRules: ['ALLOW:pharmacy:manage', 'ALLOW:finance:read'],
};
describe('original card review authority', () => {
  it('accepts the same role and a higher role with all original grants', () => {
    expect(mayCorrectRole(reviewer, reviewer)).toBe(true);
    expect(
      mayCorrectRole(
        {
          ...reviewer,
          roleIdentity: 'senior',
          roleRules: ['ALLOW:pharmacy:manage', 'ALLOW:finance:*'],
        },
        reviewer
      )
    ).toBe(true);
  });
  it('refuses a lower or incomparable role and a higher role with a new restriction', () => {
    for (const roleRules of [
      ['ALLOW:finance:read'],
      ['ALLOW:pharmacy:manage', 'ALLOW:finance:manage'],
      [...reviewer.roleRules, 'ALLOW:finance:manage', 'DENY:pharmacy:counter'],
    ])
      expect(mayCorrectRole({ ...reviewer, roleIdentity: 'other', roleRules }, reviewer)).toBe(
        false
      );
  });
  it('requires an owner to correct a historical or owner decision', () => {
    const owner = { ...reviewer, ownerAuthority: true, roleIdentity: null };
    expect(mayCorrectRole(reviewer, owner)).toBe(false);
    expect(mayCorrectRole(owner, owner)).toBe(true);
  });
});
