/** DEV-977 visual QA: photographs the real AppShell and pharmacy counter (JSX and CSS) with
 * synthetic data, no Next server or database, at the Studio QA matrix sizes.
 * Run: node scripts/capture-counter-screens.mjs [artifact-directory]
 * Prints one JSON line per screen with the layout facts the counter must keep (no page
 * overflow; at 1366 x 768 every bill line readable and at least five results visible).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = resolve(process.argv[2] ?? resolve(root, 'playwright-artifacts/counter-screens'));
const mocks = resolve(root, 'tests/fixtures/counter-screens-mocks.tsx');
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['tests/fixtures/counter-screens.tsx'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
  alias: {
    '@/lib/trpc': mocks,
    'next-auth/react': mocks,
    'next/link': mocks,
    'next/navigation': mocks,
    '@/components/entitlements-provider': mocks,
    '@/lib/auth/sign-out': mocks,
    '@/components/theme-provider': mocks,
    'next/image': resolve(root, 'tests/fixtures/counter-screens-image.tsx'),
    'next/dynamic': resolve(root, 'tests/fixtures/counter-screens-dynamic.tsx'),
  },
  logLevel: 'error',
});
const cssPath = resolve(root, 'src/app/globals.css');
const css = await postcss([tailwind({ base: root })]).process(await readFile(cssPath, 'utf8'), {
  from: cssPath,
});
const fonts = `
@font-face { font-family: 'Instrument Sans'; src: url('/fonts/instrument-sans-400-700-latin.woff2') format('woff2'); font-weight: 400 700; }
@font-face { font-family: 'IBM Plex Mono'; src: url('/fonts/ibm-plex-mono-400-latin.woff2') format('woff2'); font-weight: 400; }
@font-face { font-family: 'IBM Plex Mono'; src: url('/fonts/ibm-plex-mono-500-latin.woff2') format('woff2'); font-weight: 500; }
@font-face { font-family: 'IBM Plex Mono'; src: url('/fonts/ibm-plex-mono-600-latin.woff2') format('woff2'); font-weight: 600; }`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture');
  if (url.pathname === '/fixture.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(bundle.outputFiles[0].text);
  } else if (url.pathname === '/fixture.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end(fonts + css.css);
  } else if (url.pathname.startsWith('/fonts/')) {
    response.setHeader('Content-Type', 'font/woff2');
    response.end(await readFile(resolve(root, 'src/app', url.pathname.slice(1))));
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'
    );
  }
});
await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
const { port } = server.address();

const SHOTS = [
  // [file, scenario, width, height, options]
  ['a1-bill-1440', 'sale', 1440, 900, {}],
  ['a1-bill-1440-dark', 'sale', 1440, 900, { theme: 'dark' }],
  ['a6-search-1440', 'search', 1440, 900, { type: 'amox' }],
  ['a6-search-1366x768', 'search', 1366, 768, { type: 'amox' }],
  ['a6-staged-1366x768', 'staged', 1366, 768, { type: 'amox', arrow: true }],
  ['bill-1366x768', 'sale', 1366, 768, {}],
  ['bill-1366x768-dark', 'sale', 1366, 768, { theme: 'dark' }],
  ['b5-search-error-1024', 'error', 1024, 768, { type: 'risek' }],
  ['b6-loading-1024', 'loading', 1024, 768, {}],
  ['bill-1024', 'sale', 1024, 768, {}],
  ['empty-1440', 'empty', 1440, 900, {}],
  ['c1-blocked-768', 'blocked', 768, 1024, {}],
  ['c2-sale-768', 'sale', 768, 1024, {}],
  ['c2-sale-768-dark', 'sale', 768, 1024, { theme: 'dark' }],
  ['c3-sale-375', 'sale', 375, 812, {}],
  ['c3-search-375', 'search', 375, 812, { type: 'amox' }],
  ['c3-sale-375-dark', 'sale', 375, 812, { theme: 'dark' }],
  ['more-menu-1024', 'sale', 1024, 768, { more: true }],
  ['keyboard-focus-1440', 'sale', 1440, 900, { tabs: 3 }],
  ['reduced-motion-1440', 'search', 1440, 900, { type: 'amox', reduced: true }],
];
const only = process.env.SHOTS?.split(',');

await mkdir(artifacts, { recursive: true });
// A pinned @playwright/test may expect a different browser build than the one installed.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
const report = [];
try {
  for (const [file, scenario, width, height, options] of SHOTS) {
    if (only && !only.includes(file)) continue;
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      reducedMotion: options.reduced ? 'reduce' : 'no-preference',
      colorScheme: options.theme === 'dark' ? 'dark' : 'light',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error.stack ?? error).slice(0, 600)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(
      `http://127.0.0.1:${port}/?scenario=${scenario}&theme=${options.theme ?? 'light'}`
    );
    await page.waitForTimeout(800);
    if (options.type) {
      const field = page.getByLabel('Scan or search');
      await field.fill(options.type);
      await page.waitForTimeout(600);
      if (options.arrow) {
        await field.press('ArrowDown');
        await page.waitForTimeout(300);
      }
    }
    if (options.more) {
      await page.getByRole('button', { name: /^(More|Actions)$/ }).click();
      await page.waitForTimeout(200);
    }
    if (options.tabs) {
      await page.locator('body').click({ position: { x: 1, y: 1 } });
      await page.keyboard.press('Shift+Tab');
      for (let index = 0; index < options.tabs; index += 1) await page.keyboard.press('Tab');
      await page.waitForTimeout(200);
    }
    const facts = await page.evaluate(() => {
      const visible = (element) => {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        let node = element.parentElement;
        while (node) {
          const style = getComputedStyle(node);
          if (style.overflowY !== 'visible' || style.overflowX !== 'visible') {
            const clip = node.getBoundingClientRect();
            if (box.bottom > clip.bottom + 1 || box.top < clip.top - 1) return false;
          }
          node = node.parentElement;
        }
        return box.bottom <= innerHeight + 1 && box.top >= -1;
      };
      const cut = (element) => element.scrollWidth > element.clientWidth + 1;
      const list = document.querySelector('[aria-label="Search results"]');
      const resultButtons = list ? [...list.querySelectorAll(':scope > li > button')] : [];
      const rows = [...document.querySelectorAll('[aria-label="Cart lines"] tbody tr:first-child')];
      return {
        pageOverflowX: document.documentElement.scrollWidth > innerWidth,
        results: resultButtons.length,
        resultsFullyVisible: resultButtons.filter(visible).length,
        billLines: rows.length,
        billLinesFullyVisible: rows.filter(visible).length,
        billCellsCut: rows.flatMap((row) => [...row.querySelectorAll('th, td')]).filter(cut).length,
      };
    });
    await page.screenshot({ path: resolve(artifacts, `${file}.png`) });
    report.push({ file, width, height, ...facts, errors: errors.slice(0, 3) });
    console.log(JSON.stringify(report.at(-1)));
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2));
