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
      AUTH_SECRET: process.env.AUTH_SECRET ?? '',
      AUTH_TRUST_HOST: 'true',
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      RESTAURANT_INTEGRATED_E2E: '1',
      // Opt in only for this test server; production runtime throttles stay active.
      NODE_ENV: 'test',
      RESTAURANT_E2E_RELAX_TERMINAL_FLOOD_LIMITS: '1',
    },
  },
  // An EXACT per-file list, not a glob: a spec that is not named here registers
  // zero cases in the only lane that sets RESTAURANT_INTEGRATED_E2E=1.
  testMatch: [
    'restaurant-controls-final.spec.ts',
    'restaurant-catering.spec.ts',
    'restaurant-integrated.spec.ts',
    'restaurant-insights-completion.spec.ts',
    'restaurant-lifecycles-final.spec.ts',
    'restaurant-pos-kds.spec.ts',
    'restaurant-pos-kds-resilience.spec.ts',
    'restaurant-delivery.spec.ts',
    'time-to-first-sale.spec.ts',
    // WHA-1542 — the eight authored acceptance specs, registered so they collect.
    'restaurant-foh-lifecycle-acceptance.spec.ts',
    'restaurant-admin-lifecycle-acceptance.spec.ts',
    'restaurant-backoffice-lifecycle-acceptance.spec.ts',
    'restaurant-input-recovery-acceptance.spec.ts',
    'restaurant-catering-lifecycle-acceptance.spec.ts',
    'restaurant-recipe-profitability-acceptance.spec.ts',
    'restaurant-operations-lifecycle-acceptance.spec.ts',
    'restaurant-software-receipt-acceptance.spec.ts',
    // WHA-1564 — financial comparison + export acceptance.
    'restaurant-financial-comparison-export.spec.ts',
    'restaurant-actor-accessibility.spec.ts',
    'restaurant-pos-kds-accessibility.spec.ts',
    'restaurant-focus-visible.spec.ts',
  ],
  ...(process.env.RESTAURANT_E2E_SPEC_FILE
    ? { testMatch: [process.env.RESTAURANT_E2E_SPEC_FILE] }
    : {}),
  projects: [
    {
      name: 'restaurant-integrated-serial',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
