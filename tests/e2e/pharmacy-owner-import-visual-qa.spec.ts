import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// Read-only stock QA: the source deliberately has no matching pack. This suite
// uploads and previews, but never commits stock. Requires an ADMIN in a tenant
// with Pharmacy Inventory, an active branch, and a stock location.
const email = process.env.PHARMACY_IMPORT_QA_EMAIL;
const password = process.env.PHARMACY_IMPORT_QA_PASSWORD;
const output = path.join('test-results', 'pharmacy-owner-import');
const viewports = [
  { width: 375, height: 812 }, { width: 768, height: 1024 },
  { width: 1024, height: 768 }, { width: 1440, height: 900 },
];

test.describe('owner importer Studio visual QA', () => {
  test.skip(!email || !password, 'Requires PHARMACY_IMPORT_QA_EMAIL and PHARMACY_IMPORT_QA_PASSWORD');
  test('upload, mapping and blocked review across viewport/theme/motion matrix', async ({ page }) => {
    test.slow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await mkdir(output, { recursive: true });
    await page.goto('/login');
    await page.getByLabel('Email').fill(email!);
    await page.locator('input[name="password"]').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));

    for (const theme of ['light', 'dark'] as const) {
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ reducedMotion });
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          await page.goto('/pharmacy/inventory/import');
          await page.evaluate((value) => {
            localStorage.setItem('theme', value);
            document.documentElement.setAttribute('data-theme', value);
            document.documentElement.style.colorScheme = value;
          }, theme);
          const file = page.getByLabel('CSV or XLSX file');
          await expect(file).toBeVisible();
          await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
          const name = `${theme}-${reducedMotion}-${viewport.width}`;
          await page.screenshot({ path: path.join(output, `${name}-upload.png`), fullPage: true });
          // Branch and stock location start prefilled; a single branch shows as text, not a picker.
          await expect(page.getByLabel('Stock location')).toBeEnabled();
          await expect(page.getByLabel('Stock location')).not.toHaveValue('');
          await file.setInputFiles({ name: 'qa.csv', mimeType: 'text/csv', buffer: Buffer.from('Source reference,Barcode,Batch,Expiry,MRP,Cost,Exported base units,Physically counted base units,Variance explanation\nQA-SRC,QA-UNMATCHED-PACK,B1,2099-06,25,1.25,12,10,Excluded damage') });
          const dryRun = page.getByRole('button', { name: 'Preview import' });
          await expect(dryRun).toBeEnabled();
          await dryRun.focus();
          await expect(dryRun).toBeFocused();
          await dryRun.press('Enter');
          const commit = page.getByRole('button', { name: 'Import opening stock', exact: true });
          await expect(commit).toBeDisabled();
          await expect(page.getByText('1 row needs a fix', { exact: true })).toBeVisible();
          await expect(page.getByRole('link', { name: /Open medicine catalogue and packs/ })).toBeVisible();
          await expect(page.getByRole('link', { name: /Open catalogue review/ })).toHaveAttribute('href', '/pharmacy/medicines');
          await expect(page.getByRole('checkbox')).toBeDisabled();
          await page.getByRole('heading', { name: '3. Review and import' }).scrollIntoViewIfNeeded();
          expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), name).toBe(false);
          await page.screenshot({ path: path.join(output, `${name}-blocked-review.png`), fullPage: true });
        }
      }
    }
    expect(errors).toEqual([]);
  });
});
