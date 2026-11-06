import { defineConfig } from '@playwright/test';
import counter from './playwright.pharmacy-counter.config';

// Use a separately seeded disposable database: the counter lane closes its day
// and asserts the untouched fixture stock. These locale bills must not share it.
export default defineConfig({
  ...counter,
  testMatch: ['pharmacy-locale.spec.ts'],
  outputDir: './playwright-artifacts/pharmacy-locale',
});
