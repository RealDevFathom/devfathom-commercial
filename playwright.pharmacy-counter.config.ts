import { defineConfig, devices } from '@playwright/test';

import { pharmacyE2eEnvironment } from './scripts/pharmacy-e2e-environment';

const env = pharmacyE2eEnvironment();
const port = Number(process.env.PLAYWRIGHT_PORT ?? 4331);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  // The counter spec owns this lane. Every sibling spec in tests/e2e belongs to
  // a different database and host, so the glob is what keeps them out.
  testMatch: ['pharmacy-counter.spec.ts', 'time-to-first-sale.spec.ts'],
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
      AUTH_URL: process.env.PHARMACY_FIRST_SALE_TENANT_ORIGIN ?? process.env.AUTH_URL ?? baseURL,
      SHARED_APP_HOSTS: '127.0.0.1,www.localhost',
      PLATFORM_BASE_DOMAIN: 'localhost',
    },
  },
});
