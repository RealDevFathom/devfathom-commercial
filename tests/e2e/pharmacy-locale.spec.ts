import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { PHARMACY_E2E } from './pharmacy-counter-fixture';

test.describe.configure({ mode: 'default' });
test.use({ actionTimeout: 20_000 });
if (process.env.PHARMACY_E2E !== '1') throw new Error('PHARMACY_E2E=1 is required.');
const labels = {
  en: {
    title: 'Counter',
    language: 'Language',
    scan: 'Scan or search',
    cart: 'Cart lines',
    amount: 'Amount',
    cash: 'Cash received',
    pay: 'Take payment',
    drawer: 'Open drawer',
  },
  ur: {
    title: 'کاؤنٹر',
    language: 'زبان',
    scan: 'اسکین یا تلاش کریں',
    cart: 'کارٹ کی آئٹمز',
    amount: 'رقم',
    cash: 'موصول شدہ نقد',
    pay: 'ادائیگی لیں',
    drawer: 'دراز کھولیں',
  },
} as const;
type Locale = keyof typeof labels;
async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.PHARMACY_E2E_ADMIN_EMAIL!);
  await expect(async () => {
    const password = page.getByRole('textbox', { name: 'Password' });
    if ((await password.getAttribute('type')) === 'password')
      await page.getByRole('button', { name: 'Show password', exact: true }).press('Enter');
    await expect(password).toHaveAttribute('type', 'text');
  }).toPass({ timeout: 15_000 });
  await page
    .getByRole('textbox', { name: 'Password' })
    .fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).press('Enter');
  await expect(page).toHaveURL(/\/(dashboard|pharmacy)/);
  await page.goto('/pharmacy/counter');
  await expect(page.getByRole('heading', { name: 'Counter', exact: true })).toBeVisible();
}
async function locale(page: Page, value: Locale) {
  const current = (await page.locator('html').getAttribute('lang')) === 'ur' ? 'ur' : 'en';
  await page.getByLabel(labels[current].language, { exact: true }).selectOption(value);
  await expect(page.locator('html')).toHaveAttribute('lang', value);
  await expect(page.locator('html')).toHaveAttribute('dir', value === 'ur' ? 'rtl' : 'ltr');
  await expect(page.getByLabel(labels[value].language, { exact: true })).toHaveValue(value);
}
async function stage(
  page: Page,
  value: Locale,
  query: string = PHARMACY_E2E.medicines.otc.brandName
) {
  const scan = page.getByLabel(labels[value].scan, { exact: true });
  await scan.fill(query);
  await scan.press('Enter');
  const results = page.getByRole('list', {
    name: value === 'ur' ? 'تلاش کے نتائج' : 'Search results',
  });
  await results
    .getByRole('button')
    .filter({ hasText: PHARMACY_E2E.medicines.otc.name })
    .first()
    .press('Space');
}
async function bill(page: Page, value: Locale) {
  await expect(page.getByRole('button', { name: labels[value].drawer, exact: true })).toBeEnabled();
  await page.getByRole('button', { name: labels[value].drawer, exact: true }).press('Enter');
  await stage(page, value);
  await page.keyboard.press('F4');
  await page.keyboard.press('F6');
  await expect(page.getByRole('table', { name: labels[value].cart })).toContainText(
    PHARMACY_E2E.medicines.otc.name
  );
  await page.getByLabel(labels[value].scan, { exact: true }).focus();
  await page.keyboard.press('F9');
  await page.getByLabel(labels[value].amount, { exact: true }).fill('25.00');
  await page.getByLabel(labels[value].cash, { exact: true }).fill('100.00');
}
async function mutation(page: Page, name: string, input: unknown) {
  return page.request.post('/api/trpc/' + name, { data: { json: input } });
}

test('Urdu aliases require catalogue access, save through the editor and remain searchable', async ({
  page,
}) => {
  await signIn(page);
  const input = { medicineId: PHARMACY_E2E.medicines.otc.id, value: 'پیراسٹامول' };
  expect((await mutation(page, 'pharmacyMedicine.addUrduAlias', input)).status()).toBe(403);
  const db = new pg.Client({ connectionString: process.env.PHARMACY_E2E_DATABASE_URL! });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      "SELECT set_config('app.current_organization_id',$1,true), set_config('app.is_platform_admin','false',true)",
      [PHARMACY_E2E.organizationId]
    );
    expect(
      (
        await db.query(
          'SELECT count(*)::int AS count FROM pharmacy_medicine_aliases WHERE "medicineId"=$1 AND type=\'URDU\'',
          [input.medicineId]
        )
      ).rows[0].count
    ).toBe(0);
    await db.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:catalogue-review','ALLOW') ON CONFLICT ("organizationRoleId",capability) DO UPDATE SET effect='ALLOW'`,
      ['locale-catalogue', PHARMACY_E2E.organizationId, PHARMACY_E2E.roleId]
    );
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
  await page.goto('/pharmacy/medicines');
  const connectors = page
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: 'Medicine reference connectors' }) });
  await connectors.evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await expect(connectors).toHaveAttribute('open', '');
  await page
    .getByLabel('Medicine name', { exact: true })
    .fill(PHARMACY_E2E.medicines.otc.brandName);
  await page.getByRole('button', { name: 'Find medicine', exact: true }).press('Enter');
  await page
    .getByRole('combobox', { name: 'Medicine', exact: true })
    .selectOption(input.medicineId);
  await page.getByLabel('Urdu medicine alias').fill(input.value);
  await page.getByRole('button', { name: 'Save Urdu alias', exact: true }).press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Urdu alias saved.' })).toBeVisible();
  const duplicate = await mutation(page, 'pharmacyMedicine.addUrduAlias', input);
  expect(duplicate.ok()).toBe(true);
  expect(
    (
      await mutation(page, 'pharmacyMedicine.addUrduAlias', {
        ...input,
        medicineId: 'not-this-tenant-medicine',
      })
    ).status()
  ).toBe(404);
  await page.goto('/pharmacy/counter');
  await stage(page, 'en', 'پیرا');
  await expect(page.getByText(input.value, { exact: true })).toHaveAttribute('lang', 'ur');
  await expect(page.getByText(input.value, { exact: true })).toHaveAttribute('dir', 'rtl');
});

test('locale switching persists real document direction and renders the counter without overflow', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /MISSING_MESSAGE|INVALID_MESSAGE|hydration/i.test(message.text())
    )
      errors.push(message.text());
  });
  await signIn(page);
  await stage(page, 'en');
  await page.keyboard.press('F4');
  await page.keyboard.press('F6');
  await expect(page.getByRole('table', { name: labels.en.cart })).toContainText(
    PHARMACY_E2E.medicines.otc.name
  );
  for (const value of ['ur', 'en'] as const) {
    await locale(page, value);
    const response = await page.request.get('/pharmacy/counter');
    expect(await response.text()).toMatch(
      new RegExp(`<html[^>]*lang="${value}"[^>]*dir="${value === 'ur' ? 'rtl' : 'ltr'}"`)
    );
    for (const width of [375, 768, 1024, 1280, 1440])
      for (const height of [720, 900])
        for (const theme of ['light', 'dark'])
          for (const reducedMotion of ['no-preference', 'reduce'] as const) {
            await page.setViewportSize({ width, height });
            await page.emulateMedia({ reducedMotion });
            await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
            await expect(
              page.getByRole('heading', { name: labels[value].title, exact: true })
            ).toBeVisible();
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
            ).toBe(true);
            if (value === 'ur') {
              await page.evaluate(async () => {
                await document.fonts.load('14px "Noto Nastaliq Urdu"');
              });
              expect(
                await page.evaluate(() =>
                  [...document.fonts].some(
                    (face) =>
                      face.family.replace(/["']/g, '') === 'Noto Nastaliq Urdu' &&
                      face.status === 'loaded'
                  )
                )
              ).toBe(true);
            }
            if (reducedMotion === 'reduce' && [375, 1440].includes(width))
              await page.screenshot({
                path: info.outputPath(`${value}-${width}-${height}-${theme}.png`),
              });
          }
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(errors).toEqual([]);
});

test('an Urdu cashier completes the same cash tender and receives localized totals', async ({
  page,
}) => {
  await signIn(page);
  await locale(page, 'ur');
  await bill(page, 'ur');
  await page.getByRole('button', { name: labels.ur.pay, exact: true }).press('Enter');
  const receipt = page.getByRole('region', { name: /^رسید [۰-۹]+$/ });
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText('۲۵.۰۰');
  await expect(receipt).toContainText('۷۵.۰۰');
  await expect(receipt).toHaveAttribute('dir', 'rtl');
  await expect(receipt).toContainText(PHARMACY_E2E.medicines.otc.name);
});

test('switching locale during an uncertain tender preserves one payment attempt', async ({
  page,
}) => {
  await signIn(page);
  await bill(page, 'en');
  let release!: () => void;
  let entered!: () => void;
  let requests = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route('**/api/trpc/pharmacySales.tender*', async (route) => {
    if (
      route.request().method() === 'POST' &&
      /\/pharmacySales\.tender(?:\?|$)/.test(route.request().url())
    ) {
      requests++;
      entered();
      await held;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: labels.en.pay, exact: true }).press('Enter');
  await observed;
  try {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await locale(page, 'ur');
    expect(requests).toBe(1);
  } finally {
    release();
  }
  await expect(page.getByRole('region', { name: /^رسید [۰-۹]+$/ })).toBeVisible();
  expect(requests).toBe(1);
});
