import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4319);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  // Every control-plane spec belongs to its own config (admin host, disposable
  // database, serial workers); the glob keeps sibling spec files out of here too.
  // The pharmacy counter lane is the same shape — its own disposable database,
  // seed and serial worker — so it is excluded here and run by
  // `playwright.pharmacy-counter.config.ts` alone.
  // Login redesign uses its dedicated local-Postgres config and full viewport matrix.
  testIgnore: [
    'platform-control-plane*.spec.ts',
    'pharmacy-counter.spec.ts',
    'pharmacy-locale.spec.ts',
    'login-redesign.spec.ts',
  ],
  // `test-results/` holds committed visual-QA baselines, and Playwright wipes its
  // outputDir on every run — so run artifacts live outside any tracked path.
  outputDir: './playwright-artifacts/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // A cold `next dev` compiles each route on first request, which can exceed the
  // 30s default before a page is even interactive. CI runs against a production
  // build (see webServer below), but keep headroom for a slow runner.
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
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // CI has already run `bun run build` as an earlier gate, so serve that
        // artifact instead of compiling routes on demand — it is both faster and
        // closer to what staging actually runs.
        command: process.env.CI ? `bunx next start --port ${port}` : `bun run dev --port ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
