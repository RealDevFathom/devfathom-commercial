import { defineConfig, devices } from '@playwright/test';

// UX-03 (WHA-1601) visual capture lane. Untracked, disposable worktree only.
// Server is started separately (`next start` on UX03_PORT); this config never boots one.
const port = Number(process.env.UX03_PORT ?? 4353);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['ux03-*.spec.ts'],
  outputDir: './test-results/ux03',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', actionTimeout: 20_000, navigationTimeout: 45_000 },
  projects: [{ name: 'ux03', use: { ...devices['Desktop Chrome'] } }],
});
