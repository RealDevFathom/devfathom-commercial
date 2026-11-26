import { expect, it } from 'vitest';
import config from '../next.config';

it('omits token-bearing join paths from development access logs while retaining API status logs', () => {
  const logging = config.logging && config.logging.incomingRequests;
  const ignored = typeof logging === 'object' ? (logging.ignore ?? []) : [];
  expect(ignored.some((pattern) => pattern.test('/my-pharmacy/join/fixture'))).toBe(true);
  expect(ignored.some((pattern) => pattern.test('/api/pharmacy/portal/start'))).toBe(false);
});
