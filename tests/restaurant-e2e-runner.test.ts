import { describe, expect, test } from 'vitest';

import {
  resolveRestaurantE2eDatabaseUrl,
  restaurantE2eEnvironment,
} from '../scripts/restaurant-e2e-database';
import config from '../playwright.restaurant-integrated.config';

const target = 'postgresql://runner:secret@127.0.0.1:55432/devfathom_restaurant_e2e';

describe('Restaurant integrated E2E safety', () => {
  test('uses one canonical disposable target for seed, runtime, and Playwright', () => {
    const env = restaurantE2eEnvironment({ RESTAURANT_E2E_DATABASE_URL: target });
    expect(env.DATABASE_URL).toBe(new URL(target).href);
    expect(env.TEST_DATABASE_URL).toBe(env.DATABASE_URL);
  });

  test.each([
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

  test('has one desktop project, one worker, and no parallel fan-out', () => {
    expect(config.fullyParallel).toBe(false);
    expect(config.workers).toBe(1);
    expect(config.projects).toHaveLength(1);
    expect(config.projects?.[0]?.name).toBe('restaurant-integrated-serial');
  });
});
