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
  channel = 'DINE_IN',
  publicationId = input.open.publicationId,
} = {}) {
  return {
    version,
    branchId: scope.branchId,
    channel,
    publicationId,
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
  ...['first-click', 'reload-first-click', 'changed', 'open-first-click'].map((test) => ({
    name: `server-409-${test}`,
    server409: test === 'open-first-click' ? 'open' : 'add-item',
    reloadBeforeApproval: test === 'reload-first-click',
    a: catalog({ price: '4.00' }),
    b: catalog({ price: test === 'changed' ? '7.00' : '4.00' }),
    before: 'Needs review',
    after: 'Price: 4.00 → 7.00',
    stale: test === 'changed',
  })),
  ...['channel', 'publication', 'channel-and-publication'].map((change) => ({
    name: `visible-${change}-scope`,
    selector: change !== 'publication',
    a: catalog(),
    b: catalog({
      channel: change === 'publication' ? 'DINE_IN' : 'TAKEAWAY',
      publicationId: change === 'channel' ? input.open.publicationId : 'replacement-publication',
    }),
    before: 'Price: 4.00 → 5.00',
    after:
      change === 'channel'
        ? 'Menu: Synthetic menu · Takeaway'
        : 'Publication: Different from the saved order',
    scopeChange: true,
    stale: true,
  })),
  {
    name: 'server-409-repeated-reversions-zero-clicks',
    server409: 'add-item',
    lifecycle: true,
    a: catalog({ price: '4.00' }),
    b: catalog({ price: '4.00' }),
    before: 'Needs review',
    stale: false,
  },
  ...[true, false].map((cachedOriginal) => ({
    name: `successive-foreign-publications-${cachedOriginal ? 'cached' : 'fetch'}-original`,
    cachedOriginal,
    originalScope: true,
    a: catalog({ publicationId: 'foreign-publication-two' }),
    b: catalog({ publicationId: 'foreign-publication-three' }),
    before: 'Publication: Different from the saved order',
    after: 'Reviewing the saved order’s original menu.',
    stale: true,
  })),
  ...['old-first', 'new-first'].map((order) => ({
    name: `live-fetch-${order}`,
    liveFetchProbe: order,
    a: catalog(),
    b: catalog({ price: '7.00' }),
    before: 'Price: 4.00 → 5.00',
    stale: true,
  })),
  ...[
    'isolation',
    'new-first',
    'old-first',
    'live-write',
    'live-old-first',
    'cache-write',
    'failure-retry',
  ].map((probe) => ({
    name: `restoration-${probe}`,
    restorationProbe: probe,
    originalScope: true,
    a: catalog({ publicationId: 'foreign-publication-two' }),
    b: catalog({ publicationId: 'foreign-publication-three' }),
    before: 'Publication: Different from the saved order',
    stale: true,
  })),
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
    let conflictSent = false;
    let liveFetchArmed = false;
    let liveFetchCount = 0;
    let releaseSelector;
    let selectorResponseReady = false;
    const selectorResponse = new Promise((resolve) => {
      releaseSelector = resolve;
    });
    let releaseOld;
    let releaseNew;
    const oldResponse = new Promise((resolve) => {
      releaseOld = resolve;
    });
    const newResponse = new Promise((resolve) => {
      releaseNew = resolve;
    });
    try {
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        assert.equal(url.origin, origin, 'External traffic is forbidden in this fixture');
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const path = url.pathname;
        let data;
        let status = 200;
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
        else if (path.endsWith('/orders/effective-menu')) {
          // Serve the requested channel, as the production endpoint does. A reload
          // starts on Dine in; the operator selects Takeaway again below.
          data =
            scenario.selector && url.searchParams.get('channel') !== activeCatalog.channel
              ? scenario.a
              : activeCatalog;
          if (
            url.searchParams.get('publicationId') === input.open.publicationId &&
            scenario.originalScope
          ) {
            data = catalog({ price: '4.00' });
            evidence.originalMenuRequests = (evidence.originalMenuRequests ?? 0) + 1;
            if (scenario.restorationProbe) {
              const number = evidence.originalMenuRequests;
              data = catalog({
                price: number === 1 || scenario.restorationProbe === 'isolation' ? '4.00' : '7.00',
              });
              if (scenario.restorationProbe === 'failure-retry' && number === 1) {
                status = 404;
                data = { error: 'Original menu unavailable' };
              } else if (number === 1) await oldResponse;
              else if (number === 2 && scenario.restorationProbe === 'old-first') await newResponse;
            }
          }
          if (
            scenario.restorationProbe === 'live-old-first' &&
            evidence.originalMenuRequests === 1 &&
            !url.searchParams.has('publicationId')
          ) {
            evidence.heldLiveRequests = (evidence.heldLiveRequests ?? 0) + 1;
            await newResponse;
          }
          if (scenario.liveFetchProbe && liveFetchArmed) {
            liveFetchCount += 1;
            data = catalog({ price: liveFetchCount === 1 ? '4.00' : '7.00' });
            if (liveFetchCount === 1) await oldResponse;
            else if (liveFetchCount === 2) await newResponse;
          }
          if (scenario.selector && url.searchParams.get('channel') === 'TAKEAWAY') {
            selectorResponseReady = true;
            await selectorResponse;
          }
        } else if (path.endsWith('/orders/open-orders')) data = { orders: [] };
        else if (path.endsWith('/orders/commercial-terms'))
          data = { profiles: [], rules: [], serviceChargeRate: null };
        else if (path.endsWith('/terminal/renew-composer-proof'))
          data = { composerProof: input.composerProof };
        else if (/\/orders\/(open|add-item)$/.test(path)) {
          requests.push({ path, body: route.request().postDataJSON() });
          if (scenario.server409 && !conflictSent && path.endsWith(`/${scenario.server409}`)) {
            conflictSent = true;
            status = 409;
          }
          data = path.endsWith('/open')
            ? { orderId: 'synthetic-order' }
            : { itemId: `synthetic-item-${requests.length}` };
        } else throw new Error(`Unexpected synthetic API request: ${path}`);
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(
            status === 409 ? { error: 'Review the server price conflict.' } : data
          ),
        });
      });
      const [tab1, tab2] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [tab1, tab2]) {
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') {
            // Chromium logs the deliberately supplied HTTP 409 as a resource error.
            if (scenario.server409 && /Failed to load resource:.*409/.test(message.text())) return;
            if (
              scenario.restorationProbe === 'failure-retry' &&
              /Failed to load resource:.*404/.test(message.text())
            )
              return;
            errors.push(message.text());
          }
        });
        await page.goto(origin);
        assert.deepEqual(errors, [], 'Fixture must load without browser errors');
        await page.waitForFunction(() => Boolean(window.posReviewFixture));
        assert.equal(await page.evaluate(() => Boolean(navigator.locks && indexedDB)), true);
      }
      await tab2.evaluate(() => window.posReviewFixture.mount());
      await expect(tab2.getByLabel('Channel', { exact: true })).toBeEnabled();
      await expect(tab2.getByRole('button', { name: 'Lock terminal', exact: true })).toBeEnabled();
      if (scenario.cachedOriginal) {
        await tab2.evaluate(
          (menu) => window.posReviewFixture.cache(menu),
          catalog({ price: '4.00' })
        );
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
      let before = await tab2.evaluate(() => window.posReviewFixture.read());
      const initialRequests = [...requests];
      if (scenario.server409) {
        assert.equal(conflictSent, true);
        assert.equal(requests.length, scenario.server409 === 'open' ? 1 : 2);
        assert.equal(before.queue.drafts[0].review.reason, 'CATALOG_CONFLICT');
        evidence.createdServerReview = before.queue.drafts[0].review;
      } else {
        assert.equal(requests.length, 0, 'Catalog review setup must never replay');
      }
      if (scenario.liveFetchProbe) {
        liveFetchArmed = true;
        const startReload = async (page) => {
          await page.reload();
          await page.waitForFunction(() => Boolean(window.posReviewFixture));
          await page.evaluate(() => window.posReviewFixture.mount());
        };
        await startReload(tab1);
        await expect.poll(() => liveFetchCount).toBe(1);
        await startReload(tab2);
        await expect.poll(() => liveFetchCount).toBe(2);
        if (scenario.liveFetchProbe === 'old-first') {
          releaseOld();
          await expect(
            tab1.getByRole('button', { name: 'Lock terminal', exact: true })
          ).toBeEnabled();
          const interim = await tab1.evaluate(() => window.posReviewFixture.read());
          assert.equal(interim.catalog.sections[0].items[0].price, '5.00');
          assert.equal(interim.queue.drafts[0].status, 'NEEDS_REVIEW');
          assert.deepEqual(interim.queue.drafts[0].commands, before.queue.drafts[0].commands);
          assert.equal(
            requests.length,
            0,
            'Superseded live response cannot clear review or replay'
          );
          evidence.supersededFirst = interim;
        }
        releaseNew();
        const freshCard = tab2.getByRole('region', { name: /Queued order .* review/ });
        const freshSend = tab2.getByRole('button', { name: 'Send deliberately', exact: true });
        await expect(freshCard).toContainText('Price: 4.00 → 7.00');
        releaseOld();
        await expect(
          tab1.getByRole('button', { name: 'Lock terminal', exact: true })
        ).toBeEnabled();
        const current = await tab1.evaluate(() => window.posReviewFixture.read());
        assert.equal(current.catalog.sections[0].items[0].price, '7.00');
        assert.equal(current.queue.drafts[0].status, 'NEEDS_REVIEW');
        assert.deepEqual(current.queue.drafts[0].commands, before.queue.drafts[0].commands);
        assert.equal(requests.length, 0);
        evidence.afterResponses = current;
        await freshSend.click();
        await expect.poll(() => requests.length).toBe(2);
        await expect(freshSend).toHaveCount(0);
        const completed = await tab2.evaluate(() => window.posReviewFixture.read());
        assert.equal(completed.queue.drafts[0].status, 'COMPLETED');
        assert.equal(completed.queue.drafts[0].commands[1].body.quotedUnitPrice, '7.00');
        assert.deepEqual(errors, []);
        evidence.completed = completed.queue.drafts[0];
        evidence.replayRequests = requests;
        evidence.result = 'PASS';
        continue;
      }
      if (scenario.restorationProbe) {
        const probe = scenario.restorationProbe;
        const reload = async (page) => {
          await page.reload();
          await page.waitForFunction(() => Boolean(window.posReviewFixture));
          await page.evaluate(() => window.posReviewFixture.mount());
          await expect(
            page.getByRole('button', { name: 'Send deliberately', exact: true }).first()
          ).toBeEnabled();
        };
        const read = () => tab2.evaluate(() => window.posReviewFixture.read());
        activeCatalog = scenario.b;
        await tab2.evaluate((menu) => window.posReviewFixture.cache(menu), activeCatalog);
        // For old-first, both UI tabs finish live loading BEFORE either restoration
        // starts, isolating the same-scope request-generation race from live writes.
        if (probe === 'old-first') await reload(tab2);
        let liveBefore = (await read()).catalog;
        await send.click();
        await expect.poll(() => evidence.originalMenuRequests).toBe(1);
        let acceptedB;
        if (probe === 'isolation') {
          await tab2.evaluate((draft) => window.posReviewFixture.seed(draft), {
            ...input,
            open: { ...input.open, publicationId: activeCatalog.publicationId },
            lines: [{ ...input.lines[0], quotedUnitPrice: '5.00' }],
          });
          acceptedB = (await read()).queue.drafts[1];
          assert.equal(acceptedB.status, 'QUEUED');
          releaseOld();
        } else if (probe === 'failure-retry') {
          await expect(
            tab1.getByRole('alert').filter({ hasText: 'Original menu unavailable' })
          ).toBeVisible();
          const failed = await read();
          assert.equal(failed.queue.drafts[0].status, 'NEEDS_REVIEW');
          assert.deepEqual(failed.queue.drafts[0].commands, before.queue.drafts[0].commands);
          assert.deepEqual(failed.catalog, liveBefore);
          assert.equal(requests.length, 0);
          evidence.failedFetch = failed;
          await reload(tab1);
          liveBefore = (await read()).catalog;
          assert.equal(requests.length, 0);
          await send.click();
          await expect.poll(() => evidence.originalMenuRequests).toBe(2);
        } else if (['live-write', 'live-old-first', 'cache-write'].includes(probe)) {
          activeCatalog = catalog({ price: '7.00' });
          if (probe === 'cache-write') {
            // A non-network observed cache write must invalidate the lease even
            // though it did not start another request/generation.
            await tab2.evaluate((menu) => window.posReviewFixture.cache(menu), activeCatalog);
          } else if (probe === 'live-old-first') {
            await tab2.reload();
            await tab2.waitForFunction(() => Boolean(window.posReviewFixture));
            await tab2.evaluate(() => window.posReviewFixture.mount());
            await expect.poll(() => evidence.heldLiveRequests).toBe(1);
            releaseOld();
            await expect(
              tab1.getByRole('button', { name: 'Lock terminal', exact: true })
            ).toBeEnabled();
            const interim = await read();
            assert.deepEqual(interim.catalog, liveBefore);
            assert.equal(
              interim.queue.reviewCatalogs.some(
                (menu) => menu.publicationId === input.open.publicationId
              ),
              false
            );
            assert.equal(interim.queue.drafts[0].status, 'NEEDS_REVIEW');
            assert.equal(requests.length, 0);
            evidence.supersededBeforeLiveResponse = interim;
            releaseNew();
          } else {
            await reload(tab2); // actual hook live fetch supplies 7.00 during A's await
          }
          if (probe !== 'cache-write')
            await expect(
              tab2.getByRole('region', { name: /Queued order .* review/ })
            ).toContainText('Price: 4.00 → 7.00');
          releaseOld();
        } else {
          if (probe === 'new-first') {
            await reload(tab2);
            liveBefore = (await read()).catalog;
          }
          await tab2.getByRole('button', { name: 'Send deliberately', exact: true }).click();
          await expect.poll(() => evidence.originalMenuRequests).toBe(2);
          if (probe === 'old-first') {
            releaseOld();
            await expect(
              tab1.getByRole('button', { name: 'Lock terminal', exact: true })
            ).toBeEnabled();
            const superseded = await read();
            assert.equal(
              superseded.queue.reviewCatalogs.some(
                (menu) => menu.publicationId === input.open.publicationId
              ),
              false,
              'Superseded first request must not supply even a temporary obsolete original'
            );
            assert.equal(superseded.queue.drafts[0].status, 'NEEDS_REVIEW');
            assert.equal(requests.length, 0);
            evidence.supersededFirst = superseded;
            releaseNew();
          }
          await expect(tab2.getByRole('region', { name: /Queued order .* review/ })).toContainText(
            'Price: 4.00 → 7.00'
          );
          evidence.newerBeforeOldCompletion = await read();
          releaseOld();
        }
        await expect(
          tab1.getByRole('button', { name: 'Lock terminal', exact: true })
        ).toBeEnabled();
        const after = await read();
        evidence.afterRestoration = after;
        assert.equal(after.queue.drafts[0].status, 'NEEDS_REVIEW');
        assert.deepEqual(after.queue.drafts[0].commands, before.queue.drafts[0].commands);
        assert.equal(requests.length, 0, 'Restoration is never deliberate approval');
        const expectedPrice = probe === 'isolation' ? '4.00' : '7.00';
        assert.equal(after.queue.drafts[0].review.catalog.line.currentPrice, expectedPrice);
        if (!['live-write', 'live-old-first', 'cache-write'].includes(probe))
          assert.deepEqual(
            after.catalog,
            liveBefore,
            'Original restoration must not replace the live menu'
          );
        else assert.equal(after.catalog.sections[0].items[0].price, '7.00');
        if (acceptedB) {
          assert.deepEqual(
            after.queue.drafts[1],
            acceptedB,
            'Restoration must leave accepted B unchanged'
          );
          await reload(tab2); // automatic replay may send B, while A still needs review
          await expect.poll(() => requests.length).toBe(2);
          const replayed = await read();
          assert.equal(replayed.queue.drafts[1].status, 'COMPLETED');
          assert.equal(replayed.queue.drafts[0].status, 'NEEDS_REVIEW');
          evidence.unrelatedReplay = replayed.queue.drafts[1];
        }
        await reload(tab1);
        await expect(card).toContainText(`Price: 4.00 → ${expectedPrice}`);
        assert.equal(requests.length, acceptedB ? 2 : 0);
        await tab1.screenshot({ path: resolve(artifacts, `${scenario.name}.png`), fullPage: true });
        await send.click();
        await expect.poll(() => requests.length).toBe(acceptedB ? 4 : 2);
        await expect(send).toHaveCount(0);
        const completed = await read();
        assert.equal(completed.queue.drafts[0].status, 'COMPLETED');
        assert.equal(completed.queue.drafts[0].commands[1].body.quotedUnitPrice, expectedPrice);
        assert.deepEqual(completed.queue.drafts[0].commands[0].body, input.open);
        assert.deepEqual(errors, []);
        evidence.completed = completed.queue.drafts[0];
        evidence.replayRequests = requests;
        evidence.result = 'PASS';
        continue;
      }
      if (scenario.lifecycle) {
        // Two additional synthetic composers exercise concurrent saves without
        // granting the active operator authority to replay their orders.
        await Promise.all(
          [tab1, tab2].map((page, index) =>
            page.evaluate((draft) => window.posReviewFixture.seed(draft), {
              ...input,
              composerStaffProfileId: `waiting-operator-${index}`,
              lines: [{ menuItemId: 'tea', quantity: index + 1, quotedUnitPrice: '4.00' }],
            })
          )
        );
        const saved = await tab2.evaluate(() => window.posReviewFixture.read());
        const savedIds = saved.queue.drafts.map((draft) => draft.draftId);
        assert.equal(savedIds.length, 3);
        evidence.zeroClickTransitions = [];
        for (const menu of [
          catalog(),
          catalog({ price: '4.00' }),
          catalog({ price: '7.00' }),
          catalog({ price: '4.00' }),
          catalog({ price: '4.00', coffee: false }),
          catalog({ price: '4.00' }),
          { ...catalog({ price: '4.00' }), channelOpen: false },
          catalog({ price: '4.00' }),
        ]) {
          activeCatalog = menu;
          await tab2.reload();
          await tab2.waitForFunction(() => Boolean(window.posReviewFixture));
          await tab2.evaluate(() => window.posReviewFixture.mount());
          await expect(
            tab2.getByRole('button', { name: 'Send deliberately', exact: true }).first()
          ).toBeEnabled();
          const persisted = await tab2.evaluate(() => window.posReviewFixture.read());
          assert.equal(persisted.queue.drafts[0].status, 'NEEDS_REVIEW');
          assert.deepEqual(persisted.queue.drafts[0].commands, before.queue.drafts[0].commands);
          assert.deepEqual(
            persisted.queue.drafts.map((draft) => draft.draftId),
            savedIds
          );
          assert.deepEqual(
            requests,
            initialRequests,
            'Catalog reversion/reload must never settle a server refusal'
          );
          // Exercise the real reconnect handler and await its async work via the UI.
          await tab2.evaluate(() => {
            window.dispatchEvent(new Event('offline'));
            window.dispatchEvent(new Event('online'));
          });
          await expect(
            tab2.getByRole('button', { name: 'Lock terminal', exact: true })
          ).toBeEnabled();
          assert.deepEqual(
            requests,
            initialRequests,
            'Reconnect must not approve the server review'
          );
          evidence.zeroClickTransitions.push({
            price: menu.sections[0].items[0].price,
            available: menu.sections[0].items[0].available,
            channelOpen: menu.channelOpen,
            status: persisted.queue.drafts[0].status,
            additionalRequests: requests.length - initialRequests.length,
          });
        }
      }
      if (scenario.reloadBeforeApproval) {
        await tab1.reload();
        await tab1.waitForFunction(() => Boolean(window.posReviewFixture));
        await tab1.evaluate(() => window.posReviewFixture.mount());
        await expect(send).toBeEnabled();
        await expect(card).toContainText(scenario.before);
        const reloaded = await tab2.evaluate(() => window.posReviewFixture.read());
        assert.deepEqual(reloaded.queue.drafts[0], before.queue.drafts[0]);
        assert.deepEqual(requests, initialRequests, 'Reload must not approve a server conflict');
        evidence.serverReviewSurvivedReload = true;
        before = reloaded;
      }
      assert.equal(before.queue.drafts[0].status, 'NEEDS_REVIEW');
      assert.equal(requests.length - initialRequests.length, 0);
      // Hold the real native lock, queue B's production cache write, then queue A's click.
      activeCatalog = scenario.b;
      if (scenario.selector) {
        // Let the guarded network read start first, then hold its commit behind
        // the native lock. The pending mutation must precede A's approval.
        await tab2.getByLabel('Channel', { exact: true }).selectOption('TAKEAWAY');
        await expect.poll(() => selectorResponseReady).toBe(true);
      }
      await tab2.evaluate(() => window.posReviewFixture.holdLock());
      await tab2.waitForFunction(() => window.posReviewFixture.lockHeld);
      if (scenario.selector) releaseSelector();
      else await tab2.evaluate((menu) => window.posReviewFixture.startUpdate(menu), scenario.b);
      await tab2.waitForFunction(async () => (await navigator.locks.query()).pending.length === 1);
      await send.click();
      await tab2.waitForFunction(async () => (await navigator.locks.query()).pending.length === 2);
      await expect(send).toBeDisabled();
      await tab2.evaluate(() => window.posReviewFixture.releaseLock());
      await expect(tab1.getByRole('button', { name: 'Lock terminal', exact: true })).toBeEnabled();
      evidence.afterFirstClick = {
        state: await tab2.evaluate(() => window.posReviewFixture.read()),
        additionalRequests: requests.length - initialRequests.length,
        falseStaleFeedback: await tab1.getByRole('alert').filter({ hasText: feedback }).count(),
      };
      if (scenario.stale) {
        await expect(
          tab1.getByRole('button', { name: 'Lock terminal', exact: true })
        ).toBeEnabled();
        const after = await tab2.evaluate(() => window.posReviewFixture.read());
        evidence.afterStaleClick = { draft: after.queue.drafts[0], replayRequests: [...requests] };
        assert.equal(after.queue.drafts[0].status, 'NEEDS_REVIEW');
        assert.deepEqual(after.queue.drafts[0].commands, before.queue.drafts[0].commands);
        assert.equal(
          requests.length - initialRequests.length,
          0,
          'Stale approval must send zero replay requests'
        );
        await expect(send).toBeEnabled();
        await expect(tab1.getByRole('alert').filter({ hasText: feedback })).toBeVisible();
        await expect(card).toContainText(scenario.after);
        if (scenario.originalScope) {
          await expect(card).toContainText('The menu publication changed.');
          await expect(card).toContainText('Publication: Same as the saved order');
          await expect(card).toContainText('Price: 4.00 → 4.00');
          assert.equal(
            after.queue.drafts[0].review.catalog.publicationId,
            input.open.publicationId
          );
          assert.equal((await card.innerText()).includes('foreign-publication'), false);
          assert.equal((await card.innerText()).includes(input.open.publicationId), false);
          if (!scenario.cachedOriginal) assert.equal(evidence.originalMenuRequests, 1);
          // Further unrelated publications cannot displace the retained original.
          activeCatalog = catalog({ publicationId: 'foreign-publication-four', price: '9.00' });
          await tab2.evaluate((menu) => window.posReviewFixture.cache(menu), activeCatalog);
          const retained = await tab2.evaluate(() => window.posReviewFixture.read());
          assert.equal(
            retained.queue.drafts[0].review.catalog.publicationId,
            input.open.publicationId
          );
          assert.deepEqual(retained.queue.drafts[0].commands, before.queue.drafts[0].commands);
        }
        if (scenario.scopeChange) {
          await expect(card).toContainText(
            'Sending keeps the order’s original Dine in channel and publication'
          );
          await expect(card).toContainText('these menu prices will not replace its saved prices');
          assert.equal((await card.innerText()).includes('replacement-publication'), false);
          assert.equal((await card.innerText()).includes('synthetic-publication'), false);
          if (scenario.selector)
            await expect(card).toContainText('Menu: Synthetic menu · Takeaway');
        }
        evidence.displayedB = await card.innerText();
        assert.notEqual(evidence.displayedB, evidence.displayedA);
        await expect(send).toHaveAccessibleDescription(
          new RegExp(scenario.after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        );
        await tab1.screenshot({ path: resolve(artifacts, `${scenario.name}.png`), fullPage: true });
        if (
          scenario.name === 'same-line-price-lock-reload' ||
          scenario.name === 'visible-channel-and-publication-scope' ||
          scenario.cachedOriginal
        ) {
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
                  path: resolve(
                    artifacts,
                    `${scenario.name}-${width}-${theme}-${reducedMotion}.png`
                  ),
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
        if (scenario.selector) {
          await tab1.getByLabel('Channel', { exact: true }).selectOption('TAKEAWAY');
          await expect(send).toBeEnabled();
        }
        await expect(card).toContainText(scenario.after);
        assert.equal(requests.length - initialRequests.length, 0);
        await send.focus();
        await expect(send).toBeFocused();
        await send.press('Enter');
      }
      const expected = (scenario.lines ?? input.lines).length + 1 + (scenario.server409 ? 1 : 0);
      await expect.poll(() => requests.length).toBe(expected);
      await expect(send).toHaveCount(0);
      if (!scenario.stale)
        await expect(tab1.getByRole('alert').filter({ hasText: feedback })).toHaveCount(0);
      const completed = await tab2.evaluate(() => window.posReviewFixture.read());
      assert.equal(completed.queue.drafts[0].status, 'COMPLETED');
      assert.equal(errors.length, 0, errors.join('\n'));
      if (scenario.server409) {
        assert.ok(
          evidence.createdServerReview.catalog,
          'Server review must have catalog identity before display'
        );
      }
      if (scenario.originalScope) {
        assert.deepEqual(
          completed.queue.drafts[0].commands[0].body,
          before.queue.drafts[0].commands[0].body
        );
        assert.equal(completed.queue.drafts[0].commands[1].body.quotedUnitPrice, '4.00');
      }
      if (scenario.lifecycle) assert.equal(completed.queue.drafts.length, 3);
      evidence.completed = completed.queue.drafts[0];
      evidence.replayRequests = requests;
      evidence.result = 'PASS';
    } catch (error) {
      evidence.result = 'FAIL';
      evidence.error = error.stack ?? String(error);
      evidence.browserErrors = errors;
      evidence.requestsAtFailure = [...requests];
      const reader = context.pages()[1];
      if (
        reader &&
        !reader.isClosed() &&
        (await reader.evaluate(
          () => Boolean(window.posReviewFixture) && !window.posReviewFixture.lockHeld
        ))
      ) {
        evidence.persistedAtFailure = await reader.evaluate(() => window.posReviewFixture.read());
      }
      failures.push(scenario.name);
    } finally {
      releaseOld();
      releaseNew();
      releaseSelector();
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
