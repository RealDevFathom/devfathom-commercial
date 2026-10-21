import { describe, expect, it } from 'vitest';

import { safeUserSelect } from './safe-user-select';

describe('safeUserSelect', () => {
  it('never selects authentication or recovery secrets for user responses', () => {
    expect(safeUserSelect).not.toHaveProperty('password');
    expect(safeUserSelect).not.toHaveProperty('passwordChangedAt');
    expect(safeUserSelect).not.toHaveProperty('tokenVersion');
    expect(safeUserSelect).not.toHaveProperty('twoFactorSecret');
    expect(safeUserSelect).not.toHaveProperty('recoveryCodes');
    expect(safeUserSelect).not.toHaveProperty('passwordResetTokens');
  });
});
