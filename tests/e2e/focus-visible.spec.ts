import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const globals = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

test('the global keyboard outline wins over the note editor focus reset', async ({ page }) => {
  await page.setContent(`
    <style>${globals}</style>
    <button>Before editor</button>
    <div class="note-prose" contenteditable="true">Editor</div>
  `);

  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');

  const editor = page.locator('.note-prose');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveCSS('outline-style', 'solid');
  await expect(editor).toHaveCSS('outline-width', '2px');
  await expect(editor).toHaveCSS('outline-offset', '-2px');
});
