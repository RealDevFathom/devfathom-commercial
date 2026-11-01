import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  assertTerminalSecretIsBrowserIsolated,
  installSeededTerminalCookie,
  restaurantE2eCredentials as fixture,
} from './restaurant-fixture';

const OUTPUT =
  process.env.RESTAURANT_QA_EVIDENCE_DIR ?? path.join('test-results', 'visual-qa', 'm9');
const VIEWPORTS = [
  { name: '375-portrait', width: 375, height: 812 },
  { name: '768-tablet', width: 768, height: 1024 },
  { name: '1024-laptop', width: 1024, height: 768 },
  { name: '1440-desktop', width: 1440, height: 900 },
] as const;
const THEMES = ['light', 'dark'] as const;

const menu = {
  version: 'version-publication-1',
  branchId: 'branch-1',
  channel: 'DINE_IN',
  publicationId: 'publication-1',
  channelOpen: true,
  menu: { id: 'menu-1', name: 'Dinner service' },
  sections: [
    {
      id: 'mains',
      name: 'Mains',
      sortOrder: 1,
      items: [
        {
          id: 'item-1',
          productId: 'product-1',
          variantId: null,
          displayName: 'Charred cauliflower',
          product: { name: 'Cauliflower' },
          price: '18.00',
          priceSource: 'BASE_LIST',
          sortOrder: 1,
          available: true,
          modifierGroups: [],
        },
        {
          id: 'item-2',
          productId: 'product-2',
          variantId: null,
          displayName: 'Sold out ravioli',
          product: { name: 'Ravioli' },
          price: '22.00',
          priceSource: 'BASE_LIST',
          sortOrder: 2,
          available: false,
          modifierGroups: [],
        },
      ],
    },
  ],
};

const order = {
  id: 'order-1',
  orderNumber: 1042,
  status: 'OPEN',
  channel: 'DINE_IN',
  publicationId: 'publication-1',
  coverCount: 2,
  items: [
    {
      id: 'order-item-1',
      course: 1,
      seatNumber: 1,
      name: 'Charred cauliflower',
      unitPrice: '18.00',
      quantity: 1,
      status: 'FIRING',
      modifiers: [],
    },
  ],
  tables: [{ id: 'assignment-1', tableId: 'T12', active: true }],
  totals: { subtotal: '18.00', tax: '1.80', serviceCharge: '0.00' },
};

const queue = {
  stationId: 'hot-line',
  businessDate: '2026-08-28',
  cursor: 7,
  gap: false,
  hasMore: false,
  displayMapping: {},
  tickets: [
    {
      ticketId: 'ticket-1',
      ticketNumber: 17,
      orderId: 'order-1',
      orderNumber: 1042,
      createdAt: '2026-08-28T04:00:00.000Z',
      displayStatus: 'NEW',
      items: [
        {
          orderItemId: 'order-item-1',
          name: 'Charred cauliflower',
          modifierNames: [],
          course: 1,
          seatNumber: 1,
          quantity: 1,
          itemStatus: 'QUEUED',
          displayStatus: 'NEW',
        },
      ],
    },
  ],
};

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockPos(page: Page, failure?: { status: number; error: string }) {
  await page.route('**/api/restaurant/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (failure) return json(route, { error: failure.error }, failure.status);
    if (pathname.endsWith('/terminal/establish')) {
      return json(
        route,
        {
          sessionToken: 'session-token',
          session: { id: 'session-1', state: 'LOCKED', establishedAt: '2026-08-28T04:00:00Z' },
          device: {
            id: 'device-1',
            organizationId: 'organization-1',
            branchId: 'branch-1',
            name: 'Front register',
            branchName: 'Gulberg Café',
          },
        },
        201
      );
    }
    if (pathname.endsWith('/terminal/layout')) return json(route, { floors: [], sections: [] });
    if (pathname.endsWith('/terminal/operators')) {
      return json(route, {
        operators: [
          {
            staffProfileId: 'operator-1',
            displayName: 'Amina Khan',
            role: 'Operator',
            canApprove: false,
          },
        ],
      });
    }
    if (pathname.endsWith('/terminal/unlock')) {
      return json(route, {
        session: { id: 'session-1', state: 'UNLOCKED', activeStaffProfileId: 'operator-1' },
      });
    }
    if (pathname.endsWith('/orders/effective-menu')) return json(route, menu);
    if (pathname.endsWith('/orders/open-orders')) {
      return json(route, {
        orders: [
          {
            id: 'order-1',
            orderNumber: 1042,
            status: 'OPEN',
            channel: 'DINE_IN',
            activeTableIds: ['T12'],
            itemCount: 1,
            subtotal: '18.00',
          },
        ],
      });
    }
    if (pathname.endsWith('/orders/detail')) return json(route, order);
    return json(route, {});
  });
}

async function unlockPos(page: Page) {
  await installSeededTerminalCookie(page.context(), fixture.pos);
  await page.goto('/pos');
  await page.getByLabel('Operator', { exact: true }).selectOption('operator-1');
  await fillHydratedForm(page, [['Operator PIN', '4242']], 'Unlock terminal');
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
  await assertTerminalSecretIsBrowserIsolated(page, fixture.pos.secret);
}

async function mockKds(page: Page, response: typeof queue | { error: string }, status = 200) {
  await page.route('**/api/restaurant/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/terminal/establish')) {
      return json(
        route,
        {
          sessionToken: 'kds-session-token',
          session: { id: 'kds-session-1', state: 'LOCKED' },
          device: {
            id: 'kds-device-1',
            name: 'Expo display',
            branchName: 'Gulberg Café',
            kind: 'KDS',
          },
        },
        201
      );
    }
    if (pathname.endsWith('/terminal/operators')) {
      return json(route, {
        operators: [
          {
            staffProfileId: 'operator-1',
            displayName: 'Amina Khan',
            role: 'Operator',
            canApprove: false,
          },
        ],
      });
    }
    if (pathname.endsWith('/terminal/unlock')) {
      return json(route, {
        session: { id: 'kds-session-1', state: 'UNLOCKED', activeStaffProfileId: 'operator-1' },
      });
    }
    if (pathname.endsWith('/kds/delivery/queue')) {
      return json(route, { serverTime: '2026-08-28T04:00:00.000Z', deliveries: [] });
    }
    return json(route, {});
  });
  await page.route('**/api/restaurant/kds/queue**', (route) => json(route, response, status));
}

async function connectKds(page: Page) {
  await installSeededTerminalCookie(page.context(), fixture.kds);
  await page.goto('/kds');
  await page.getByLabel('Acting operator').selectOption('operator-1');
  await fillHydratedForm(page, [['Operator PIN', '4242']], 'Verify PIN and unlock');
  await expect(page.getByRole('heading', { name: 'Kitchen floor' })).toBeVisible();
  await assertTerminalSecretIsBrowserIsolated(page, fixture.kds.secret);
}

async function fillHydratedForm(
  page: Page,
  fields: ReadonlyArray<readonly [string, string]>,
  submitName: string
) {
  const submit = page.getByRole('button', { name: submitName });
  await expect
    .poll(
      async () => {
        for (const [label, value] of fields)
          await page.getByLabel(label, { exact: true }).fill(value);
        return submit.isEnabled();
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  await submit.click();
}

async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((value) => {
    localStorage.setItem('theme', value);
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
  }, theme);
}

async function assertAxe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

async function assertLayoutAndTargets(page: Page) {
  const metrics = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    smallTargets: [...document.querySelectorAll<HTMLElement>('button, input, select, a[href]')]
      .filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        // Visually clipped (sr-only) controls, e.g. an unfocused skip link, are not pointer targets.
        const clipped =
          style.clipPath === 'inset(50%)' || style.clip === 'rect(0px, 0px, 0px, 0px)';
        return (
          !clipped &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          box.width > 0 &&
          box.height > 0
        );
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.id,
          width: box.width,
          height: box.height,
        };
      })
      .filter(({ width, height }) => width < 44 || height < 44),
  }));
  expect(metrics.overflow, 'document-level horizontal overflow').toBeLessThanOrEqual(1);
  expect(metrics.smallTargets, JSON.stringify(metrics.smallTargets)).toEqual([]);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
}

function collectRuntimeErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

test.beforeAll(async () => mkdir(OUTPUT, { recursive: true }));

test('POS and KDS default, labels, disabled controls, focus, and axe WCAG 2.2 AA', async ({
  browser,
  baseURL,
}) => {
  const posContext = await browser.newContext({ baseURL });
  await installSeededTerminalCookie(posContext, fixture.pos);
  const pos = await posContext.newPage();
  await mockPos(pos);
  await pos.goto('/pos');
  await expect(pos.getByRole('button', { name: 'Unlock terminal' })).toBeDisabled();
  await expect(pos.getByLabel('Operator', { exact: true })).toBeVisible();
  await pos.keyboard.press('Tab');
  await expect(pos.locator(':focus')).toBeVisible();
  await assertAxe(pos);

  const kdsContext = await browser.newContext({ baseURL });
  await installSeededTerminalCookie(kdsContext, fixture.kds);
  const kds = await kdsContext.newPage();
  await mockKds(kds, queue);
  await kds.goto('/kds');
  await expect(kds.getByRole('button', { name: 'Verify PIN and unlock' })).toBeDisabled();
  await expect(kds.getByLabel('Acting operator')).toBeVisible();
  await assertAxe(kds);
  await posContext.close();
  await kdsContext.close();
});

test('active POS covers empty, disabled, destructive dialog, keyboard, and live regions', async ({
  page,
}) => {
  const errors = collectRuntimeErrors(page);
  await mockPos(page);
  await unlockPos(page);
  await expect(
    page.getByRole('status').filter({ hasText: 'Dinner service loaded.' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Sold out ravioli/ })).toBeDisabled();
  await page.getByRole('button', { name: /#1042/ }).click();
  await page.getByRole('button', { name: 'Void Charred cauliflower' }).click();
  await expect(page.getByRole('dialog', { name: 'Void Charred cauliflower' })).toBeVisible();
  await expect(page.getByLabel('Void reason')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await assertAxe(page);
  expect(errors).toEqual([]);
});

test('POS permission-denied and revoked states are announced', async ({ page }) => {
  await mockPos(page, { status: 403, error: 'Permission denied for this terminal.' });
  await installSeededTerminalCookie(page.context(), fixture.pos);
  await page.goto('/pos');
  await expect(page.getByRole('alert').filter({ hasText: 'Permission denied' })).toBeVisible();

  await page.unroute('**/api/restaurant/**');
  await mockPos(page, { status: 403, error: 'This device has been revoked.' });
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Device revoked' })).toBeVisible();
});

test('KDS loading, empty, error, permission/revoked, disabled action, and live regions', async ({
  page,
}) => {
  let release: (() => void) | undefined;
  await mockKds(page, queue);
  await page.route('**/api/restaurant/kds/queue**', async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await json(route, { ...queue, tickets: [] });
  });
  await connectKds(page);
  await expect(page.getByLabel('Loading kitchen queue')).toBeVisible();
  release?.();
  await expect(
    page.getByText('Queue clear. No open kitchen tickets for this station.')
  ).toBeVisible();

  await page.unroute('**/api/restaurant/kds/queue**');
  await mockKds(page, { error: 'Kitchen queue unavailable.' }, 500);
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await connectKds(page);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Kitchen queue unavailable' })
  ).toBeVisible();

  await page.unroute('**/api/restaurant/kds/queue**');
  await mockKds(page, { error: 'Device revoked.' }, 403);
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await connectKds(page);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Device authorization failed' })
  ).toBeVisible();
});

for (const surface of ['pos', 'kds'] as const) {
  test(`${surface.toUpperCase()} four-viewports × two-themes matrix, reduced motion, console, and screenshots`, async ({
    page,
  }) => {
    test.slow();
    const errors = collectRuntimeErrors(page);
    if (surface === 'pos') {
      await mockPos(page);
      await unlockPos(page);
    } else {
      await mockKds(page, queue);
      await connectKds(page);
      await expect(page.getByText('Charred cauliflower')).toBeVisible();
    }

    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion });
      for (const theme of THEMES) {
        for (const viewport of VIEWPORTS) {
          await setTheme(page, theme);
          await page.setViewportSize(viewport);
          await assertLayoutAndTargets(page);
          await page.screenshot({
            path: path.join(
              OUTPUT,
              `${surface}-${theme}-${viewport.name}-${reducedMotion === 'reduce' ? 'reduced-motion' : 'normal-motion'}.png`
            ),
            fullPage: true,
          });
        }
      }
    }
    await assertAxe(page);
    expect(errors).toEqual([]);
  });
}
