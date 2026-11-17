/** Real two-tab POS review regression, synthetic HTTP only; no Next server or database.
 * Run: node scripts/check-pos-review-approval.mjs [artifact-directory]
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = resolve(
  process.argv[2] ?? resolve(root, 'playwright-artifacts/pos-review-approval')
);
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['tests/fixtures/pos-review-approval.tsx'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  // Next normally substitutes these compile-time client constants. This isolated
  // bundle has no Next server; all values here are synthetic, never host env.
  define: {
    'process.env.NODE_ENV': '"development"',
    'process.env.__NEXT_MANUAL_TRAILING_SLASH': 'false',
    'process.env.__NEXT_TRAILING_SLASH': 'false',
    'process.env.__NEXT_ROUTER_BASEPATH': '""',
    'process.env.__NEXT_I18N_SUPPORT': 'false',
    'process.env.__NEXT_MANUAL_CLIENT_BASE_PATH': 'false',
    'process.env.__NEXT_LINK_NO_TOUCH_START': 'false',
  },
});
const cssPath = resolve(root, 'src/app/globals.css');
const css = await postcss([tailwind({ base: root })]).process(await readFile(cssPath, 'utf8'), {
  from: cssPath,
});
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(bundle.outputFiles[0].text);
  } else if (request.url === '/fixture.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end(css.css);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>POS review fixture</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'
    );
  }
});
await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
const origin = `http://127.0.0.1:${server.address().port}`;
const scope = {
  organizationId: 'synthetic-organization',
  branchId: 'synthetic-branch',
  deviceId: 'synthetic-device',
};
const input = {
  deviceId: scope.deviceId,
  composerStaffProfileId: 'synthetic-operator',
  composerProof: 'synthetic-composer-proof',
  catalogVersion: 'original',
  clientOriginAt: '2026-11-17T00:00:00Z',
  open: { channel: 'DINE_IN', publicationId: 'synthetic-publication' },
  lines: [{ menuItemId: 'coffee', quantity: 1, quotedUnitPrice: '4.00' }],
};
function catalog({
  price = '5.00',
  modifier = '0.50',
  coffee = true,
  tea = true,
  version = 'A',
} = {}) {
  return {
    version,
    branchId: scope.branchId,
    channel: 'DINE_IN',
    publicationId: input.open.publicationId,
    channelOpen: true,
    menu: { id: 'synthetic-menu', name: 'Synthetic menu' },
    sections: [
      {
        id: 'drinks',
        name: 'Drinks',
        sortOrder: 1,
        items: [
          { id: 'coffee', displayName: 'Coffee', price, available: coffee },
          { id: 'tea', displayName: 'Tea', price: '4.00', available: tea },
        ].map((item) => ({
          ...item,
          productId: `product-${item.id}`,
          variantId: null,
          product: { name: item.displayName },
          priceSource: 'BASE_LIST',
          sortOrder: 1,
          modifierGroups: [
            {
              id: 'milk',
              name: 'Milk',
              minSelect: 0,
              maxSelect: 1,
              options: [{ id: 'oat', name: 'Oat milk', priceDelta: modifier }],
            },
          ],
        })),
      },
    ],
  };
}
const scenarios = [
  {
    name: 'same-line-price-lock-reload',
    a: catalog(),
    b: catalog({ price: '7.00', version: 'B' }),
    before: 'Price: 4.00 → 5.00',
    after: 'Price: 4.00 → 7.00',
    stale: true,
  },
  {
    name: 'same-line-modifier-lock-reload',
    a: catalog({ price: '4.00', modifier: '1.00' }),
    b: catalog({ price: '4.00', modifier: '1.50', version: 'B' }),
    lines: [
      {
        ...input.lines[0],
        modifierOptionIds: ['oat'],
        quotedModifiers: [{ optionId: 'oat', priceDelta: '0.50' }],
      },
    ],
    before: 'Oat milk: 0.50 → 1.00',
    after: 'Oat milk: 0.50 → 1.50',
    stale: true,
  },
  {
    name: 'different-item-identical-message',
    a: catalog({ price: '4.00', coffee: false }),
    b: catalog({ price: '4.00', coffee: true, tea: false, version: 'B' }),
    lines: [...input.lines, { menuItemId: 'tea', quantity: 1, quotedUnitPrice: '4.00' }],
    before: 'Line 1 · Coffee',
    after: 'Line 2 · Tea',
    stale: true,
  },
  {
    name: 'same-version-value-drift',
    a: catalog(),
    b: catalog({ price: '7.00' }),
    before: 'Price: 4.00 → 5.00',
    after: 'Price: 4.00 → 7.00',
    stale: true,
  },
  {
    name: 'unchanged-review',
    a: catalog(),
    b: catalog(),
    before: 'Price: 4.00 → 5.00',
    stale: false,
  },
  {
    name: 'unrelated-version-change',
    a: catalog(),
    b: catalog({ version: 'unrelated-update' }),
    before: 'Price: 4.00 → 5.00',
    stale: false,
  },
];
let browser;
const results = [];
const failures = [];
const feedback =
  'This order changed. Nothing was sent. Review the updated item and prices before sending deliberately again.';
try {
  await mkdir(artifacts, { recursive: true });
  browser = await chromium.launch({
    executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined,
    args: ['--no-sandbox', '--no-zygote'],
  });
  for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport: { width: 1024, height: 900 } });
    const evidence = { scenario: scenario.name };
    const errors = [];
    const requests = [];
    let activeCatalog = scenario.a;
    try {
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        assert.equal(url.origin, origin, 'External traffic is forbidden in this fixture');
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const path = url.pathname;
        let data;
        if (path.endsWith('/terminal/establish'))
          data = {
            sessionToken: 'synthetic-session-token',
            composerProof: input.composerProof,
            session: {
              id: 'synthetic-session',
              state: 'UNLOCKED',
              establishedAt: '2026-11-17T00:00:00Z',
            },
            device: {
              id: scope.deviceId,
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              name: 'Synthetic terminal',
              branchName: 'Synthetic branch',
            },
            operator: {
              staffProfileId: input.composerStaffProfileId,
              displayName: 'Synthetic operator',
              role: 'Manager',
            },
          };
        else if (path.endsWith('/terminal/operators'))
          data = {
            operators: [
              {
                staffProfileId: input.composerStaffProfileId,
                displayName: 'Synthetic operator',
                role: 'Manager',
              },
            ],
          };
        else if (path.endsWith('/terminal/layout')) data = { floors: [], sections: [] };
        else if (path.endsWith('/orders/effective-menu')) data = activeCatalog;
        else if (path.endsWith('/orders/open-orders')) data = { orders: [] };
        else if (path.endsWith('/orders/commercial-terms'))
          data = { profiles: [], rules: [], serviceChargeRate: null };
        else if (path.endsWith('/terminal/renew-composer-proof'))
          data = { composerProof: input.composerProof };
        else if (/\/orders\/(open|add-item)$/.test(path)) {
          requests.push({ path, body: route.request().postDataJSON() });
          data = path.endsWith('/open')
            ? { orderId: 'synthetic-order' }
            : { itemId: `synthetic-item-${requests.length}` };
        } else throw new Error(`Unexpected synthetic API request: ${path}`);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(data),
        });
      });
      const [tab1, tab2] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [tab1, tab2]) {
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.goto(origin);
        assert.deepEqual(errors, [], 'Fixture must load without browser errors');
        await page.waitForFunction(() => Boolean(window.posReviewFixture));
        assert.equal(await page.evaluate(() => Boolean(navigator.locks && indexedDB)), true);
      }
      await tab2.evaluate((draft) => window.posReviewFixture.seed(draft), {
        ...input,
        lines: scenario.lines ?? input.lines,
      });
      await tab2.evaluate((menu) => window.posReviewFixture.cache(menu), scenario.a);
      await tab1.evaluate(() => window.posReviewFixture.mount());
      const send = tab1.getByRole('button', { name: 'Send deliberately', exact: true });
      const card = tab1.getByRole('region', { name: /Queued order .* review/ });
      await expect(send).toBeEnabled();
      await expect(card).toContainText(scenario.before);
      evidence.displayedA = await card.innerText();
      const before = await tab2.evaluate(() => window.posReviewFixture.read());
      assert.equal(before.queue.drafts[0].status, 'NEEDS_REVIEW');
      assert.equal(requests.length, 0);
      // Hold the real native lock, queue B's production cache write, then queue A's click.
      await tab2.evaluate(() => window.posReviewFixture.holdLock());
      await tab2.waitForFunction(() => window.posReviewFixture.lockHeld);
      activeCatalog = scenario.b;
      await tab2.evaluate((menu) => window.posReviewFixture.startUpdate(menu), scenario.b);
      await tab2.waitForFunction(async () => (await navigator.locks.query()).pending.length === 1);
      await send.click();
      await tab2.waitForFunction(async () => (await navigator.locks.query()).pending.length === 2);
      await expect(send).toBeDisabled();
      await tab2.evaluate(() => window.posReviewFixture.releaseLock());
      if (scenario.stale) {
        await expect(
          tab1.getByRole('button', { name: 'Lock terminal', exact: true })
        ).toBeEnabled();
        const after = await tab2.evaluate(() => window.posReviewFixture.read());
        evidence.afterStaleClick = { draft: after.queue.drafts[0], replayRequests: [...requests] };
        assert.equal(after.queue.drafts[0].status, 'NEEDS_REVIEW');
        assert.deepEqual(after.queue.drafts[0].commands, before.queue.drafts[0].commands);
        assert.equal(requests.length, 0, 'Stale approval must send zero replay requests');
        await expect(send).toBeEnabled();
        await expect(tab1.getByRole('alert').filter({ hasText: feedback })).toBeVisible();
        await expect(card).toContainText(scenario.after);
        evidence.displayedB = await card.innerText();
        assert.notEqual(evidence.displayedB, evidence.displayedA);
        await expect(send).toHaveAccessibleDescription(
          new RegExp(scenario.after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        );
        await tab1.screenshot({ path: resolve(artifacts, `${scenario.name}.png`), fullPage: true });
        if (scenario.name === 'same-line-price-lock-reload') {
          evidence.visualMatrix = [];
          for (const width of [375, 768, 1024, 1440]) {
            for (const theme of ['light', 'dark']) {
              for (const reducedMotion of ['no-preference', 'reduce']) {
                await tab1.setViewportSize({ width, height: 900 });
                await tab1.emulateMedia({ reducedMotion });
                await tab1.evaluate((value) => {
                  document.documentElement.dataset.theme = value;
                }, theme);
                await card.scrollIntoViewIfNeeded();
                await expect(card).toContainText(scenario.after);
                await expect(send).toBeEnabled();
                await send.focus();
                await expect(send).toBeFocused();
                assert.equal(
                  await tab1.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                  true
                );
                const bounds = await card.boundingBox();
                assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
                await tab1.screenshot({
                  path: resolve(artifacts, `review-${width}-${theme}-${reducedMotion}.png`),
                  fullPage: true,
                });
                evidence.visualMatrix.push({ width, theme, reducedMotion, result: 'PASS' });
              }
            }
          }
        }
        // Close/reopen native IndexedDB from an independent page and reload the UI.
        await tab2.reload();
        await tab2.waitForFunction(() => Boolean(window.posReviewFixture));
        const persisted = await tab2.evaluate(() => window.posReviewFixture.read());
        assert.deepEqual(persisted.queue.drafts, after.queue.drafts);
        await tab1.reload();
        await tab1.waitForFunction(() => Boolean(window.posReviewFixture));
        await tab1.evaluate(() => window.posReviewFixture.mount());
        await expect(send).toBeEnabled();
        await expect(card).toContainText(scenario.after);
        assert.equal(requests.length, 0);
        await send.focus();
        await expect(send).toBeFocused();
        await send.press('Enter');
      }
      const expected = (scenario.lines ?? input.lines).length + 1;
      await expect.poll(() => requests.length).toBe(expected);
      await expect(send).toHaveCount(0);
      const completed = await tab2.evaluate(() => window.posReviewFixture.read());
      assert.equal(completed.queue.drafts[0].status, 'COMPLETED');
      assert.equal(errors.length, 0, errors.join('\n'));
      evidence.completed = completed.queue.drafts[0];
      evidence.replayRequests = requests;
      evidence.result = 'PASS';
    } catch (error) {
      evidence.result = 'FAIL';
      evidence.error = error.stack ?? String(error);
      evidence.browserErrors = errors;
      failures.push(scenario.name);
    } finally {
      await context.close();
      results.push(evidence);
      console.log(
        JSON.stringify({
          scenario: evidence.scenario,
          result: evidence.result,
          error: evidence.error,
        })
      );
    }
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept()))
  );
  await writeFile(
    resolve(artifacts, 'assertions.json'),
    JSON.stringify(
      { results, failures, cleanup: 'Browser contexts, browser, and loopback HTTP server closed.' },
      null,
      2
    )
  );
}
assert.deepEqual(failures, [], 'Every two-tab browser scenario must pass');
