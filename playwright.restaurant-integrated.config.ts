import { defineConfig, devices } from '@playwright/test';

import base from './playwright.config';

export default defineConfig({
  ...base,
  fullyParallel: false,
  workers: 1,
  testMatch: [
    'restaurant-integrated.spec.ts',
    'restaurant-pos-kds.spec.ts',
    'restaurant-pos-kds-resilience.spec.ts',
  ],
  projects: [
    {
      name: 'restaurant-integrated-serial',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
