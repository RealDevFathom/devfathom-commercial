import { expect, test } from '@playwright/test';

import { signInAs } from './fixtures/restaurant-actor-accessibility';
import { assertKeyboardFocusWalk, focusThemes, useFocusTheme } from './helpers/focus-visible';
import {
  installSeededTerminalCookie,
  restaurantE2eCredentials,
  terminalBrowserBaseUrl,
} from './restaurant-fixture';

test.describe.configure({ mode: 'serial' });

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}

const backOfficeRoutes = [
  '/restaurant/catalog',
  '/restaurant/integrations/cameras',
  '/restaurant/inventory',
  '/restaurant/menu-import',
  '/restaurant/menus',
  '/terminal',
] as const;

test('all affected restaurant screens retain logical, visible keyboard focus in both themes', async ({
  page,
}, testInfo) => {
  test.slow();
  const origin = await signInAs(page, 'restaurantAdmin');

  for (const theme of focusThemes) {
    for (const route of backOfficeRoutes) {
      await page.goto(new URL(route, origin).href);
      await expect(page.getByRole('main')).toBeVisible();
      await useFocusTheme(page, theme);
      await assertKeyboardFocusWalk(page, `${route}-${theme}`, testInfo);
    }
  }
});

for (const [route, device] of [
  ['/pos', restaurantE2eCredentials.pos],
  ['/kds', restaurantE2eCredentials.kds],
] as const) {
  test(
    `${route} retains logical, visible keyboard focus in both themes`,
    async ({ page }, testInfo) => {
      test.slow();
      const origin = terminalBrowserBaseUrl();
      await installSeededTerminalCookie(page.context(), device, origin);

      for (const theme of focusThemes) {
        await page.goto(new URL(route, origin).href);
        await expect(page.getByRole('main')).toBeVisible();
        await useFocusTheme(page, theme);
        await assertKeyboardFocusWalk(page, `${route}-${theme}`, testInfo);
      }
    }
  );
}
