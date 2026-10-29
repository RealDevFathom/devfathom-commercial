import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'login-redesign.spec.ts',
  outputDir: '/tmp/login-playwright',
  timeout: 300000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://app.localhost:4321',
    trace: 'retain-on-failure',
  },
});
