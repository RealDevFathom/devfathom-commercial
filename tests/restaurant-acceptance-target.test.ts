// @vitest-environment node
import { expect, it } from 'vitest';
import {
  assertAcceptanceBrowser,
  assertAcceptanceDatabase,
  acceptanceOrigin,
  type AcceptanceReceipt,
} from '../scripts/restaurant-acceptance-target';

it('binds database and configured browser to the exact candidate, never another loopback lane', () => {
  const receipt: AcceptanceReceipt = {
    environment: 'TEST_SANDBOX',
    repository: '/unused',
    sourceManifestSHA256: 'unused',
    database: 'restaurant_growth_test_contract',
    databasePort: 55683,
    runtimeRole: 'restaurant_acceptance_runtime',
    ownerRole: 'restaurant_acceptance_owner',
    appOrigin: acceptanceOrigin,
    appPid: 123,
    buildId: 'synthetic-source-check',
    stages: ['migrate', 'app'],
  };
  const url =
    'postgresql://restaurant_acceptance_runtime@127.0.0.1:55683/restaurant_growth_test_contract';
  expect(assertAcceptanceDatabase(url, receipt)).toBe(url);
  expect(assertAcceptanceBrowser(acceptanceOrigin, receipt)).toBe(acceptanceOrigin);
  for (const port of [5432, 55620, 55621, 55671, 55672, 55675, 55677, 55678])
    expect(() => assertAcceptanceDatabase(url.replace('55683', String(port)), receipt)).toThrow();
  for (const bad of [
    undefined,
    url.replace('127.0.0.1', 'remote.invalid'),
    url.replace('_runtime', '_owner'),
    `${url}?options=unsafe`,
    url.replace('_contract', '_different'),
  ])
    expect(() => assertAcceptanceDatabase(bad, receipt)).toThrow();
  for (const bad of [
    undefined,
    'http://localhost:4483',
    'http://127.0.0.1:4471',
    'http://chai-chowk.localhost:4332',
    `${acceptanceOrigin}/other`,
  ])
    expect(() => assertAcceptanceBrowser(bad, receipt)).toThrow();
  expect(() =>
    assertAcceptanceBrowser(acceptanceOrigin, { ...receipt, stages: ['migrate'] })
  ).toThrow();
  expect(() => assertAcceptanceBrowser(acceptanceOrigin, { ...receipt, buildId: '' })).toThrow();
});
