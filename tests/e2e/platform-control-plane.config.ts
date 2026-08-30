import { defineConfig, devices } from '@playwright/test';

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
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'platform-control-plane.spec.ts',
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
        command: process.env.CI ? `bunx next start --port ${port}` : `bun run dev --port ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
