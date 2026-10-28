import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'login-redesign.spec.ts',
  outputDir: '/tmp/login-playwright',
  timeout: 120000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4321',
    trace: 'retain-on-failure',
  },
});
