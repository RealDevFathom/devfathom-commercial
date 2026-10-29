import { defineConfig, devices } from '@playwright/test';

import { pharmacyE2eEnvironment } from './scripts/pharmacy-e2e-environment';

const env = pharmacyE2eEnvironment();
const port = Number(process.env.PLAYWRIGHT_PORT ?? 4331);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  // The counter spec owns this lane. Every sibling spec in tests/e2e belongs to
  // a different database and host, so the glob is what keeps them out.
  // The real-staging first-sale journey has its own fail-closed config and
  // operator evidence inputs; it must never be collected by this local DB lane.
  testMatch: 'pharmacy-counter.spec.ts',
  outputDir: './playwright-artifacts/pharmacy-counter',
  // Serial: the three bills draw from one seeded stock balance, so a parallel
  // worker would race the same lot and make a failure meaningless.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: process.env.CI ? 120_000 : 45_000,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['line']] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'pharmacy-counter-serial', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: process.env.CI
      ? `bunx next start --port ${port}`
      : `bun run dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: env.DATABASE_URL!,
      TEST_DATABASE_URL: env.TEST_DATABASE_URL!,
      PHARMACY_E2E: '1',
      AUTH_SECRET: process.env.AUTH_SECRET ?? '',
      AUTH_TRUST_HOST: 'true',
      SHARED_APP_HOSTS: '127.0.0.1',
    },
  },
});
