import { defineConfig, devices } from '@playwright/test';

if (process.env.PHARMACY_E2E !== '1')
  throw new Error('This isolated staging config requires PHARMACY_E2E=1.');

// Source collection is safe: no webServer, globalSetup, seed or database hook.
// Runtime origins and evidence are mandatory in freshPharmacyFirstSale. There is
// deliberately no default app URL. Invoke with PHARMACY_E2E=1 for the fresh lane.
export default defineConfig({
  testDir: '.',
  testMatch: 'time-to-first-sale.spec.ts',
  outputDir: process.env.PAPERCLIP_RUN_SCRATCH_DIR
    ? `${process.env.PAPERCLIP_RUN_SCRATCH_DIR}/first-sale-results`
    : './first-sale-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 300_000,
  reporter: 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    // This flow enters actual invitation tokens and credentials. Keep automated
    // traces/video/screenshots off; later visual QA has its own authorized lane.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'first-sale-chromium', use: { ...devices['Desktop Chrome'] } }],
});
