import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { pharmacyActionErrorMessage } from './action-error-message';

describe('pharmacyActionErrorMessage', () => {
  it.each([
    ['inventory', 'The inventory action could not be completed. Review the fields and try again.'],
    ['finance', 'The finance action could not be completed. Review the fields and try again.'],
  ] as const)('returns fixed copy for the %s page', (surface, expected) => {
    expect(pharmacyActionErrorMessage(surface)).toBe(expected);
  });

  it('cannot observe or stringify a hostile thrown value, even when called from untyped code', () => {
    const failure = new Proxy(
      {},
      {
        get() {
          throw new Error('the failure value was inspected');
        },
        has() {
          throw new Error('the failure value was inspected');
        },
        ownKeys() {
          throw new Error('the failure value was inspected');
        },
      }
    );
    const untypedCall = pharmacyActionErrorMessage as (...args: unknown[]) => string;

    expect(untypedCall('finance', failure)).toBe(
      'The finance action could not be completed. Review the fields and try again.'
    );
  });

  it.each(['inventory', 'finance'])(
    'keeps raw errors out of the %s server-action redirect',
    (page) => {
      const source = readFileSync(`src/app/(app)/pharmacy/${page}/page.tsx`, 'utf8');

      expect(source).toContain(`pharmacyActionErrorMessage('${page}')`);
      expect(source).not.toMatch(/\berror\.message\b/);
    }
  );
});
