import { defineConfig, devices } from '@playwright/test';

import { resolveRestaurantE2eDatabaseUrl } from './scripts/restaurant-e2e-database';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

function requiredUrl(
  name: 'DATABASE_URL' | 'PLAYWRIGHT_BASE_URL' | 'RUNTIME_DATABASE_URL' | 'TEST_DATABASE_URL'
) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the restaurant sales demo E2E.`);
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

const databaseUrl = resolveRestaurantE2eDatabaseUrl(process.env);
const database = new URL(databaseUrl);
if (!LOOPBACK_HOSTS.has(database.hostname)) {
  throw new Error('RESTAURANT_E2E_DATABASE_URL must target a loopback PostgreSQL server.');
}

const appDatabase = requiredUrl('DATABASE_URL');
const runtimeDatabase = requiredUrl('RUNTIME_DATABASE_URL');
const testDatabase = requiredUrl('TEST_DATABASE_URL');
for (const [name, candidate] of [
  ['DATABASE_URL', appDatabase],
  ['RUNTIME_DATABASE_URL', runtimeDatabase],
  ['TEST_DATABASE_URL', testDatabase],
] as const) {
  if (candidate.href !== databaseUrl) {
    throw new Error(`${name} must match RESTAURANT_E2E_DATABASE_URL exactly.`);
  }
}

const runtimeRole = process.env.RUNTIME_ROLE?.trim();
if (!runtimeRole || !/^restaurant_qa_runtime_[a-z0-9]+$/i.test(runtimeRole)) {
  throw new Error('RUNTIME_ROLE must name the disposable restaurant_qa_runtime_* role.');
}
if (decodeURIComponent(runtimeDatabase.username) !== runtimeRole) {
  throw new Error('RUNTIME_DATABASE_URL must authenticate as RUNTIME_ROLE.');
}

const appUrl = requiredUrl('PLAYWRIGHT_BASE_URL');
if (!['http:', 'https:'].includes(appUrl.protocol) || !LOOPBACK_HOSTS.has(appUrl.hostname)) {
  throw new Error('PLAYWRIGHT_BASE_URL must be an HTTP(S) loopback URL.');
}
if (appUrl.username || appUrl.password) {
  throw new Error('PLAYWRIGHT_BASE_URL must not contain credentials.');
}

// Runner-input validation cannot prove which DATABASE_URL an already-running app inherited.
// Root must start it with DATABASE_URL=$RUNTIME_DATABASE_URL, then verify the app connection's
// current_database() and current_user before browser execution.
const baseURL = appUrl.href;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'restaurant-sales-demo.spec.ts',
  outputDir: './playwright-artifacts/restaurant-sales-demo',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
