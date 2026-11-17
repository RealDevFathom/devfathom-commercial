/** Synthetic browser regression: real Counter JSX/CSS, no Next server or database.
 * Run: node scripts/check-counter-reason-scroll.mjs [artifact-directory]
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
  process.argv[2] ?? resolve(root, 'playwright-artifacts/counter-reason-scroll')
);
const mock = resolve(root, 'tests/fixtures/counter-reason-scroll-mocks.tsx');
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['tests/fixtures/counter-reason-scroll.tsx'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  alias: {
    '@/lib/trpc': mock,
    'next-auth/react': mock,
    'next/link': mock,
    'next/navigation': mock,
    '@/components/entitlements-provider': mock,
    '@/lib/auth/sign-out': mock,
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
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'
    );
  }
});
await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
let browser;
const results = [];
const failures = [];
try {
  await mkdir(artifacts, { recursive: true });
  browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: ['--no-sandbox', '--no-zygote'],
  });
  for (const width of [375, 768, 1024, 1440]) {
    for (const theme of ['light', 'dark']) {
      for (const reducedMotion of ['no-preference', 'reduce']) {
        const scenario = { width, theme, reducedMotion };
        const context = await browser.newContext({
          viewport: { width, height: 800 },
          reducedMotion,
        });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          page.on('console', (message) => {
            if (message.type() === 'error') errors.push(message.text());
          });
          // This isolated fixture must never request any application API or external service.
          await context.route('**/*', (route) => {
            if (
              new URL(route.request().url()).origin === `http://127.0.0.1:${server.address().port}`
            )
              return route.continue();
            errors.push(`Unexpected external request: ${new URL(route.request().url()).origin}`);
            return route.abort();
          });
          await page.goto(`http://127.0.0.1:${server.address().port}`);
          await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
          const find = page.getByRole('button', { name: 'Find item' });
          await expect(find).toBeEnabled();
          await page.getByRole('button', { name: /^Hold/ }).click();
          for (const state of ['pending', 'recovery']) {
            const reason =
              state === 'pending'
                ? 'Wait for the current counter action to finish.'
                : 'Browser recovery is unavailable. Review payment status before continuing.';
            if (state === 'recovery')
              await page.evaluate(() => window.dispatchEvent(new Event('fixture:recovery')));
            await expect(find).toBeDisabled();
            await expect(find).toHaveAccessibleDescription(reason);
            await expect(find).toHaveAttribute('aria-describedby', 'counter-branch-reason');
            await expect(page.locator('#counter-branch-reason')).toHaveCount(1);
            // Recovery also has the already-landed desktop/phone payment explanations.
            // Keep those intact; search/upsell must not add another visible copy.
            await expect(page.getByText(reason, { exact: true })).toHaveCount(
              state === 'pending' ? 2 : 4
            );
            await expect(
              find
                .locator('xpath=ancestor::*[@data-slot="section-card"]')
                .getByText(reason, { exact: true })
            ).toHaveCount(0);
            await find.scrollIntoViewIfNeeded();
            // Scroll through more than one position, not just the initial DOM layout.
            for (const offset of [0, -40]) {
              await page
                .locator('[data-counter-console]')
                .evaluate((element, delta) => (element.scrollTop += delta), offset);
              const geometry = await page.evaluate(() => {
                const button = [...document.querySelectorAll('button')].find(
                  (el) => el.textContent === 'Find item'
                );
                const reason = document.getElementById(button.getAttribute('aria-describedby'));
                const scroll = document.querySelector('[data-counter-console]');
                const phone = document.querySelector('[aria-label="Phone payment"]');
                const rect = (el) => {
                  const r = el.getBoundingClientRect();
                  return {
                    top: r.top,
                    bottom: r.bottom,
                    left: r.left,
                    right: r.right,
                    height: r.height,
                  };
                };
                const uncovered = (el) => {
                  const r = el.getBoundingClientRect();
                  // Disabled buttons deliberately have pointer-events:none. Temporarily make
                  // them hit-testable (still disabled), without altering layout or clicking.
                  const oldValue = el.style.getPropertyValue('pointer-events');
                  const oldPriority = el.style.getPropertyPriority('pointer-events');
                  el.style.setProperty('pointer-events', 'auto', 'important');
                  try {
                    return [
                      [r.left + 3, r.top + 3],
                      [r.right - 3, r.bottom - 3],
                      [(r.left + r.right) / 2, (r.top + r.bottom) / 2],
                    ].every(([x, y]) => el.contains(document.elementFromPoint(x, y)));
                  } finally {
                    if (oldValue) el.style.setProperty('pointer-events', oldValue, oldPriority);
                    else el.style.removeProperty('pointer-events');
                  }
                };
                return {
                  button: rect(button),
                  reason: rect(reason),
                  scroll: rect(scroll),
                  phone: {
                    ...rect(phone),
                    display: getComputedStyle(phone).display,
                    position: getComputedStyle(phone).position,
                  },
                  viewport: { width: innerWidth, height: innerHeight },
                  scrollTop: scroll.scrollTop,
                  overflow:
                    document.documentElement.scrollWidth > innerWidth ||
                    scroll.scrollWidth > scroll.clientWidth,
                  buttonUncovered: uncovered(button),
                  reasonUncovered: uncovered(reason),
                  headerBottom: scroll.querySelector('header').getBoundingClientRect().bottom,
                };
              });
              results.push({ ...scenario, state, offset, ...geometry });
              console.log(JSON.stringify(results.at(-1)));
              if (theme === 'light' && reducedMotion === 'no-preference' && offset === 0) {
                await page.screenshot({
                  path: resolve(artifacts, `${width}-${state}-scrolled.png`),
                });
              }
              assert.ok(geometry.scrollTop > 0, 'Real Counter scroll container must scroll');
              assert.ok(
                geometry.headerBottom <= geometry.scroll.top,
                'Counter header must have scrolled out of view'
              );
              assert.ok(
                geometry.button.top >= geometry.scroll.top &&
                  geometry.button.bottom <= geometry.scroll.bottom,
                'Find item must be inside viewport'
              );
              assert.ok(
                geometry.reason.top >= 0 && geometry.reason.bottom <= 800,
                'Disabled explanation must remain inside viewport after scrolling'
              );
              assert.ok(
                geometry.reason.bottom <= geometry.scroll.top,
                'Explanation reserves space without covering the scroller'
              );
              assert.equal(
                geometry.buttonUncovered,
                true,
                'Find item must not be covered by the explanation or payment bar'
              );
              assert.equal(geometry.reasonUncovered, true, 'Explanation must not be covered');
              assert.equal(geometry.overflow, false, 'No document or Counter horizontal overflow');
              if (width < 1280) {
                assert.equal(geometry.phone.position, 'fixed');
                assert.ok(
                  geometry.phone.top >= geometry.button.bottom && geometry.phone.bottom <= 800,
                  'Phone payment remains visible without covering Find item'
                );
              }
            }
            const search = page.getByLabel('Scan or search');
            const value = await search.inputValue();
            await find.evaluate((button) => button.click());
            await expect(search).toHaveValue(value);
            await page.evaluate(
              (event) => window.dispatchEvent(new Event(event)),
              state === 'pending' ? 'fixture:release' : 'fixture:restore-storage'
            );
            await expect(find).toBeEnabled();
            await expect(find).not.toHaveAttribute('aria-describedby');
            await expect(page.locator('#counter-branch-reason')).toHaveCount(0);
          }
          await find.click();
          await expect(page.getByLabel('Scan or search')).toHaveValue('Synthetic spacer');
          await page.evaluate(() => window.dispatchEvent(new Event('fixture:check-mutations')));
          assert.deepEqual(JSON.parse(await page.locator('body').getAttribute('data-mutations')), [
            'transition',
          ]);
          assert.deepEqual(errors, [], 'No browser render/console/network errors');
        } catch (error) {
          failures.push({ ...scenario, error: error.message });
          console.error(JSON.stringify(failures.at(-1)));
        } finally {
          await context.close();
        }
      }
    }
  }
  assert.deepEqual(failures, [], 'Viewport regressions');
} finally {
  await writeFile(resolve(artifacts, 'geometry.json'), JSON.stringify(results, null, 2));
  await browser?.close();
  await new Promise((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept()))
  );
}
