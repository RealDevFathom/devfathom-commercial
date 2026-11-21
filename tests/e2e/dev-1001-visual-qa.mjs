/**
 * Isolated browser QA for real DEV-1001 components. No application server,
 * credentials, database, or production network is used. Run from repo root:
 *   node tests/e2e/dev-1001-visual-qa.mjs before
 *   node tests/e2e/dev-1001-visual-qa.mjs after
 * Baseline source is loaded from the immutable starting commit using git show.
 */
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const phase = process.argv[2] ?? 'after';
assert.ok(['before', 'after'].includes(phase));
const baseline = '002b84ee1ca72880cee1f0ffebf4cdd79d343236';
const output = process.env.DEV1001_OUTPUT_DIR ?? '/tmp/dev-1001-browser-evidence';
const scratch = `/tmp/dev-1001-browser-${phase}-${process.pid}`;
await mkdir(scratch, { recursive: true });
await mkdir(output, { recursive: true });
let fontCss = `@font-face{font-family:'Instrument Sans';src:url('/fonts/instrument-sans-400-700-latin.woff2') format('woff2');font-weight:400 700;font-display:swap;}\n${[400, 500, 600].map((weight) => `@font-face{font-family:'IBM Plex Mono';src:url('/fonts/ibm-plex-mono-${weight}-latin.woff2') format('woff2');font-weight:${weight};font-display:swap;}`).join('\n')}`;
for (const font of [
  'instrument-sans-400-700-latin.woff2',
  ...[400, 500, 600].map((weight) => `ibm-plex-mono-${weight}-latin.woff2`),
]) {
  fontCss = fontCss.replace(
    `/fonts/${font}`,
    `data:font/woff2;base64,${(await readFile(path.join(root, 'src/app/fonts', font))).toString('base64')}`
  );
}
const sourceCss = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
const compiled = await postcss([tailwind({ base: root })]).process(sourceCss, {
  from: path.join(root, 'src/app/globals.css'),
});
await writeFile(path.join(scratch, 'style.css'), fontCss + compiled.css);
await build({
  entryPoints: [path.join(root, 'tests/e2e/dev-1001-fixtures.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  outfile: path.join(scratch, 'app.js'),
  define: { 'process.env.NODE_ENV': '"development"' },
  alias: {
    '@': path.join(root, 'src'),
    '@/lib/trpc': path.join(root, 'tests/e2e/dev-1001-query-fixture.ts'),
  },
  plugins: [
    {
      name: 'isolated-fixtures',
      setup(builder) {
        const restaurantStubs = {
          '@/lib/abac':
            'export { gapRestaurantCan as can, gapRestaurantSubject as subjectFromSession } from "__DEV1001_ROOT__/tests/e2e/dev-1001-gap-restaurant-fixtures.tsx";',
          '@/lib/entitlements':
            'export { gapRestaurantHasModule as hasModule } from "__DEV1001_ROOT__/tests/e2e/dev-1001-gap-restaurant-fixtures.tsx";',
          '@/lib/tenancy/tenant-actor':
            'export { gapRestaurantActor as resolveTenantActor } from "__DEV1001_ROOT__/tests/e2e/dev-1001-gap-restaurant-fixtures.tsx";',
          '@/server/restaurant-actor':
            'export { gapRestaurantStaffActor as resolveRestaurantActor } from "__DEV1001_ROOT__/tests/e2e/dev-1001-gap-restaurant-fixtures.tsx";',
          '@/server/trpc':
            'export { gapRestaurantContext as createTRPCContext } from "__DEV1001_ROOT__/tests/e2e/dev-1001-gap-restaurant-fixtures.tsx";',
          '@/server/routers/restaurant-notifications':
            'export { gapNotificationsRouter as restaurantNotificationsRouter } from "__DEV1001_ROOT__/tests/e2e/dev-1001-gap-restaurant-fixtures.tsx";',
          '@/server/routers/restaurant-purchasing':
            'export { gapPurchasingRouter as restaurantPurchasingRouter } from "__DEV1001_ROOT__/tests/e2e/dev-1001-gap-restaurant-fixtures.tsx";',
          '@/server/routers/restaurant-reports':
            'export { gapReportsRouter as restaurantReportsRouter } from "__DEV1001_ROOT__/tests/e2e/dev-1001-gap-restaurant-fixtures.tsx";',
          '@/lib/restaurant/notifications':
            'export { gapNotificationChannels as RESTAURANT_NOTIFICATION_CHANNELS } from "__DEV1001_ROOT__/tests/e2e/dev-1001-gap-restaurant-fixtures.tsx";',
          '@/lib/restaurant/reports':
            'export { gapValidateReportRange as validateRestaurantReportRange, gapCsvCell as csvCell } from "__DEV1001_ROOT__/tests/e2e/dev-1001-gap-restaurant-fixtures.tsx";export const MAX_EXPORT_ROWS=5000;export const MAX_INTERACTIVE_ROWS=200;',
          '@/lib/restaurant/financial-comparison':
            'export { gapComparisonWindows as restaurantComparisonWindows } from "__DEV1001_ROOT__/tests/e2e/dev-1001-gap-restaurant-fixtures.tsx";',
          '@/lib/restaurant/money':
            'export * from "__DEV1001_ROOT__/src/lib/restaurant/money-arithmetic.ts";',
          'next/cache': 'export const revalidatePath=()=>{};',
        };
        builder.onResolve({ filter: /^(?:@\/|next\/cache$)/ }, (args) =>
          /\/src\/app\/\(app\)\/restaurant\/(?:notifications|purchasing|reports)\//.test(
            args.importer
          ) && args.path in restaurantStubs
            ? { path: args.path, namespace: 'restaurant-gap-fixture' }
            : undefined
        );
        builder.onLoad({ filter: /.*/, namespace: 'restaurant-gap-fixture' }, ({ path: name }) => ({
          contents: restaurantStubs[name].replaceAll('__DEV1001_ROOT__', root),
          loader: 'ts',
          resolveDir: root,
        }));
        const platformStubs = {
          '@/lib/tenancy/scoped-db': 'platformFixtureWithDb as withPlatformDb',
          '@/lib/platform/page-access': 'platformFixtureReadAccess as requirePlatformRead',
          '@/server/routers/platform-health':
            'platformFixtureHealthFilters as healthFilters, platformFixtureReadHealth as readPlatformHealth',
        };
        builder.onResolve({ filter: /^@\/(?:lib|server)\// }, (args) =>
          /\/src\/app\/platform\/\(console\)\/(?:audit|health|organizations)\/page\.tsx$/.test(
            args.importer
          ) && args.path in platformStubs
            ? { path: args.path, namespace: 'platform-fixture' }
            : undefined
        );
        builder.onLoad({ filter: /.*/, namespace: 'platform-fixture' }, ({ path: name }) => ({
          contents: `export {${platformStubs[name]}} from ${JSON.stringify(path.join(root, 'tests/e2e/dev-1001-gap-platform-fixtures.tsx'))};`,
          loader: 'ts',
          resolveDir: root,
        }));
        const khataStubs = {
          '@/server/trpc': 'khataFixtureContext as createTRPCContext',
          './khata-router': 'khataFixtureRouter as pharmacyKhataRouter',
        };
        builder.onResolve({ filter: /^(?:@\/server\/trpc|\.\/khata-router)$/ }, (args) =>
          args.importer.endsWith('/src/app/(app)/pharmacy/khata/page.tsx') &&
          args.path in khataStubs
            ? { path: args.path, namespace: 'khata-fixture' }
            : undefined
        );
        builder.onLoad({ filter: /.*/, namespace: 'khata-fixture' }, ({ path: name }) => ({
          contents: `export {${khataStubs[name]}} from ${JSON.stringify(path.join(root, 'tests/e2e/dev-1001-gap-finance-fixtures.tsx'))};`,
          loader: 'ts',
          resolveDir: root,
        }));
        const inventoryStubs = {
          '@/lib/abac': 'inventoryCan as can, inventorySubjectFromSession as subjectFromSession',
          '@/lib/entitlements': 'inventoryHasModule as hasModule',
          '@/lib/tenancy/tenant-actor': 'inventoryResolveTenantActor as resolveTenantActor',
          '@/server/trpc': 'inventoryCreateTRPCContext as createTRPCContext',
          '@/server/routers/restaurant-inventory': 'inventoryRouter as restaurantInventoryRouter',
        };
        builder.onResolve({ filter: /^@\/(lib|server)\// }, (args) =>
          args.importer.endsWith('/src/app/(app)/restaurant/inventory/page.tsx') &&
          args.path in inventoryStubs
            ? { path: args.path, namespace: 'inventory-fixture' }
            : undefined
        );
        builder.onLoad({ filter: /.*/, namespace: 'inventory-fixture' }, ({ path: name }) => ({
          contents: `export {${inventoryStubs[name]}} from ${JSON.stringify(path.join(root, 'tests/e2e/dev-1001-inventory-page-fixture.tsx'))};`,
          loader: 'ts',
          resolveDir: root,
        }));
        builder.onResolve({ filter: /^@\/lib\/pharmacy\/voucher-controls$/ }, () => ({
          path: 'voucher-constants',
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /(adjust-points-actions|actions)$/ }, (args) =>
          /pharmacy\/(marketing|loyalty)/.test(args.importer)
            ? { path: 'pharmacy-actions', namespace: 'fixture' }
            : undefined
        );
        builder.onResolve({ filter: /ap-entry-actions$/ }, () => ({
          path: 'ap-actions',
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /^next\/link$/ }, () => ({
          path: 'next-link',
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /^next-auth\/react$/ }, () => ({
          path: 'session',
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: 'navigation',
          namespace: 'fixture',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({
          contents:
            name === 'voucher-constants'
              ? 'export const VOUCHER_MAX_USES=10000;export const VOUCHER_MAX_VALIDITY_DAYS=365;export const VOUCHER_TOTAL_VALUE_CAP_MINOR=1000000;export const VOUCHER_VALUE_CAP_MINOR=100000;'
              : name === 'pharmacy-actions'
                ? "export const marketingAction=async()=>({status:'idle',message:''});export const adjustPoints=marketingAction;export const savePrepaid=marketingAction;export const recordPrepaid=marketingAction;export const setCustomerPrepaidPin=marketingAction;"
                : name === 'ap-actions'
                  ? "export const recordApInvoiceFromForm=async()=>({status:'idle',message:''});export const payApInvoiceFromForm=recordApInvoiceFromForm;export const requestCreditSetOffFromForm=recordApInvoiceFromForm;export const approveCreditSetOffFromForm=recordApInvoiceFromForm;export const rejectCreditSetOffFromForm=recordApInvoiceFromForm;export const reverseCreditSetOffFromForm=recordApInvoiceFromForm;export const reverseApInvoiceFromForm=recordApInvoiceFromForm;export const reverseApSettlementFromForm=recordApInvoiceFromForm;"
                  : name === 'entitlements'
                    ? "export const useEntitlements=()=>({vertical:'RESTAURANT',modules:[],enabledModules:['restaurant-core','restaurant-menu','restaurant-pos','restaurant-workforce','restaurant-loyalty','restaurant-catering','hr','administration'],limits:{},seatLimit:100,activeSeats:2});"
                    : name === 'next-link'
                      ? 'export default function Link(props){return <a {...props}/>;}'
                      : name === 'session'
                        ? "export const signOut=async()=>{};export const useSession=()=>({data:{user:{id:'fixture-user',organizationId:'fixture-org',role:'ADMIN',name:'Fixture Owner'}},status:'authenticated'});"
                        : "export const unstable_rethrow=()=>{};export const redirect=()=>{throw Error('Fixture navigation blocked')};export const useRouter=()=>({refresh(){},push(){},replace(){}});export const useSearchParams=()=>new URLSearchParams(location.search);export const usePathname=()=>'/fixture';",
          loader: 'jsx',
          resolveDir: root,
        }));
        if (phase === 'before')
          builder.onLoad({ filter: /\.(tsx?|jsx?)$/ }, ({ path: file }) => {
            if (
              !file.startsWith(path.join(root, 'src/')) ||
              file.startsWith(path.join(root, 'src/generated/'))
            )
              return undefined;
            const relative = path.relative(root, file);
            return {
              contents: execFileSync('git', ['show', `${baseline}:${relative}`], {
                cwd: root,
                encoding: 'utf8',
              }),
              loader: file.endsWith('x') ? 'tsx' : 'ts',
              resolveDir: path.dirname(file),
            };
          });
      },
    },
  ],
});
await access(path.join(scratch, 'app.css')).catch(() =>
  writeFile(path.join(scratch, 'app.css'), '')
);
const html =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="./style.css"><link rel="stylesheet" href="./app.css"><title>DEV-1001 isolated visual QA</title></head><body><div id="root"></div><script src="./app.js"></script></body></html>';
await writeFile(path.join(scratch, 'index.html'), html);
// Browser-intercepted static bytes only: no server, listener, DNS lookup, or LAN hosting.
// The reserved .invalid origin preserves browser location/storage semantics.
const base = 'https://dev1001.invalid';
const staticAssets = new Map([['/', { body: html, contentType: 'text/html' }]]);
for (const filename of ['app.js', 'style.css', 'app.css'])
  staticAssets.set(`/${filename}`, {
    body: await readFile(path.join(scratch, filename)),
    contentType: filename.endsWith('.js') ? 'text/javascript' : 'text/css',
  });
const browser = await chromium.launch({
  headless: true,
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const results = [];
const stateResults = [];
try {
  const page = await browser.newPage();
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    const asset = url.origin === base ? staticAssets.get(url.pathname) : undefined;
    return asset ? route.fulfill(asset) : route.abort();
  });
  await page.goto(base);
  await page.waitForFunction(() => window.dev1001Screens);
  const screens = process.env.DEV1001_STATES_ONLY
    ? []
    : (await page.evaluate(() => window.dev1001Screens)).filter(
        (screen) =>
          !process.env.DEV1001_SCREENS || process.env.DEV1001_SCREENS.split(',').includes(screen)
      );
  const issues = [];
  page.on('pageerror', (error) => {
    issues.push(error.message);
    process.stdout.write('BROWSER ERROR: ' + error.message + '\n');
  });
  page.on('console', (message) => {
    if (message.type() === 'error') issues.push(message.text());
  });
  for (const screen of screens) {
    for (const theme of process.env.DEV1001_PROBE ? ['light'] : ['light', 'dark']) {
      for (const reducedMotion of phase === 'after' && !process.env.DEV1001_PROBE
        ? ['no-preference', 'reduce']
        : ['no-preference']) {
        for (const width of process.env.DEV1001_PROBE ? [375] : [375, 768, 1024, 1440]) {
          const selectedKey = `${phase}-${screen}-${width}-${theme}-${reducedMotion}`;
          if (
            process.env.DEV1001_KEYS &&
            !process.env.DEV1001_KEYS.split(',').includes(selectedKey)
          )
            continue;
          const from = issues.length;
          await page.setViewportSize({
            width,
            height: width === 375 ? 812 : width === 768 ? 1024 : 900,
          });
          await page.emulateMedia({ reducedMotion, colorScheme: theme });
          await page.goto(`${base}?screen=${screen}`);
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          await page.waitForFunction(() => document.querySelector('main')?.textContent.length > 0);
          await page.evaluate(() => document.fonts.ready);
          if (screen === 'receipt-designer')
            await page.getByText('Layout settings', { exact: true }).waitFor();
          await prepareScreen(page, screen);
          await page.waitForTimeout(250);
          const key = `${phase}-${screen}-${width}-${theme}-${reducedMotion}`;
          const metrics = await page.evaluate(() => ({
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: document.documentElement.clientWidth,
            controls: [...document.querySelectorAll('[role="combobox"],select')]
              .filter((el) => el.getAttribute('aria-hidden') !== 'true')
              .map((el) => ({
                label: el.getAttribute('aria-label') ?? el.labels?.[0]?.textContent?.trim() ?? '',
                height: el.getBoundingClientRect().height,
                width: el.getBoundingClientRect().width,
                disabled: el.matches(':disabled'),
              })),
          }));
          await page.screenshot({ path: path.join(output, `${key}.png`), fullPage: true });
          const result = {
            key,
            screen,
            width,
            theme,
            reducedMotion,
            transport: 'browser-intercepted-static',
            ...metrics,
            errors: issues.slice(from),
            overflow: metrics.documentWidth > metrics.viewportWidth + 1,
          };
          results.push(result);
          if (phase === 'after' && !process.env.DEV1001_PROBE) {
            result.keyboard = [];
            result.keyboardErrors = [];
            const dialogs = page.getByRole('dialog').filter({ visible: true });
            const activeScope = (await dialogs.count()) ? dialogs.last() : page;
            result.keyboardScope = (await dialogs.count()) ? 'active dialog' : 'page';
            const controls = activeScope.getByRole('combobox').filter({ visible: true });
            for (let index = 0; index < (await controls.count()); index++) {
              const control = controls.nth(index);
              if (await control.isDisabled()) continue;
              try {
                await control.hover();
                const hoverStyle = await control.evaluate((el) => {
                  const style = getComputedStyle(el);
                  return { backgroundColor: style.backgroundColor, borderColor: style.borderColor };
                });
                if (index === 0 && [375, 1440].includes(width) && reducedMotion === 'no-preference')
                  await page.screenshot({
                    path: path.join(output, `${key}-hover.png`),
                    fullPage: true,
                    animations: 'disabled',
                  });
                await control.focus();
                const sharedPopup = await control.evaluate((el) => el.tagName === 'BUTTON');
                await page.keyboard.press('ArrowDown');
                if (sharedPopup) {
                  await page.getByRole('listbox').last().waitFor({ state: 'visible' });
                  await page.waitForFunction(
                    () => !!document.activeElement?.closest('[data-slot="select-content"]'),
                    undefined,
                    { timeout: 2000 }
                  );
                }
                const activeOption = sharedPopup
                  ? await page.locator(':focus').evaluateAll((elements) =>
                      elements.map((el) => ({
                        role: el.getAttribute('role'),
                        text: el.textContent,
                        backgroundColor: getComputedStyle(el).backgroundColor,
                      }))
                    )
                  : [];
                if (index === 0 && [375, 1440].includes(width) && reducedMotion === 'no-preference')
                  await page.screenshot({
                    path: path.join(output, `${key}-open.png`),
                    fullPage: false,
                  });
                // A full-page capture can resize the viewport and dismiss a native-like popup.
                // Capture the open interaction at the user's viewport, then verify it stayed open.
                if (sharedPopup)
                  assert.equal(
                    await page.evaluate(
                      () => !!document.activeElement?.closest('[data-slot="select-content"]')
                    ),
                    true,
                    `${key}: popup keeps keyboard focus through capture`
                  );
                if (sharedPopup) {
                  await page.keyboard.press('Escape');
                  await page.waitForFunction(
                    (el) => el === document.activeElement,
                    await control.elementHandle(),
                    { timeout: 2000 }
                  );
                }
                if (sharedPopup)
                  await page.waitForFunction(
                    (el) => {
                      const style = getComputedStyle(el);
                      return (
                        style.boxShadow !== 'none' ||
                        (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0)
                      );
                    },
                    await control.elementHandle(),
                    { timeout: 2000 }
                  );
                const focusStyle = await control.evaluate((el) => {
                  const style = getComputedStyle(el);
                  return {
                    boxShadow: style.boxShadow,
                    outlineStyle: style.outlineStyle,
                    outlineWidth: style.outlineWidth,
                  };
                });
                result.keyboard.push({
                  index,
                  hoverStyle,
                  activeOption,
                  kind: sharedPopup ? 'shared-popup' : 'retained-native',
                  keys: sharedPopup ? ['ArrowDown', 'Escape', 'Tab'] : ['ArrowDown', 'Tab'],
                  focusStyle,
                });
                assert.equal(
                  await control.evaluate((el) => el === document.activeElement),
                  true,
                  `${key}: ${sharedPopup ? 'Escape restores' : 'ArrowDown preserves'} control ${index}`
                );
                await page.keyboard.press('Tab');
                assert.notEqual(
                  await control.evaluate((el) => el === document.activeElement),
                  true,
                  `${key}: Tab leaves control ${index}`
                );
              } catch (error) {
                result.keyboardErrors.push({
                  index,
                  message: String(error),
                  active: await page.locator(':focus').evaluateAll((elements) =>
                    elements.map((el) => ({
                      tag: el.tagName,
                      text: el.textContent,
                      role: el.getAttribute('role'),
                    }))
                  ),
                });
                process.stdout.write(`${key}: KEYBOARD FAILURE ${index} ${String(error)}\n`);
                await page.screenshot({
                  path: path.join(output, `${key}-keyboard-failure.png`),
                  fullPage: true,
                });
                break;
              }
            }
          }
          process.stdout.write(
            `${key}: ${result.overflow ? 'OVERFLOW' : 'layout ok'}, ${result.errors.length} console errors\n`
          );
        }
      }
    }
  }
  if (phase === 'after' && process.env.DEV1001_STATES_ONLY) {
    const supportedStates = {
      'restaurant-selectors': ['loading', 'empty', 'error', 'disabled', 'denied'],
      'pharmacy-import': ['loading', 'empty', 'error', 'denied'],
      'receipt-designer': ['loading', 'empty', 'error'],
      'restaurant-cameras': ['loading', 'error', 'disabled'],
      'restaurant-pos': ['disabled'],
      'restaurant-catalog': ['confirmation'],
    };
    for (const [screen, states] of Object.entries(supportedStates)) {
      if (
        process.env.DEV1001_STATE_SCREENS &&
        !process.env.DEV1001_STATE_SCREENS.split(',').includes(screen)
      )
        continue;
      for (const state of states) {
        for (const theme of ['light', 'dark']) {
          for (const reducedMotion of ['no-preference', 'reduce']) {
            for (const width of [375, 768, 1024, 1440]) {
              const from = issues.length;
              await page.setViewportSize({
                width,
                height: width === 375 ? 812 : width === 768 ? 1024 : 900,
              });
              await page.emulateMedia({ reducedMotion, colorScheme: theme });
              await page.goto(`${base}?screen=${screen}&state=${state}`);
              await page.evaluate((theme) => {
                document.documentElement.dataset.theme = theme;
              }, theme);
              await page.waitForFunction(
                () => document.querySelector('main')?.textContent.length > 0
              );
              await page.evaluate(() => document.fonts.ready);
              if (screen === 'restaurant-catalog') {
                await page.getByRole('button', { name: 'Archive', exact: true }).click();
                await page
                  .getByRole('dialog', { name: 'Archive Example seasonal soup?', exact: true })
                  .waitFor();
              }
              if (screen === 'pharmacy-import')
                await page
                  .getByText(
                    {
                      loading: 'Loading import access',
                      empty: 'Set up a branch and stock location first',
                      error: 'Could not load import setup',
                      denied: 'Owner access required',
                    }[state],
                    { exact: true }
                  )
                  .waitFor();
              if (screen === 'receipt-designer')
                await page
                  .getByText(
                    {
                      loading: 'Loading receipt settings…',
                      empty:
                        'No active branches. Configure a restaurant branch before designing its receipt.',
                      error: 'Fixture: receipt settings unavailable.',
                    }[state],
                    { exact: true }
                  )
                  .waitFor();
              await page.waitForTimeout(250);
              const key = `after-${screen}-${state}-${width}-${theme}-${reducedMotion}`;
              const geometry = await page.evaluate(() => ({
                documentWidth: document.documentElement.scrollWidth,
                viewportWidth: document.documentElement.clientWidth,
                disabledControls: document.querySelectorAll(
                  'button:disabled,select:disabled,input:disabled'
                ).length,
              }));
              await page.screenshot({ path: path.join(output, `${key}.png`), fullPage: true });
              const row = {
                key,
                screen,
                state,
                width,
                theme,
                reducedMotion,
                transport: 'browser-intercepted-static',
                ...geometry,
                errors: issues.slice(from),
                overflow: geometry.documentWidth > geometry.viewportWidth + 1,
              };
              if (screen === 'restaurant-catalog') {
                await page.getByRole('button', { name: 'Cancel', exact: true }).click();
                await page.getByRole('dialog').waitFor({ state: 'hidden' });
                const archive = page.getByRole('button', { name: 'Archive', exact: true });
                await page.waitForFunction(
                  (el) => el === document.activeElement,
                  await archive.elementHandle(),
                  { timeout: 2000 }
                );
                row.confirmationCancelled = true;
              }
              stateResults.push(row);
              process.stdout.write(
                `${key}: ${row.overflow ? 'OVERFLOW' : 'layout ok'}, ${row.errors.length} console errors\n`
              );
            }
          }
        }
      }
    }
  }
} finally {
  const prior = await readFile(path.join(output, `${phase}-metrics.json`), 'utf8')
    .then(JSON.parse)
    .catch(() => ({ results: [] }));
  const keys = new Set(results.map((row) => row.key));
  await writeFile(
    path.join(output, `${phase}-metrics.json`),
    JSON.stringify(
      {
        baseline,
        phase,
        capturedAt: new Date().toISOString(),
        fixtureScope:
          'Actual isolated components; route integration, auth, and database workflows are not exercised.',
        results: [...prior.results.filter((row) => !keys.has(row.key)), ...results],
      },
      null,
      2
    )
  );
  if (stateResults.length) {
    const priorStates = await readFile(path.join(output, 'state-metrics.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => ({ results: [] }));
    const stateKeys = new Set(stateResults.map((row) => row.key));
    await writeFile(
      path.join(output, 'state-metrics.json'),
      JSON.stringify(
        {
          baseline,
          phase,
          capturedAt: new Date().toISOString(),
          results: [
            ...priorStates.results.filter((row) => !stateKeys.has(row.key)),
            ...stateResults,
          ],
        },
        null,
        2
      )
    );
  }
  await browser.close();
}
const failures = results.filter(
  (row) =>
    row.overflow ||
    row.errors.length ||
    row.keyboardErrors?.length ||
    row.controls.some((control) => control.height < 44)
);
process.stdout.write(
  JSON.stringify(
    {
      screenshots: results.length,
      failures: failures.map(({ key, overflow, errors, keyboardErrors, controls }) => ({
        key,
        overflow,
        errors,
        keyboardErrors,
        controls,
      })),
    },
    null,
    2
  ) + '\n'
);
if (
  phase === 'after' &&
  (failures.length || stateResults.some((row) => row.overflow || row.errors.length))
)
  process.exitCode = 1;

async function chooseBranch(page, trigger) {
  if (phase === 'before') {
    await trigger.selectOption('branch-a');
    return;
  }
  await trigger.click();
  await page.getByRole('listbox').locator('[role="option"][data-value="branch-a"]').click();
}

async function prepareScreen(page, screen) {
  if (screen === 'pharmacy-orders') {
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await page
      .locator('summary')
      .filter({ hasText: 'Delivery custody and reconciliation' })
      .click();
  }
  if (screen === 'hotel-inventory')
    await page.getByRole('button', { name: 'Status of room 101', exact: true }).click();
  if (screen === 'hotel-function-spaces')
    await page.getByRole('button', { name: 'Book Example Hall', exact: true }).click();

  if (
    [
      'restaurant-notifications',
      'restaurant-purchasing',
      'restaurant-reports',
      'restaurant-printing',
    ].includes(screen)
  )
    await page.getByRole('combobox').first().waitFor();
  if (screen === 'restaurant-roster') {
    await chooseBranch(page, page.getByRole('combobox', { name: 'Branch', exact: true }));
    await page.getByRole('button', { name: 'Schedule shift', exact: true }).click();
    await page.getByRole('dialog', { name: 'Schedule shift', exact: true }).waitFor();
  }
  if (screen === 'restaurant-devices') {
    await page.getByRole('button', { name: 'Enroll device', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Enroll this browser', exact: true });
    await dialog.waitFor();
    await chooseBranch(page, dialog.getByRole('combobox', { name: 'Branch', exact: true }));
    await dialog.getByRole('combobox', { name: 'Device kind', exact: true }).click();
    await page.getByRole('option', { name: 'Kitchen display', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'KDS station', exact: true }).waitFor();
  }
  if (screen === 'restaurant-floor') {
    await chooseBranch(page, page.getByRole('combobox', { name: 'Branch', exact: true }));
    await page.getByRole('button', { name: 'Add rule', exact: true }).first().click();
    await page.getByRole('dialog', { name: 'Add routing rule', exact: true }).waitFor();
  }

  if (['platform-audit', 'platform-health', 'platform-organizations'].includes(screen))
    await page.getByRole('combobox').first().waitFor();
  if (screen === 'pharmacy-khata') await page.getByRole('combobox').first().waitFor();
  if (screen === 'pharmacy-public-portal' || screen === 'restaurant-inventory')
    await page.getByRole('combobox').first().waitFor();
  if (screen === 'workspace-organization')
    await page.locator('summary').filter({ hasText: 'Fixture Owner' }).click();
  if (screen === 'restaurant-menu-import')
    await page.getByRole('button', { name: 'Edit Grilled Chicken', exact: true }).click();
  if (screen === 'restaurant-money')
    await chooseBranch(page, page.getByRole('combobox', { name: 'Branch', exact: true }));
  if (screen === 'pharmacy-procedures')
    await page
      .getByRole('button', { name: 'Create schedule for Pharmacy — opening', exact: true })
      .click();
  if (screen === 'pharmacy-reference-import')
    await page.getByLabel('CSV or Excel workbook').setInputFiles({
      name: 'example-medicine-reference.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        'Product name,Brand name,Strength,Dosage form,Manufacturer\nExample tablets,Example brand,500 mg,Tablet,Example manufacturer\n'
      ),
    });
  if (screen === 'pharmacy-finance')
    await page.getByRole('combobox', { name: 'Margin grouping' }).waitFor();
  if (screen === 'pharmacy-purchasing') {
    await page.getByRole('button', { name: /Read batch and expiry/ }).click();
    await page.getByLabel('Photo of one pack').setInputFiles({
      name: 'fixture.png',
      mimeType: 'image/png',
      buffer: await readFile(path.join(root, 'public/favicon-32x32.png')),
    });
    await page.getByRole('combobox').first().waitFor();
  }
  if (screen === 'workspace-clients')
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  if (screen === 'workspace-settings')
    await page.getByRole('button', { name: 'New Token', exact: true }).click();
  if (screen === 'restaurant-terminal') {
    await page.getByLabel('One-time enrollment secret').fill('fixture-enrollment-secret');
    await page.getByRole('button', { name: 'Establish locked session', exact: true }).click();
    await page.getByRole('combobox').first().waitFor();
    await page.getByRole('combobox').first().scrollIntoViewIfNeeded();
  }
  if (screen === 'workspace-hr')
    await page.getByRole('tab', { name: 'Balances', exact: true }).click();
  if (screen === 'workspace-reviews')
    await page.getByRole('button', { name: /November review cycle/ }).click();
  if (screen === 'workspace-email')
    await page.locator('button').filter({ hasText: 'Compose' }).click();
  if (screen === 'restaurant-catalog')
    await page
      .getByRole('button', { name: /^Add product$/ })
      .first()
      .click();
  if (screen === 'restaurant-menus') {
    await page.getByRole('tab', { name: /^Menus/ }).click();
    await page
      .getByRole('button', { name: /^Add menu$/ })
      .first()
      .click();
  }
  if (screen === 'restaurant-promotions')
    await page
      .getByRole('button', { name: /^Create offer$/ })
      .first()
      .click();
  if (screen === 'restaurant-staff')
    await page
      .getByRole('button', { name: /^Add staff/ })
      .first()
      .click();
  if (screen === 'hotel-meal-plans')
    await page.getByRole('checkbox', { name: 'Breakfast', exact: true }).check();
}
