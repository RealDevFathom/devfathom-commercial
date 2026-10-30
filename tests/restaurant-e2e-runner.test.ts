import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  resolveRestaurantE2eDatabaseUrl,
  restaurantE2eEnvironment,
} from '../scripts/restaurant-e2e-database';
import config from '../playwright.restaurant-integrated.config';

const target = 'postgresql://runner:secret@127.0.0.1:55432/devfathom_restaurant_e2e';
const credentials = {
  RESTAURANT_INTEGRATED_E2E: '1',
  RESTAURANT_ACTOR_ADMIN_EMAIL: 'alex@company.com',
  RESTAURANT_ACTOR_ADMIN_PASSWORD: 'test-only',
  RESTAURANT_ACTOR_OPERATOR_EMAIL: 'operator@restaurant-e2e.test',
  RESTAURANT_ACTOR_OPERATOR_PASSWORD: 'operator-test-only',
  RESTAURANT_ACTOR_AGENCY_EMAIL: 'alex@company.com',
  RESTAURANT_ACTOR_AGENCY_PASSWORD: 'test-only',
  RESTAURANT_ACTOR_SUPER_ADMIN_EMAIL: 'platform@restaurant-e2e.test',
  RESTAURANT_ACTOR_SUPER_ADMIN_PASSWORD: 'platform-test-only',
  PLATFORM_ADMIN_EMAIL: 'platform@restaurant-e2e.test',
  PLATFORM_ADMIN_PASSWORD: 'platform-test-only',
};
const integratedSpec = readFileSync(
  resolve(process.cwd(), 'tests/e2e/restaurant-integrated.spec.ts'),
  'utf8'
);
const resilienceSpec = readFileSync(
  resolve(process.cwd(), 'tests/e2e/restaurant-pos-kds-resilience.spec.ts'),
  'utf8'
);
const coreSpec = readFileSync(
  resolve(process.cwd(), 'tests/e2e/restaurant-pos-kds.spec.ts'),
  'utf8'
);
const runner = readFileSync(resolve(process.cwd(), 'scripts/run-restaurant-e2e.ts'), 'utf8');
const globalSetup = readFileSync(
  resolve(process.cwd(), 'tests/e2e/restaurant-global-setup.ts'),
  'utf8'
);

describe('Restaurant integrated E2E safety', () => {
  test.each([undefined, '', '0', 'true'])('rejects integrated opt-in %s', (value) => {
    expect(() =>
      restaurantE2eEnvironment({
        RESTAURANT_E2E_DATABASE_URL: target,
        ...credentials,
        RESTAURANT_INTEGRATED_E2E: value,
      })
    ).toThrow('RESTAURANT_INTEGRATED_E2E=1 is required');
  });

  test('uses one canonical disposable target for seed, runtime, and Playwright', () => {
    const env = restaurantE2eEnvironment({ RESTAURANT_E2E_DATABASE_URL: target, ...credentials });
    expect(env.DATABASE_URL).toBe(new URL(target).href);
    expect(env.TEST_DATABASE_URL).toBe(env.DATABASE_URL);
    expect(env.RESTAURANT_INTEGRATED_E2E).toBe('1');
  });

  test.each([
    ['postgresql://runner:x@db.example/restaurant_e2e', 'common PostgreSQL port'],
    ['postgresql://runner:x@db.example:5432/restaurant_e2e', 'common PostgreSQL port'],
    ['postgresql://runner:x@prod.example:55432/restaurant_e2e', 'production'],
    ['postgresql://runner:x@db.example:55432/devfathom', 'disposable'],
  ])('rejects unsafe target %s', (databaseUrl, message) => {
    expect(() =>
      resolveRestaurantE2eDatabaseUrl({ RESTAURANT_E2E_DATABASE_URL: databaseUrl })
    ).toThrow(message);
  });

  test('fails closed when an existing application target differs', () => {
    expect(() =>
      resolveRestaurantE2eDatabaseUrl({
        RESTAURANT_E2E_DATABASE_URL: target,
        DATABASE_URL: 'postgresql://runner:x@127.0.0.1:55433/other_e2e',
      })
    ).toThrow('DATABASE_URL must match');
  });

  test('rejects external servers and missing integrated credentials before Playwright', () => {
    expect(() =>
      restaurantE2eEnvironment({
        RESTAURANT_E2E_DATABASE_URL: target,
        PLAYWRIGHT_BASE_URL: 'http://localhost:3000',
        ...credentials,
      })
    ).toThrow('PLAYWRIGHT_BASE_URL is forbidden');
    expect(() =>
      restaurantE2eEnvironment({
        RESTAURANT_INTEGRATED_E2E: '1',
        RESTAURANT_E2E_DATABASE_URL: target,
      })
    ).toThrow('RESTAURANT_ACTOR_ADMIN_EMAIL is required');
    expect(() =>
      restaurantE2eEnvironment({
        RESTAURANT_E2E_DATABASE_URL: target,
        RESTAURANT_INTEGRATED_E2E: '1',
        RESTAURANT_ACTOR_ADMIN_EMAIL: credentials.RESTAURANT_ACTOR_ADMIN_EMAIL,
      })
    ).toThrow('RESTAURANT_ACTOR_ADMIN_PASSWORD is required');
    expect(() =>
      restaurantE2eEnvironment({
        RESTAURANT_E2E_DATABASE_URL: target,
        ...credentials,
        RESTAURANT_ACTOR_OPERATOR_PASSWORD: undefined,
      })
    ).toThrow('RESTAURANT_ACTOR_OPERATOR_PASSWORD is required');
    expect(() =>
      restaurantE2eEnvironment({
        RESTAURANT_E2E_DATABASE_URL: target,
        ...credentials,
        RESTAURANT_ACTOR_OPERATOR_EMAIL: 'different@restaurant-e2e.test',
      })
    ).toThrow('RESTAURANT_ACTOR_OPERATOR_EMAIL must be operator@restaurant-e2e.test');
  });

  // WHA-1542 — the seed mirrors alex@company.com and copies the hash prisma/seed.ts
  // wrote under SEED_PASSWORD. Any other address or password authenticates against
  // no row at all, and NextAuth reports that as an ordinary credential rejection.
  test('refuses an administrator identity the Restaurant E2E seed never writes', () => {
    expect(() =>
      restaurantE2eEnvironment({
        RESTAURANT_E2E_DATABASE_URL: target,
        ...credentials,
        RESTAURANT_ACTOR_ADMIN_EMAIL: 'admin@restaurant-e2e.test',
      })
    ).toThrow('RESTAURANT_ACTOR_ADMIN_EMAIL must be alex@company.com');
  });

  test('refuses an administrator password that cannot match the seeded hash', () => {
    expect(() =>
      restaurantE2eEnvironment({
        RESTAURANT_E2E_DATABASE_URL: target,
        ...credentials,
        SEED_PASSWORD: 'a-different-seed-password',
      })
    ).toThrow('RESTAURANT_ACTOR_ADMIN_PASSWORD must equal SEED_PASSWORD');

    expect(
      restaurantE2eEnvironment({
        RESTAURANT_E2E_DATABASE_URL: target,
        ...credentials,
        SEED_PASSWORD: credentials.RESTAURANT_ACTOR_ADMIN_PASSWORD,
      }).RESTAURANT_ACTOR_ADMIN_PASSWORD
    ).toBe(credentials.RESTAURANT_ACTOR_ADMIN_PASSWORD);
  });

  test('passes only the actor credentials used by the integrated matrix', () => {
    const env = restaurantE2eEnvironment({
      RESTAURANT_E2E_DATABASE_URL: target,
      ...credentials,
      RESTAURANT_ACTOR_FUTURE_EMAIL: 'future@example.test',
      RESTAURANT_ACTOR_FUTURE_PASSWORD: 'unused',
    });
    expect(env.RESTAURANT_ACTOR_ADMIN_EMAIL).toBe(credentials.RESTAURANT_ACTOR_ADMIN_EMAIL);
    expect(env.RESTAURANT_ACTOR_OPERATOR_EMAIL).toBe(credentials.RESTAURANT_ACTOR_OPERATOR_EMAIL);
    expect(env.RESTAURANT_ACTOR_OPERATOR_PASSWORD).toBe(
      credentials.RESTAURANT_ACTOR_OPERATOR_PASSWORD
    );
    expect(env.RESTAURANT_ACTOR_AGENCY_EMAIL).toBe(credentials.RESTAURANT_ACTOR_AGENCY_EMAIL);
    expect(env.RESTAURANT_ACTOR_AGENCY_PASSWORD).toBe(credentials.RESTAURANT_ACTOR_AGENCY_PASSWORD);
    expect(env.RESTAURANT_ACTOR_SUPER_ADMIN_EMAIL).toBe(
      credentials.RESTAURANT_ACTOR_SUPER_ADMIN_EMAIL
    );
    expect(env.RESTAURANT_ACTOR_SUPER_ADMIN_PASSWORD).toBe(
      credentials.RESTAURANT_ACTOR_SUPER_ADMIN_PASSWORD
    );
    expect(env.RESTAURANT_ACTOR_FUTURE_EMAIL).toBeUndefined();
    expect(env.RESTAURANT_ACTOR_FUTURE_PASSWORD).toBeUndefined();
  });

  test.each([
    'RESTAURANT_ACTOR_AGENCY_EMAIL',
    'RESTAURANT_ACTOR_AGENCY_PASSWORD',
    'RESTAURANT_ACTOR_SUPER_ADMIN_EMAIL',
    'RESTAURANT_ACTOR_SUPER_ADMIN_PASSWORD',
    'PLATFORM_ADMIN_EMAIL',
    'PLATFORM_ADMIN_PASSWORD',
  ])('rejects missing actor seed input %s', (name) => {
    expect(() =>
      restaurantE2eEnvironment({
        RESTAURANT_E2E_DATABASE_URL: target,
        ...credentials,
        [name]: undefined,
      })
    ).toThrow();
  });

  test.each([
    ['RESTAURANT_ACTOR_AGENCY_EMAIL', 'unseeded@example.test'],
    ['RESTAURANT_ACTOR_AGENCY_PASSWORD', 'wrong-password'],
    ['RESTAURANT_ACTOR_SUPER_ADMIN_EMAIL', 'unseeded@example.test'],
    ['RESTAURANT_ACTOR_SUPER_ADMIN_PASSWORD', 'wrong-password'],
  ])('rejects mismatched actor seed input %s', (name, value) => {
    expect(() =>
      restaurantE2eEnvironment({
        RESTAURANT_E2E_DATABASE_URL: target,
        ...credentials,
        [name]: value,
      })
    ).toThrow();
  });

  test('has one desktop project, one worker, and no parallel fan-out', () => {
    expect(config.outputDir).toBe('test-results/restaurant-integrated');
    expect(config.fullyParallel).toBe(false);
    expect(config.retries).toBe(0);
    expect(config.workers).toBe(1);
    expect(config.projects).toHaveLength(1);
    expect(config.projects?.[0]?.name).toBe('restaurant-integrated-serial');
    expect(config.globalSetup).toBe('./tests/e2e/restaurant-global-setup.ts');
    expect(config.webServer).toMatchObject({
      command: 'bunx next start --port 4319',
      reuseExistingServer: false,
      env: { AUTH_TRUST_HOST: 'true' },
    });
  });

  test('builds once and proves the KDS client can begin enrollment before the suite', () => {
    expect(runner).toContain("['bun', ['run', 'build']]");
    expect(globalSetup).toContain("new URL('/kds', baseURL).href");
    expect(globalSetup).toContain("url.pathname === '/api/restaurant/terminal/establish'");
    expect(globalSetup).toContain("request.method() === 'POST'");
    expect(globalSetup).toContain('response?.ok()');
  });

  test('reuses one login and isolates resilience orders from the core table flow', () => {
    expect(integratedSpec.match(/signInAs\(page, 'restaurantAdmin'\)/g)).toHaveLength(1);

    const createAndFireOrder = resilienceSpec.match(
      /async function createAndFireOrder[\s\S]*?\n}\n\ntest\.describe/
    )?.[0];
    expect(createAndFireOrder).toContain("selectOption('TAKEAWAY')");
    expect(createAndFireOrder).toContain("endsWith('/api/restaurant/orders/open')");
    expect(createAndFireOrder).toContain('Order ${opened.orderNumber} opened.');
    expect(createAndFireOrder).not.toContain("getByRole('checkbox')");
  });

  test('synchronizes the core flow on fixture-backed menu and active-order state', () => {
    expect(coreSpec).toContain('new RegExp(fixture.menuItem.name)');
    expect(coreSpec).toContain('Order ${opened.orderNumber} opened.');
    expect(coreSpec).not.toContain('E2E Menu loaded.');
    expect(coreSpec).not.toMatch(/Order \\d\+ opened/);
  });
});
