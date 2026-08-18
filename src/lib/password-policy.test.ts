import { describe, expect, it } from 'vitest';

import { passwordMeetsPolicy, passwordRules, passwordSchema } from './password-policy';

describe('password policy', () => {
  it('keeps the live checklist and server schema aligned for valid passwords', () => {
    const password = 'Control9!';

    expect(passwordMeetsPolicy(password)).toBe(true);
    expect(passwordRules.every((rule) => rule.test(password))).toBe(true);
    expect(passwordSchema.safeParse(password).success).toBe(true);
  });

  it.each([
    ['too short', 'Abc123'],
    ['missing lowercase', 'CONTROL9!'],
    ['missing uppercase', 'control9!'],
    ['missing number', 'Control!!'],
  ])('rejects %s passwords', (_case, password) => {
    expect(passwordMeetsPolicy(password)).toBe(false);
    expect(passwordSchema.safeParse(password).success).toBe(false);
  });
});
