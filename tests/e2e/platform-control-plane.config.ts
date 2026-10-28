import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const requiredEnvironment = [
  'DATABASE_URL',
  'PLAYWRIGHT_DATABASE_ADMIN_URL',
  'PLAYWRIGHT_PLATFORM_ADMIN_EMAIL',
  'PLAYWRIGHT_PLATFORM_ADMIN_PASSWORD',
] as const;
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);

if (missingEnvironment.length > 0) {
  throw new Error(`Platform control-plane E2E requires: ${missingEnvironment.join(', ')}.`);
}

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4319);
// PLAYWRIGHT_BASE_URL must use the admin host: http://admin.localhost:<port>.
// PLAYWRIGHT_DATABASE_ADMIN_URL must include ?options=-c%20app.is_platform_admin%3Dtrue
// so fixture setup can access FORCE RLS platform tables.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://admin.localhost:${port}`;

// The shared, slug-free application is the same server on a second host, so the
// lane names one instead of leaving the shared-host proof skipped. `www` is a
// reserved shared label (host-routing.ts), and SHARED_APP_HOSTS below states the
// classification for the server outright rather than leaning on that rule.
// Assigned back onto the environment because this config is also loaded by each
// worker, which is where the spec reads it.
const sharedHost = process.env.PLAYWRIGHT_SHARED_HOST ?? 'www.localhost';
const sharedBaseURL = process.env.PLAYWRIGHT_SHARED_BASE_URL ?? `http://${sharedHost}:${port}`;
process.env.PLAYWRIGHT_SHARED_BASE_URL = sharedBaseURL;

export default defineConfig({
  testDir: '.',
  // Every `platform-control-plane*.spec.ts` sibling, so a lane can add a spec
  // file without editing this config and colliding with another lane doing the
  // same (WHA-1180).
  // A glob, not one filename: the control-plane scenario is now split across
  // sibling spec files so concurrent lanes can add assertions without editing
  // the same file. Every `platform-control-plane*.spec.ts` runs under this
  // config (and only this config — see `playwright.config.ts`'s testIgnore).
  testMatch: 'platform-control-plane*.spec.ts',
  // Relative to this config's directory, so this is the repository-root
  // `playwright-artifacts/` — never the tracked `test-results/` baselines.
  outputDir: '../../playwright-artifacts/platform-control-plane',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: process.env.CI ? 120_000 : 30_000,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['line']] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'platform-control-plane-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // Bind to the same authority Chromium uses so Next.js synthesizes a
        // matching x-forwarded-host instead of its default 127.0.0.1 address.
        command: process.env.CI
          ? `bunx next start --hostname admin.localhost --port ${port}`
          : `bun run dev --hostname admin.localhost --port ${port}`,
        cwd: path.resolve(__dirname, '../..'),
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          AUTH_TRUST_HOST: 'true',
          AUTH_URL: sharedBaseURL,
          DATABASE_URL: process.env.DATABASE_URL ?? '',
          SHARED_APP_HOSTS: new URL(sharedBaseURL).hostname,
          // WHA-1180 — the shared-host deployment default derives a tenant URL
          // from this base domain, and offers nothing when it is unset. Stated
          // here so the checklist's one-click action is deterministic under the
          // managed server rather than depending on the operator's shell.
          PLATFORM_BASE_DOMAIN: process.env.PLATFORM_BASE_DOMAIN ?? 'localhost',
        },
      },
});
