import { defineConfig, devices } from '@playwright/test';
import base from '../../playwright.config';
import { acceptanceOrigin } from '../../scripts/restaurant-acceptance-target';

// Listing is source-only. Runtime admission is checked by each affected suite and runner.
// Global setup validates admission only; the runner owns app startup and shutdown.
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: ['restaurant-catering.spec.ts', 'restaurant-growth.spec.ts'],
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  globalTimeout: 20 * 60_000,
  globalSetup: './restaurant-acceptance-setup.ts',
  webServer: undefined,
  outputDir: '../../task-2/acceptance-prep-20261008/browser-artifacts',
  use: {
    ...base.use,
    actionTimeout: 15_000,
    baseURL: acceptanceOrigin,
    storageState: undefined,
    // Auth/enrollment traces can contain secrets. Keep only explicit redacted evidence.
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    { name: 'restaurant-acceptance', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'affected-pos',
      use: { ...devices['Desktop Chrome'] },
      testMatch: [
        'restaurant-pos-kds.spec.ts',
        'restaurant-lifecycles-final.spec.ts',
        'restaurant-input-recovery-acceptance.spec.ts',
      ],
      grep: /shift, order, KOT|POS preserves an offline order|reloading mid-order|an add-item dropped after it committed/,
    },
  ],
});
