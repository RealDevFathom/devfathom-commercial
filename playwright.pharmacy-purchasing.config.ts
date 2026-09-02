import { defineConfig, devices } from '@playwright/test';

import base from './playwright.config';
import { STORAGE_STATE } from './tests/e2e/pharmacy-purchasing-global-setup';

/**
 * WHA-1196 — the PH-PUR browser acceptance lane (PRD §6.3 PUR-01..06).
 *
 * Its own config for the same reasons the restaurant integrated lane has one:
 * the spec walks a single seeded purchase order from end to end, so it has to
 * run serially in one worker, and it needs a tenant host rather than the
 * default-organization loopback — `resolveTenantActor` reads the workspace from
 * the host, and `127.0.0.1` resolves to whatever DEFAULT_ORGANIZATION_ID names.
 *
 * `PHARMACY_PURCHASING_BASE_URL` must therefore be the seeded organization's
 * tenant host (`http://ph-pur-e2e.localhost:<port>` locally, since Chromium maps
 * every `*.localhost` label to loopback without a hosts-file entry). The
 * webServer readiness probe stays on the loopback address because Node's fetch
 * does not share Chromium's `*.localhost` mapping.
 */
const port = Number(process.env.PLAYWRIGHT_PORT ?? 4396);
const baseURL =
  process.env.PHARMACY_PURCHASING_BASE_URL ?? `http://ph-pur-e2e.localhost:${port}`;

export default defineConfig({
  ...base,
  testDir: './tests/e2e',
  testMatch: ['pharmacy-purchasing.spec.ts'],
  testIgnore: undefined,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The walk files a receipt, posts it into the ledger, resolves an exception
  // and reads the resulting lots back — four Server Functions, each of which
  // redirects and re-renders a surface that reloads its whole picker set. The
  // default 30s covers a page load, not a four-mutation transaction chain.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  outputDir: './playwright-artifacts/pharmacy-purchasing',
  globalSetup: './tests/e2e/pharmacy-purchasing-global-setup.ts',
  use: { ...base.use, baseURL, storageState: STORAGE_STATE },
  projects: [
    {
      name: 'pharmacy-purchasing-serial',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.PHARMACY_PURCHASING_BASE_URL
    ? undefined
    : {
        // A production build, not `next dev`: the surfaces are Server
        // Components with inline Server Functions, and the dev server's
        // per-route compilation makes the first submission of every form look
        // like a timeout rather than a result.
        //
        // `next start` refuses to serve an `output: 'standalone'` build, so the
        // standalone entrypoint is used directly. It does not carry `.next/static`
        // or `public/`, which have to be copied in after `bun run build`:
        //   cp -R .next/static .next/standalone/.next/static
        //   cp -R public .next/standalone/public
        command: `node .next/standalone/server.js`,
        url: `http://127.0.0.1:${port}/login`,
        reuseExistingServer: false,
        timeout: 180_000,
        env: {
          AUTH_SECRET: process.env.AUTH_SECRET ?? '',
          AUTH_TRUST_HOST: 'true',
          DATABASE_URL: process.env.DATABASE_URL ?? '',
          PLATFORM_BASE_DOMAIN: process.env.PLATFORM_BASE_DOMAIN ?? 'localhost',
          HOSTNAME: '127.0.0.1',
          PORT: String(port),
        },
      },
});
