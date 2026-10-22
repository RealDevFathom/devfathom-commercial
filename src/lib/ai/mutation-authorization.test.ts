import { describe, expect, it } from 'vitest';
import { can, type AIMutationPrincipal } from './mutation-authorization';

describe('AI mutation authorization', () => {
  it('is default deny and gives an explicit deny precedence over allow', () => {
    const principal: AIMutationPrincipal = {
      id: 'test',
      allow: ['usage:write'],
      deny: ['usage:write'],
    };
    expect(can(principal, 'usage:write')).toBe(false);
    expect(can(principal, 'budget-alert:write')).toBe(false);
  });
});
