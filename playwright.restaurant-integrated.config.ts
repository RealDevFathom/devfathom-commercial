import { defineConfig, devices } from '@playwright/test';

import base from './playwright.config';

if (process.env.PLAYWRIGHT_BASE_URL) {
  throw new Error('PLAYWRIGHT_BASE_URL is forbidden for the integrated Restaurant E2E lane.');
}

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4319);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  ...base,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  outputDir: 'test-results/restaurant-integrated',
  globalSetup: './tests/e2e/restaurant-global-setup.ts',
  use: { ...base.use, baseURL },
  webServer: {
    command: `bunx next start --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      AUTH_TRUST_HOST: 'true',
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      RESTAURANT_INTEGRATED_E2E: '1',
    },
  },
  testMatch: [
    'restaurant-integrated.spec.ts',
    'restaurant-pos-kds.spec.ts',
    'restaurant-pos-kds-resilience.spec.ts',
    'restaurant-delivery.spec.ts',
  ],
  projects: [
    {
      name: 'restaurant-integrated-serial',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
