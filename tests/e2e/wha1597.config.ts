import { defineConfig } from '@playwright/test';

if (!process.env.WHA1597_DATABASE_URL) throw new Error('Disposable WHA1597_DATABASE_URL required');
export default defineConfig({
  testDir: '.',
  testMatch: 'wha1597.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  outputDir: process.env.PAPERCLIP_RUN_SCRATCH_DIR + '/browser',
  use: { baseURL: 'http://admin.localhost:4327', trace: 'off', screenshot: 'off' },
  webServer: {
    command: 'node_modules/.bin/next start --port 4327',
    cwd: process.cwd(),
    url: 'http://127.0.0.1:4327/platform/login',
    timeout: 60_000,
    env: {
      DATABASE_URL: process.env.WHA1597_DATABASE_URL,
      PLATFORM_MFA_ENFORCE: 'true',
      PLATFORM_ENCRYPTION_KEY: 'disposable-local-fixture-encryption-key',
      AUTH_SECRET: 'disposable-local-fixture-auth-secret',
      AUTH_TRUST_HOST: 'true',
    },
  },
});
