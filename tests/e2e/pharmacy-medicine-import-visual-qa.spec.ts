import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  MEDICINE_IMPORT_TEMPLATE_COLUMNS,
  medicineImportTemplateCsv,
} from '../../src/lib/pharmacy/migration/import-template';

// DEV-912 Studio visual QA for the medicine import screens: staging a products-only template
// file (no quantity column), the bulk creation panel, the solo owner's PIN approval, and a
// created row's supplier and reorder level. Requires a solo pharmacy owner (Owner role, a PIN,
// stock control at one active branch) in a disposable tenant; it creates medicines there.
const email = process.env.PHARMACY_MEDICINE_IMPORT_QA_EMAIL;
const password = process.env.PHARMACY_MEDICINE_IMPORT_QA_PASSWORD;
const pin = process.env.PHARMACY_MEDICINE_IMPORT_QA_PIN;
const output = path.join('test-results', 'visual-qa');
const viewports = [
  { width: 375, height: 812, label: '375-portrait' },
  { width: 768, height: 1024, label: '768-tablet' },
  { width: 1024, height: 768, label: '1024-laptop' },
  { width: 1440, height: 900, label: '1440-desktop' },
];

/** Distinct per run, so every run stages new bytes instead of replaying an earlier batch. */
const run = Date.now().toString(36).toUpperCase();
const exampleName = `QA Example Tablet 500mg ${run}`;

/** The template's example row, a row with an unknown supplier, and a name-only row. */
function templateFile() {
  const [header, example] = medicineImportTemplateCsv().trim().split('\r\n');
  const blank = MEDICINE_IMPORT_TEMPLATE_COLUMNS.map(() => '');
  const row = (values: Record<string, string>) =>
    MEDICINE_IMPORT_TEMPLATE_COLUMNS.map((column, index) => values[column.header] ?? blank[index])
      .map((value) => (/[",]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value))
      .join(',');
  // Products only: the stock columns are left out, so the file has no quantity column.
  const keep = MEDICINE_IMPORT_TEMPLATE_COLUMNS.map((column) => column.header).filter(
    (name) => !['Opening quantity', 'Batch number', 'Expiry date', 'Shelf or rack'].includes(name)
  );
  const project = (line: string) => {
    const cells = line.split(',');
    return MEDICINE_IMPORT_TEMPLATE_COLUMNS.flatMap((column, index) =>
      keep.includes(column.header) ? [cells[index]] : []
    ).join(',');
  };
  return [
    header!,
    example!
      .replace('Example Tablet 500mg (delete this row)', exampleName)
      .replace('OLD-0001', `QA-${run}`),
    row({
      'Product name': `QA Unknown Supplier Syrup ${run}`,
      'Units per pack': '1',
      MRP: '180.00',
      'Purchase price': '150.00',
      Supplier: 'Nobody Wholesale',
      'Reorder level': '6',
    }),
    row({ 'Product name': `QA Name Only Cream ${run}` }),
  ]
    .map(project)
    .join('\n');
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((value) => {
    localStorage.setItem('theme', value);
    document.documentElement.setAttribute('data-theme', value);
    document.documentElement.style.colorScheme = value;
  }, theme);
}

async function noDocumentOverflow(page: Page, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    ),
    name
  ).toBe(false);
}

test.describe('medicine import Studio visual QA', () => {
  test.skip(
    !email || !password || !pin,
    'Requires PHARMACY_MEDICINE_IMPORT_QA_EMAIL, _PASSWORD and _PIN'
  );
  test('stage, approve and create across the viewport/theme/motion matrix', async ({ page }) => {
    test.setTimeout(900_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await mkdir(output, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/login');
    await page.getByLabel('Email').fill(email!);
    await page.locator('input[name="password"]').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });

    const file = { name: 'medicine-import-template.csv', mimeType: 'text/csv' };
    const chooseFile = async () => {
      // A file chosen before the form hydrates is never read, so choose it again until it is.
      await page.waitForLoadState('networkidle');
      await expect(async () => {
        await page
          .getByLabel('Source file')
          .setInputFiles({ ...file, buffer: Buffer.from(templateFile()) });
        await expect(page.getByText(/3 rows ready for column mapping/)).toBeVisible({
          timeout: 5_000,
        });
      }).toPass({ timeout: 30_000 });
    };

    // Stage once: a products-only file needs no quantity column and no packs-or-units choice.
    await page.goto('/pharmacy/medicines/staged');
    await chooseFile();
    await expect(page.getByLabel('Quantity column counts')).toBeDisabled();
    const stage = page.getByRole('button', { name: 'Stage for review' });
    await expect(stage).toBeEnabled();
    await stage.focus();
    await expect(stage).toBeFocused();
    await stage.press('Enter');
    await page.waitForURL(/batchId=/, { timeout: 60_000 });
    const reviewUrl = page.url();

    // Ask once for the whole file; the solo owner approves it with a fresh PIN.
    const ask = page.getByRole('button', { name: 'Ask to create 3 medicines' });
    await ask.click();
    await expect(page.getByText('Waiting for approval')).toBeVisible();
    await page.goto('/pharmacy/medicines');
    await page.getByLabel('Solo owner PIN (for self-approval)').fill(pin!);
    const entry = page
      .locator('article')
      .filter({ hasText: 'Create medicines from an imported file' })
      .filter({ hasText: 'medicine-import-template.csv' })
      .first();
    await expect(entry.getByText('Main branch')).toBeVisible();
    await entry.getByRole('button', { name: 'Approve edit' }).click();
    await expect(entry).toBeHidden({ timeout: 30_000 });
    await page.goto(reviewUrl);
    await page.getByRole('button', { name: 'Create medicines' }).click();
    await expect(page.getByText('All medicines created')).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByText(/1 rows name a supplier that is not one of your suppliers/)
    ).toBeVisible();
    await page.getByRole('link', { name: exampleName }).click();
    await expect(page.getByText(/Example Distributors — matched to your supplier/)).toBeVisible();
    await expect(page.getByText(/20 packs — set as the branch's safety stock/)).toBeVisible();
    const detailUrl = page.url();

    // The medicine's own detail: the owner sees the purchase price (`pharmacy:manage` only).
    const openMedicine = async () => {
      await page.goto('/pharmacy/medicines');
      await page.waitForLoadState('networkidle');
      await page.getByText('Medicine reference connectors', { exact: true }).click();
      await page.getByRole('textbox', { name: 'Medicine name', exact: true }).fill(exampleName);
      await page.getByRole('button', { name: 'Find medicine' }).click();
      await page
        .getByRole('combobox', { name: 'Medicine', exact: true })
        .selectOption({ label: exampleName });
      const price = page.getByText(/Rs 300\.00 per pack, from the imported file/);
      await expect(price).toBeVisible();
      await expect(page.getByText(/supplier Example Distributors/)).toBeVisible();
      await page
        .getByText('Purchase price (what you pay the distributor)')
        .scrollIntoViewIfNeeded();
    };
    await openMedicine();

    for (const theme of ['light', 'dark'] as const) {
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ reducedMotion, colorScheme: theme });
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          const name = `medicine-import-${theme}-${viewport.label}${reducedMotion === 'reduce' ? '-reduced-motion' : ''}`;
          const shoot = reducedMotion === 'no-preference' || viewport.width === 1440;

          await page.goto(reviewUrl.replace(/batchId=[^&]+.*$/, ''));
          await setTheme(page, theme);
          await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
          await chooseFile();
          await page.getByRole('heading', { name: 'Column mapping' }).scrollIntoViewIfNeeded();
          await noDocumentOverflow(page, `${name}-mapping`);
          if (shoot) await page.screenshot({ path: path.join(output, `${name}-mapping.png`) });

          await page.goto(reviewUrl);
          await setTheme(page, theme);
          const panel = page.getByRole('heading', {
            name: 'Create catalogue medicines from this file',
          });
          await panel.scrollIntoViewIfNeeded();
          await expect(page.getByText('All medicines created')).toBeVisible();
          await noDocumentOverflow(page, `${name}-creation`);
          if (shoot) await page.screenshot({ path: path.join(output, `${name}-creation.png`) });

          await page.goto(detailUrl);
          await setTheme(page, theme);
          await page.getByText('Reorder level', { exact: true }).scrollIntoViewIfNeeded();
          await noDocumentOverflow(page, `${name}-row`);
          if (shoot) await page.screenshot({ path: path.join(output, `${name}-row.png`) });

          await openMedicine();
          await setTheme(page, theme);
          await noDocumentOverflow(page, `${name}-medicine`);
          if (shoot) await page.screenshot({ path: path.join(output, `${name}-medicine.png`) });
        }
      }
    }
    expect(errors).toEqual([]);
  });
});
