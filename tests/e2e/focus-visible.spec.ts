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
