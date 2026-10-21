import { describe, expect, it } from 'vitest';

import { pharmacyActionErrorMessage } from './action-error-message';

describe('pharmacyActionErrorMessage', () => {
  it.each([
    ['inventory', 'The inventory action could not be completed. Review the fields and try again.'],
    ['finance', 'The finance action could not be completed. Review the fields and try again.'],
  ] as const)('returns fixed copy for the %s page', (surface, expected) => {
    const internalMessage = 'password=secret; relation "private_ledger" does not exist';

    const message = pharmacyActionErrorMessage(surface, new Error(internalMessage));

    expect(message).toBe(expected);
    expect(message).not.toContain(internalMessage);
  });

  it('does not stringify non-Error failures', () => {
    const failure = { message: 'sensitive provider response' };

    expect(pharmacyActionErrorMessage('finance', failure)).not.toContain(failure.message);
  });
});
