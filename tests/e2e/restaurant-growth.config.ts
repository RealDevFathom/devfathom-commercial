import { defineConfig } from '@playwright/test';
import acceptance from './restaurant-acceptance.config';
// Same admitted app/ordinary sign-in contract as composed acceptance. No stored session.
export default defineConfig({
  ...acceptance,
  testMatch: 'restaurant-growth.spec.ts',
  projects: [{ name: 'restaurant-growth', use: acceptance.use }],
});
