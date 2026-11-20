/** Real Chromium form/keyboard verification from in-memory assets; no HTTP listener. */
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToString } from 'react-dom/server';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const root = process.cwd();
const requestedMode = process.argv[2] ?? 'all';
assert.ok(['all', 'hydrate', 'csr'].includes(requestedMode));
const modes = requestedMode === 'all' ? ['hydrate', 'csr'] : [requestedMode];
const scratch = `/tmp/dev-1001-form-parity-${process.pid}`;
await mkdir(scratch, { recursive: true });
await build({
  entryPoints: ['tests/e2e/dev-1001-form-fixture.tsx'],
  bundle: true,
  outfile: `${scratch}/fixture.js`,
  format: 'iife',
  jsx: 'automatic',
  alias: { '@': `${root}/src` },
});
const fixtureRequire = createRequire(`${root}/package.json`);
await build({
  entryPoints: ['tests/e2e/dev-1001-form-fixture.tsx'],
  bundle: true,
  outfile: `${scratch}/fixture-server.cjs`,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  alias: { '@': `${root}/src` },
  plugins: [
    {
      name: 'single-react-runtime',
      setup(builder) {
        builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({
          path: fixtureRequire.resolve(args.path),
          external: true,
        }));
      },
    },
  ],
});
const css = await postcss([tailwind({ base: root })]).process(
  await readFile(`${root}/src/app/globals.css`, 'utf8'),
  { from: `${root}/src/app/globals.css` }
);
await writeFile(`${scratch}/style.css`, css.css);
const { FormFixture } = fixtureRequire(`${scratch}/fixture-server.cjs`);
const serverMarkup = renderToString(React.createElement(FormFixture));
for (const mode of modes) {
  await writeFile(
    `${scratch}/${mode}.html`,
    `<!doctype html><html lang="en" data-render="${mode}"><head><meta charset="utf-8"><title>Static form parity</title><link rel="icon" href="data:,"><link rel="stylesheet" href="./style.css"></head><body><div id="root">${mode === 'hydrate' ? serverMarkup : ''}</div><script src="./fixture.js"></script></body></html>`
  );
}
const fixtureOrigin = 'https://dev1001.invalid';
const staticAssets = new Map([
  [
    '/fixture.js',
    { body: await readFile(`${scratch}/fixture.js`), contentType: 'text/javascript' },
  ],
  ['/style.css', { body: css.css, contentType: 'text/css' }],
  ...(await Promise.all(
    modes.map(async (mode) => [
      `/${mode}.html`,
      { body: await readFile(`${scratch}/${mode}.html`), contentType: 'text/html' },
    ])
  )),
]);
const serveMemoryAsset = (blockedRequests) => async (route) => {
  const url = new URL(route.request().url());
  const asset = url.origin === fixtureOrigin ? staticAssets.get(url.pathname) : null;
  if (asset) return route.fulfill({ status: 200, ...asset });
  blockedRequests.push(url.href);
  return route.abort();
};
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const results = [];
const expectedValidEntries = [
  ['first', 'card'],
  ['second', 'south'],
  ['controlled', 'b'],
  ['legend', 'legend-on'],
  ['optional', 'yes'],
  ['blank', ''],
  ['external', 'outside'],
];
try {
  for (const mode of modes) {
    for (const motion of ['no-preference', 'reduce']) {
      const context = await browser.newContext({ reducedMotion: motion });
      const blockedRequests = [];
      await context.route('**/*', serveMemoryAsset(blockedRequests));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      const result = {
        mode,
        motion,
        checks: [],
        submissions: {},
        enterEvents: [],
        errors,
        blockedRequests,
        passed: false,
      };
      results.push(result);
      const record = (name) => result.checks.push(name);
      const url = `${fixtureOrigin}/${mode}.html`;
      try {
        if (mode === 'hydrate') {
          const noScript = await browser.newContext({
            javaScriptEnabled: false,
            reducedMotion: motion,
          });
          await noScript.route('**/*', serveMemoryAsset(blockedRequests));
          const nativePage = await noScript.newPage();
          await nativePage.goto(url);
          assert.equal(await nativePage.locator('select:visible').count(), 8);
          await nativePage.getByRole('button', { name: 'Submit fixture' }).click();
          assert.equal(
            await nativePage
              .getByRole('combobox', { name: 'First required choice', exact: true })
              .evaluate((node) => node === document.activeElement),
            true
          );
          await noScript.close();
          record(
            'Without JavaScript, all eight server-rendered native controls remain visible and required validation blocks submission'
          );
        }
        await page.goto(url);
        await page.waitForFunction(
          () => document.querySelectorAll('[data-select-field-trigger]').length === 8
        );
        assert.equal(
          await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
          motion === 'reduce'
        );
        record(`Browser media preference is ${motion}; existing Studio CSS is loaded`);
        if (mode === 'hydrate')
          record('Server-rendered native controls hydrate to shared Select without mismatches');
        await page.evaluate(() => {
          window.__dev1001EnterEvents = [];
          document.addEventListener('keydown', (event) => {
            if (event.key === 'Enter')
              window.__dev1001EnterEvents.push({
                key: event.key,
                isTrusted: event.isTrusted,
                role: event.target.getAttribute('role'),
                text: event.target.textContent,
              });
          });
        });
        const submitted = async () => JSON.parse(await page.locator('output').textContent());
        const submissionCount = async () =>
          Number((await page.locator('output').getAttribute('data-submissions')) ?? '0');
        const rawEntries = () =>
          page.locator('#parity-form').evaluate((form) => Array.from(new FormData(form)));
        const waitPopupFocus = async () => {
          await page.getByRole('listbox').waitFor({ state: 'visible' });
          await page.waitForFunction(
            () =>
              document.activeElement?.getAttribute('role') === 'option' &&
              Boolean(document.activeElement.closest('[role="listbox"]'))
          );
        };
        const selectWithKeys = async (label, navigationKey, name, value) => {
          const trigger = page.getByRole('combobox', { name: label, exact: true });
          await trigger.focus();
          await page.keyboard.press('ArrowDown');
          await waitPopupFocus();
          await page.keyboard.press(navigationKey);
          await page.waitForFunction(
            (expected) => document.activeElement?.getAttribute('data-value') === expected,
            value
          );
          await page.keyboard.press('Enter');
          await page.getByRole('listbox').waitFor({ state: 'hidden' });
          await page.waitForFunction(
            ({ name, value }) => document.querySelector(`select[name="${name}"]`)?.value === value,
            { name, value }
          );
          assert.equal(
            await trigger.locator('[data-slot="select-value"]').textContent(),
            await page
              .locator(`select[name="${name}"]`)
              .evaluate((node) => node.selectedOptions[0].label)
          );
        };
        const resetBaseline = await page.locator('select[name=controlled]').evaluate((select) => {
          const option =
            [...select.options].find((item) => item.defaultSelected) ??
            [...select.options].find((item) => !item.disabled);
          return { value: option.value, label: option.label };
        });
        const first = page.getByRole('combobox', { name: 'First required choice', exact: true });
        await page.locator('label[for=first]').click();
        assert.equal(await first.evaluate((node) => node === document.activeElement), true);
        record('Visible label click focuses shared trigger without opening native picker');
        await page.keyboard.press('Tab');
        assert.equal(
          await page
            .getByRole('combobox', { name: 'Second required choice', exact: true })
            .evaluate((node) => node === document.activeElement),
          true
        );
        assert.equal(await page.getByRole('combobox').count(), 8);
        record('Tab order visits only visible shared controls in the original order');
        const initialEntries = [['first', ''], ['second', ''], ...expectedValidEntries.slice(2)];
        assert.deepEqual(await rawEntries(), initialEntries);
        result.submissions.initialRawFormData = initialEntries;
        await page.getByRole('button', { name: 'Submit fixture' }).click();
        assert.equal(await submissionCount(), 0);
        assert.equal(await page.locator('output').textContent(), '');
        assert.equal(await first.evaluate((node) => node === document.activeElement), true);
        assert.equal(
          await page.locator('select[name=first]').evaluate((node) => node.validity.valueMissing),
          true
        );
        result.submissions.requiredBlank = {
          rawFormDataIncludesEmptyString: true,
          successfulSubmitEvents: 0,
        };
        record(
          'Required blank exists as an empty FormData entry, but browser validation prevents a successful submit and focuses the first invalid trigger'
        );
        await first.focus();
        await page.keyboard.press('ArrowDown');
        await waitPopupFocus();
        assert.equal(
          await page
            .getByRole('option', { name: 'Unavailable', exact: true })
            .getAttribute('aria-disabled'),
          'true'
        );
        assert.equal(
          await page
            .getByRole('option', { name: 'Unavailable wire transfer', exact: true })
            .getAttribute('aria-disabled'),
          'true'
        );
        await page.keyboard.press('End');
        await page.waitForFunction(
          () => document.activeElement?.getAttribute('data-value') === 'card'
        );
        await page.keyboard.press('ArrowDown');
        assert.equal(
          await page.evaluate(() => document.activeElement?.getAttribute('data-value')),
          'card'
        );
        assert.equal(await page.locator('select[name=first]').inputValue(), '');
        await page.keyboard.press('Enter');
        await page.getByRole('listbox').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('select[name=first]').inputValue(), 'card');
        record(
          'Actual browser End/ArrowDown/Enter skips disabled options and disabled optgroups, then commits Card without an option-click fallback'
        );
        await selectWithKeys('Second required choice', 'End', 'second', 'south');
        await page.getByRole('button', { name: 'Submit fixture' }).click();
        assert.deepEqual(await submitted(), expectedValidEntries);
        assert.equal(await submissionCount(), 1);
        result.submissions.valid = await submitted();
        record(
          'Successful submission contains exactly one value per enabled control, including the optional blank and external form control'
        );
        assert.equal(
          await page
            .getByRole('combobox', { name: 'Directly disabled required choice', exact: true })
            .isDisabled(),
          true
        );
        assert.equal(
          await page.locator('select[name=directlyDisabled]').evaluate((node) => node.willValidate),
          false
        );
        assert.equal(
          (await submitted()).some(([name]) => name === 'directlyDisabled'),
          false
        );
        record(
          'A directly disabled required blank is omitted and does not block a valid submission'
        );
        await selectWithKeys('Optional blank choice', 'End', 'blank', 'filled');
        await selectWithKeys('Optional blank choice', 'Home', 'blank', '');
        await page.getByRole('button', { name: 'Submit fixture' }).click();
        assert.deepEqual(await submitted(), expectedValidEntries);
        assert.equal(await submissionCount(), 2);
        result.submissions.optionalBlankAfterKeyboardSelection = await submitted();
        record(
          'Selecting an optional blank with real Home/Enter submits its name with an empty string rather than omitting it'
        );
        await page.getByRole('button', { name: 'Toggle disabled fieldset' }).click();
        assert.equal(
          await page.getByRole('combobox', { name: 'Optional choice', exact: true }).isDisabled(),
          true
        );
        assert.equal(
          await page.getByRole('combobox', { name: 'Legend choice', exact: true }).isDisabled(),
          false
        );
        await page.getByRole('button', { name: 'Submit fixture' }).click();
        const disabledEntries = expectedValidEntries.filter(([name]) => name !== 'optional');
        assert.deepEqual(await submitted(), disabledEntries);
        assert.equal(await submissionCount(), 3);
        result.submissions.disabledFieldset = await submitted();
        record(
          'A disabled fieldset omits its ordinary control while its first-legend control stays enabled and submits'
        );
        await selectWithKeys('First required choice', 'Home', 'first', '');
        await page.getByRole('button', { name: 'Submit fixture' }).click();
        assert.equal(await submissionCount(), 3);
        assert.deepEqual(await submitted(), disabledEntries);
        assert.equal(await first.evaluate((node) => node === document.activeElement), true);
        record(
          'Re-selecting a required blank with real Home/Enter again blocks submission and preserves the previous successful payload'
        );
        await page.getByRole('button', { name: 'Reset fixture' }).click();
        await page.waitForFunction(
          (expected) => document.querySelector('select[name=controlled]').value === expected,
          resetBaseline.value
        );
        assert.equal(await page.locator('select[name=first]').inputValue(), '');
        await page.waitForFunction(
          (expected) =>
            document.querySelector(
              'button[aria-label="Controlled choice"] [data-slot="select-value"]'
            )?.textContent === expected,
          resetBaseline.label
        );
        assert.equal(
          await page
            .getByRole('combobox', { name: 'Controlled choice', exact: true })
            .locator('[data-slot=select-value]')
            .textContent(),
          resetBaseline.label
        );
        record(
          'Native reset restores uncontrolled defaults and controlled native browser reset behavior'
        );
        await first.focus();
        await page.keyboard.press('ArrowDown');
        await waitPopupFocus();
        await page.keyboard.press('Escape');
        await page.getByRole('listbox').waitFor({ state: 'hidden' });
        await page.waitForFunction(
          (node) => node === document.activeElement,
          await first.elementHandle()
        );
        record('Escape closes popup and restores focus');
        result.enterEvents = await page.evaluate(() => window.__dev1001EnterEvents);
        assert.equal(result.enterEvents.length, 5);
        assert.equal(
          result.enterEvents.every((event) => event.isTrusted && event.role === 'option'),
          true
        );
        record(
          'All five option activations originate from trusted browser Enter key events, with no harness option click'
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(blockedRequests, []);
        result.passed = true;
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await mkdir('qa-evidence/dev-1001', { recursive: true });
  for (const mode of modes) {
    const motionRuns = results.filter((result) => result.mode === mode);
    await writeFile(
      `qa-evidence/dev-1001/form-parity-${mode}.json`,
      JSON.stringify(
        {
          scope:
            'Actual shared component in Chromium with existing Studio CSS; every synthetic dev1001.invalid request is fulfilled from in-memory assets or aborted; no HTTP listener, hosted site, app server, auth, database or network access',
          mode,
          keyboardActivation: 'Playwright page.keyboard.press Enter; no option-click fallback',
          motionRuns,
          checks: motionRuns.reduce((sum, result) => sum + result.checks.length, 0),
          passed: motionRuns.length === 2 && motionRuns.every((result) => result.passed),
        },
        null,
        2
      )
    );
  }
  const hydrate = JSON.parse(
    await readFile('qa-evidence/dev-1001/form-parity-hydrate.json', 'utf8')
  );
  const csr = JSON.parse(await readFile('qa-evidence/dev-1001/form-parity-csr.json', 'utf8'));
  await writeFile(
    'qa-evidence/dev-1001/form-parity.json',
    JSON.stringify(
      {
        passed: hydrate.passed && csr.passed,
        checks: hydrate.checks + csr.checks,
        keyboardEvidence: {
          browser:
            'Trusted Chromium Enter events through page.keyboard.press; no option-click fallback',
          jsdom:
            'Per-control tests explicitly call fireEvent.click(detail: 0) after Enter because jsdom does not synthesize the browser activation; those tests alone do not prove native Enter activation',
        },
        hydrate,
        csr,
      },
      null,
      2
    )
  );
  await browser.close();
}
console.log(
  JSON.stringify({
    passed: results.every((result) => result.passed),
    results: results.map(({ mode, motion, checks, passed, errors }) => ({
      mode,
      motion,
      checks: checks.length,
      passed,
      errors,
    })),
  })
);
