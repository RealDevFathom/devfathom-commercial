import type { FullConfig } from '@playwright/test';
import {
  assertAcceptanceBrowser,
  assertAcceptanceDatabase,
  readAcceptanceReceipt,
} from '../../scripts/restaurant-acceptance-target';

export default function setup(config: FullConfig) {
  const receipt = readAcceptanceReceipt();
  for (const project of config.projects) assertAcceptanceBrowser(project.use.baseURL, receipt);
  assertAcceptanceDatabase(process.env.DATABASE_URL, receipt);
  if (process.env.PLAYWRIGHT_BASE_URL !== receipt.appOrigin || config.webServer)
    throw new Error('Only the runner-owned app may serve this finite queue');
}
