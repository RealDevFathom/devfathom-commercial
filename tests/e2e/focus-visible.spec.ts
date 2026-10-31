import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

import { assertKeyboardFocusWalk, focusThemes, useFocusTheme } from './helpers/focus-visible';

const globals = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

for (const theme of focusThemes) {
  test(`the keyboard outline wins over resets on real control surfaces in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setContent(`
      <style>${globals}</style>
      <main>
        <button style="background: var(--surface-raised)">Raised action</button>
        <input aria-label="Paper input" style="background: var(--surface-page)" />
        <div class="note-prose" contenteditable="true" style="background: var(--surface-sunken)">Editor</div>
      </main>
    `);
    await useFocusTheme(page, theme);
    await assertKeyboardFocusWalk(page, `surface-contract-${theme}`, testInfo);
  });
}

test('the focus walk starts before an already focused control and skips unavailable controls', async ({
  page,
}, testInfo) => {
  await page.setContent(`
    <style>${globals}</style>
    <button id="first">First</button>
    <button disabled>Disabled</button>
    <button hidden>Hidden</button>
    <button id="middle">Middle</button>
    <button id="last">Last</button>
  `);
  await page.locator('#middle').focus();
  await page.evaluate(() => {
    document.addEventListener('focusin', (event) => {
      if (event.target instanceof HTMLButtonElement) event.target.dataset.visited = 'true';
    });
  });

  await assertKeyboardFocusWalk(page, 'existing-focus', testInfo);

  await expect(page.locator('button[data-visited="true"]')).toHaveCount(3);
  await expect(page.locator('#first')).toBeFocused();
});

test('the focus walk still rejects a missing outline on the last control', async ({
  page,
}, testInfo) => {
  await page.setContent(`
    <style>${globals}</style>
    <button>First</button>
    <button>Middle</button>
    <button style="outline: none !important">Broken last control</button>
  `);

  await expect(assertKeyboardFocusWalk(page, 'missing-outline', testInfo)).rejects.toThrow(
    'has a solid outline'
  );
});
