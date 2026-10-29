import { defineConfig, devices } from '@playwright/test';

import { agencyE2eEnvironment } from './scripts/agency-e2e-environment';

const env = agencyE2eEnvironment();
const port = Number(process.env.PLAYWRIGHT_PORT ?? 4327);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/agency-e2e',
  testMatch: 'agency-acceptance.spec.ts',
  // Keep run artifacts out of the tracked `test-results/` visual-QA baselines.
  outputDir: './playwright-artifacts/agency',
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
  projects: [{ name: 'agency-acceptance-serial', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: process.env.CI ? `bunx next start --port ${port}` : `bun run dev --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      AUTH_SECRET: process.env.AUTH_SECRET ?? '',
      DATABASE_URL: env.DATABASE_URL!,
      TEST_DATABASE_URL: env.TEST_DATABASE_URL!,
      AGENCY_E2E: '1',
      AUTH_TRUST_HOST: 'true',
      SHARED_APP_HOSTS: '127.0.0.1',
    },
  },
});
