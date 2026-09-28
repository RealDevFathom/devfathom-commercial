import { defineConfig, devices } from '@playwright/test';

import base from './playwright.config';

/**
 * WHA-1603 — the INV-07 two-branch transfers acceptance lane.
 *
 * Same shape as the PH-PUR lane: its own seed and disposable database, one
 * serial worker, a tenant host rather than the loopback default organization,
 * and a production standalone build (Server Functions under `next dev` compile
 * per route and read as timeouts). Run order:
 *
 *   DATABASE_URL=<owner url> bunx tsx tests/e2e/pharmacy-transfers-seed.ts
 *   bun run build && cp -R .next/static .next/standalone/.next/static && cp -R public .next/standalone/public
 *   PHARMACY_TRANSFERS_DATABASE_URL=<runtime url> AUTH_SECRET=… \
 *     bunx playwright test --config playwright.pharmacy-transfers.config.ts
 *
 * The web server runs as the runtime role (NOSUPERUSER NOBYPASSRLS), the same
 * URL the spec uses to read the ledger back under the tenant GUC.
 */
const port = Number(process.env.PLAYWRIGHT_PORT ?? 4397);
const baseURL = process.env.PHARMACY_TRANSFERS_BASE_URL ?? `http://ph-xfer-e2e.localhost:${port}`;

export default defineConfig({
  ...base,
  testDir: './tests/e2e',
  testMatch: ['pharmacy-transfers.spec.ts'],
  testIgnore: undefined,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Six Server Function round-trips, each re-rendering a surface that reloads
  // its picker set, across two signed-in people.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  outputDir: './playwright-artifacts/pharmacy-transfers',
  globalSetup: './tests/e2e/pharmacy-transfers-global-setup.ts',
  use: { ...base.use, baseURL },
  projects: [{ name: 'pharmacy-transfers-serial', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.PHARMACY_TRANSFERS_BASE_URL
    ? undefined
    : {
        command: `node .next/standalone/server.js`,
        url: `http://127.0.0.1:${port}/login`,
        reuseExistingServer: false,
        timeout: 180_000,
        env: {
          AUTH_SECRET: process.env.AUTH_SECRET ?? '',
          AUTH_TRUST_HOST: 'true',
          DATABASE_URL: process.env.PHARMACY_TRANSFERS_DATABASE_URL ?? '',
          PLATFORM_BASE_DOMAIN: process.env.PLATFORM_BASE_DOMAIN ?? 'localhost',
          HOSTNAME: '127.0.0.1',
          PORT: String(port),
        },
      },
});
