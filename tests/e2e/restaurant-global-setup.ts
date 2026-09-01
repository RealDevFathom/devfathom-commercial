import { chromium, type FullConfig } from '@playwright/test';

export default async function prewarmRestaurantRoutes(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (typeof baseURL !== 'string') {
    throw new Error('Restaurant integrated E2E requires a string baseURL.');
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const enrollmentRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === '/api/restaurant/terminal/establish' && request.method() === 'POST';
    });
    const response = await page.goto(new URL('/kds', baseURL).href);
    if (!response?.ok()) {
      throw new Error(`Restaurant KDS prewarm returned HTTP ${response?.status() ?? 'unknown'}.`);
    }
    await enrollmentRequest;
  } finally {
    await browser.close();
  }
}
