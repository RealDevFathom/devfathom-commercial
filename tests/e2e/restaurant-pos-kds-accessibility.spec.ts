import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUTPUT = path.join('test-results', 'visual-qa', 'm9');
const VIEWPORTS = [
  { name: '375-portrait', width: 375, height: 812 },
  { name: '768-tablet', width: 768, height: 1024 },
  { name: '1024-laptop', width: 1024, height: 768 },
  { name: '1440-desktop', width: 1440, height: 900 },
] as const;
const THEMES = ['light', 'dark'] as const;
const TERMINALS = [
  { name: 'pos', route: '/pos', heading: 'Establish device' },
  { name: 'kds', route: '/kds', heading: 'Connect kitchen display' },
] as const;

const menu = {
  publicationId: 'publication-qa',
  channelOpen: true,
  menu: { id: 'menu-qa', name: 'Accessibility menu' },
  sections: [
    {
      id: 'mains',
      name: 'Mains',
      items: [
        {
          id: 'item-steak',
          displayName: 'Steak',
          product: { name: 'Steak' },
          price: '24.00',
          available: true,
        },
        {
          id: 'item-soup',
          displayName: 'Sold out soup',
          product: { name: 'Soup' },
          price: '8.00',
          available: false,
        },
      ],
    },
  ],
};

const order = {
  id: 'order-qa',
  orderNumber: 42,
  status: 'FIRING',
  channel: 'DINE_IN',
  publicationId: menu.publicationId,
  coverCount: 2,
  items: [
    {
      id: 'order-item-steak',
      course: 1,
      seatNumber: 1,
      name: 'Steak',
      unitPrice: '24.00',
      quantity: 1,
      status: 'FIRING',
      modifiers: [],
    },
  ],
  tables: [{ id: 'order-table-qa', tableId: 'T12', active: true }],
  totals: { subtotal: '24.00', tax: '2.40', serviceCharge: '0.00' },
};

const ticketQueue = {
  stationId: 'hot-line',
  businessDate: '2026-08-28',
  cursor: 7,
  gap: false,
  hasMore: false,
  displayMapping: {},
  tickets: [
    {
      ticketId: 'ticket-qa',
      ticketNumber: 17,
      orderId: order.id,
      orderNumber: order.orderNumber,
      createdAt: '2026-08-28T03:00:00.000Z',
      displayStatus: 'NEW',
      items: [
        {
          orderItemId: 'order-item-steak',
          name: 'Steak',
          course: 1,
          seatNumber: 1,
          quantity: 1,
          itemStatus: 'FIRING',
          displayStatus: 'NEW',
        },
      ],
    },
  ],
};

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);
}

async function scan(page: Page, state: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations, `${state}: ${JSON.stringify(results.violations, null, 2)}`).toEqual(
    []
  );
}

async function expectNoDocumentOverflow(page: Page, state: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    ),
    `${state} has document-level horizontal overflow`
  ).toBe(true);
}

async function expectTouchTargets(page: Page, state: string) {
  const undersized = await page.locator('button, input, select, textarea').evaluateAll((nodes) =>
    nodes.flatMap((node) => {
      const element = node as HTMLElement;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        box.width === 0 ||
        box.height === 0 ||
        (box.width >= 44 && box.height >= 44)
      ) {
        return [];
      }
      return [
        `${element.tagName.toLowerCase()}#${element.id || '(no-id)'} ${box.width}x${box.height}`,
      ];
    })
  );
  expect(undersized, `${state} has controls below 44×44 CSS pixels`).toEqual([]);
}

function collectRuntimeErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page: ${String(error)}`));
  return errors;
}

async function mockPos(page: Page) {
  await page.route('**/api/restaurant/**', async (route) => {
    const url = new URL(route.request().url());
    const authorization = route.request().headers().authorization ?? '';
    if (url.pathname === '/api/restaurant/terminal/establish') {
      if (authorization.includes('revoked')) return json(route, { error: 'Device revoked.' }, 403);
      if (authorization.includes('denied'))
        return json(route, { error: 'Permission denied.' }, 403);
      return json(
        route,
        {
          sessionToken: 'session-qa',
          session: { id: 'session-qa', state: 'LOCKED', establishedAt: '2026-08-28T03:00:00Z' },
          device: { id: 'device-qa', branchId: 'branch-qa' },
        },
        201
      );
    }
    if (url.pathname === '/api/restaurant/terminal/unlock') {
      return json(route, {
        session: { id: 'session-qa', state: 'UNLOCKED', activeStaffProfileId: 'operator-qa' },
      });
    }
    if (url.pathname === '/api/restaurant/orders/effective-menu') return json(route, menu);
    if (url.pathname === '/api/restaurant/orders/open-orders') {
      return json(route, {
        orders: [
          {
            id: order.id,
            orderNumber: order.orderNumber,
            status: order.status,
            channel: order.channel,
            activeTableIds: ['T12'],
            itemCount: 1,
            subtotal: '24.00',
          },
        ],
      });
    }
    if (url.pathname === '/api/restaurant/orders/detail') return json(route, order);
    return json(route, {});
  });
}

async function unlockPos(page: Page) {
  await page.goto('/pos');
  await page.getByLabel('Bearer device secret').fill('pos-secret');
  await page.getByRole('button', { name: 'Establish session' }).click();
  await expect(page.getByRole('heading', { name: 'Terminal locked' })).toBeVisible();
  await page.getByLabel('Operator profile ID').fill('operator-qa');
  await page.getByLabel('Operator PIN').fill('4242');
  await page.getByRole('button', { name: 'Unlock terminal' }).click();
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
}

test.beforeAll(async () => {
  await mkdir(OUTPUT, { recursive: true });
});

test.describe('POS and KDS release matrix', () => {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`${theme} ${viewport.name}`, async ({ page }) => {
        const errors = collectRuntimeErrors(page);
        await page.setViewportSize(viewport);
        await setTheme(page, theme);
        for (const terminal of TERMINALS) {
          await page.goto(terminal.route);
          await expect(
            page.getByRole('heading', { level: 1, name: terminal.heading })
          ).toBeVisible();
          await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
          await expectNoDocumentOverflow(page, `${terminal.name} ${theme} ${viewport.name}`);
          await expectTouchTargets(page, `${terminal.name} ${theme} ${viewport.name}`);
          await scan(page, `${terminal.name} ${theme} ${viewport.name}`);
          await page.screenshot({
            path: path.join(OUTPUT, `${terminal.name}-${theme}-${viewport.name}.png`),
            fullPage: true,
          });
        }
        expect(errors).toEqual([]);
      });
    }
  }

  test('reduced motion renders both terminals immediately', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await setTheme(page, 'light');
    for (const terminal of TERMINALS) {
      await page.goto(terminal.route);
      await expect(page.getByRole('heading', { level: 1, name: terminal.heading })).toBeVisible();
      const animations = await page.locator('*').evaluateAll(
        (nodes) =>
          nodes.filter((node) => {
            const style = getComputedStyle(node);
            return style.animationName !== 'none' && style.animationDuration !== '0s';
          }).length
      );
      expect(animations, `${terminal.name} keeps required animation under reduced motion`).toBe(0);
      await page.screenshot({
        path: path.join(OUTPUT, `${terminal.name}-reduced-motion-1440.png`),
        fullPage: true,
      });
    }
  });
});

test.describe('POS interaction states', () => {
  test.beforeEach(async ({ page }) => mockPos(page));

  test('covers locked, active, empty, disabled, destructive, labels, live regions and keyboard', async ({
    page,
  }) => {
    const errors = collectRuntimeErrors(page);
    await unlockPos(page);
    await expect(page.getByText('Open or resume an order to build its ticket.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sold out soup' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add to order' })).toBeDisabled();
    await page.getByRole('button', { name: /#42/ }).click();
    await page.getByRole('button', { name: 'Void Steak' }).click();
    const dialog = page.getByRole('dialog', { name: 'Void Steak' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Void reason')).toBeVisible();
    await expect(dialog.getByLabel('Approving manager profile ID')).toBeVisible();
    await expect(dialog.getByLabel('Manager PIN')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Confirm void' })).toBeVisible();
    await scan(page, 'POS destructive confirmation');
    await page.screenshot({
      path: path.join(OUTPUT, 'pos-destructive-dialog.png'),
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Void Steak' })).toBeFocused();
    await expectNoDocumentOverflow(page, 'POS active');
    await expectTouchTargets(page, 'POS active');
    await scan(page, 'POS active');
    expect(errors).toEqual([]);
  });

  test('announces permission denied and revoked states', async ({ page }) => {
    await page.goto('/pos');
    for (const secret of ['denied', 'revoked']) {
      await page.getByLabel('Bearer device secret').fill(secret);
      await page.getByRole('button', { name: 'Establish session' }).click();
      await expect(page.getByRole('alert')).toContainText(
        secret === 'denied' ? 'Permission denied' : 'Device revoked'
      );
      await scan(page, `POS ${secret}`);
    }
  });
});

test.describe('KDS interaction states', () => {
  test('covers loading, active, empty, error, disabled and revoked states', async ({ page }) => {
    const errors = collectRuntimeErrors(page);
    let queueMode: 'active' | 'empty' | 'error' | 'revoked' = 'active';
    let releaseLoading!: () => void;
    const loadingGate = new Promise<void>((resolve) => (releaseLoading = resolve));
    let firstQueue = true;
    await page.route('**/api/restaurant/kds/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/restaurant/kds/queue') {
        if (firstQueue) {
          firstQueue = false;
          await loadingGate;
        }
        if (queueMode === 'error') return json(route, { error: 'Queue unavailable.' }, 500);
        if (queueMode === 'revoked') return json(route, { error: 'Device revoked.' }, 403);
        return json(route, {
          ...ticketQueue,
          tickets: queueMode === 'empty' ? [] : ticketQueue.tickets,
        });
      }
      return json(route, {});
    });

    await page.goto('/kds');
    const connect = page.getByRole('button', { name: 'Connect display' });
    await expect(connect).toBeDisabled();
    await page.getByLabel('Bearer device secret').fill('kds-secret');
    await page.getByLabel('Acting operator profile ID').fill('operator-qa');
    await connect.click();
    await expect(page.getByLabel('Loading kitchen queue')).toBeVisible();
    await scan(page, 'KDS loading');
    releaseLoading();
    await expect(page.getByText('Ticket 17')).toBeVisible();
    await expectTouchTargets(page, 'KDS active');
    await scan(page, 'KDS active');

    queueMode = 'empty';
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(
      page.getByText('Queue clear. No open kitchen tickets for this station.')
    ).toBeVisible();
    await scan(page, 'KDS empty');

    queueMode = 'error';
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByRole('alert')).toContainText('Queue unavailable.');
    await scan(page, 'KDS error');

    queueMode = 'revoked';
    await page.getByRole('button', { name: 'Retry now' }).click();
    await expect(page.getByRole('heading', { name: 'Connect kitchen display' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Device authorization failed');
    await scan(page, 'KDS revoked');
    await expectNoDocumentOverflow(page, 'KDS revoked');
    expect(errors).toEqual([]);
  });
});
