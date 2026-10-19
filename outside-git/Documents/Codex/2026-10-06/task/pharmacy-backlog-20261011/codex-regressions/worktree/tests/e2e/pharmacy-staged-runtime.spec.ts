import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Client } from 'pg';
import { readFile } from 'node:fs/promises';
import { PHARMACY_E2E as fixture } from './pharmacy-counter-fixture';
import { resolvePharmacyE2eDatabaseUrl } from '../../scripts/pharmacy-e2e-environment';
import { waitForLoginHydrated } from './fixtures/login-hydration';
async function tenant(work: (db: Client) => Promise<void>) {
  const url = new URL(resolvePharmacyE2eDatabaseUrl());
  if (url.hostname !== '127.0.0.1' || Number(url.port) < 55600 || Number(url.port) > 55699)
    throw new Error('Runtime proof requires an isolated disposable pharmacy lane');
  const db = new Client({ connectionString: url.href });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      "SELECT set_config('app.current_organization_id',$1,true), set_config('app.is_platform_admin','false',true)",
      [fixture.organizationId]
    );
    await work(db);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

async function login(page: Page, email = process.env.PHARMACY_E2E_ADMIN_EMAIL!) {
  await page.goto('/login');
  await waitForLoginHydrated(page);
  await page.getByLabel('Email').fill(email);
  await page
    .getByRole('textbox', { name: 'Password' })
    .fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).press('Enter');
  await expect(page).toHaveURL(/\/(dashboard|pharmacy)/, { timeout: 30_000 });
  await page.goto('/pharmacy/counter');
  await expect(page.getByRole('heading', { name: 'Counter', exact: true })).toBeVisible();
}

const source = 'operations_synthetic_source';
const batch = 'operations_synthetic_batch';
const hash = 'c'.repeat(64);
const review = `/pharmacy/medicines/staged?branchId=${fixture.branchId}&sourceId=${source}&batchId=${batch}`;

test.beforeAll(async () => {
  await tenant(async (db) => {
    await db.query(
      `INSERT INTO pharmacy_migration_sources
      (id,"organizationId",kind,"fileName","byteSize","contentHash")
      VALUES ($1,$2,'EXCEL_CSV','synthetic-runtime.csv',0,$3) ON CONFLICT(id) DO NOTHING`,
      [source, fixture.organizationId, hash]
    );
    await db.query(
      `INSERT INTO pharmacy_migration_batches
      (id,"organizationId","sourceId",label,status,"profilerVersion","profiledAt","updatedAt")
      VALUES ($1,$2,$3,'Synthetic runtime','PROFILED','synthetic',now(),now()) ON CONFLICT(id) DO NOTHING`,
      [batch, fixture.organizationId, source]
    );
    for (let n = 1; n <= 27; n++) {
      const raw = {
        Name: `Runtime synthetic ${n}`,
        QTY: '9007199254740993.0000',
        PackQty: '001.0000',
        PackUnits: '010',
        saleprice: '0007.5000',
        __source_sha256: hash,
      };
      await db.query(
        `INSERT INTO pharmacy_migration_rows
        (id,"organizationId","batchId","sourceKey","rowNumber","rawPayload","targetModelKey","productName")
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,'med.product',$7) ON CONFLICT(id) DO NOTHING`,
        [
          `operations_synthetic_row_${n}`,
          fixture.organizationId,
          batch,
          `synthetic:${n}`,
          n,
          JSON.stringify(raw),
          raw.Name,
        ]
      );
    }
  });
});

test('authenticated staged review preserves labels, pagination, export and reload', async ({
  page,
}) => {
  await login(page);
  await page.goto(review);
  await expect(page.getByRole('heading', { name: 'Staged medicines', exact: true })).toBeVisible();
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(25);
  await expect(
    page.getByRole('heading', { name: 'All open exceptions in this batch' })
  ).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export this page’s references' }).press('Enter');
  const download = await downloaded;
  const file = await download.path();
  expect(file).not.toBeNull();
  const csv = await readFile(file!, 'utf8');
  expect(csv).toContain('9007199254740993.0000');
  expect(csv).toContain('0007.5000');
  await page.getByRole('link', { name: 'Next', exact: true }).press('Enter');
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
  await page.reload();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await page.getByRole('table').getByRole('link').first().press('Enter');
  await expect(page.getByText('Source SHA256 recorded on row', { exact: true })).toBeVisible();
  await page.goto(`${review}&query=absent-synthetic-name`);
  await expect(
    page.getByText('No candidates match. Clear the search or choose another batch.')
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export this page’s references' })).toBeDisabled();
});

test('staged review viewport, theme, reduced motion, keyboard and accessibility matrix', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const findings: Array<{ width: number; theme: string; motion: string; violations: unknown[] }> =
    [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ reducedMotion });
        await page.goto(review);
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
          localStorage.setItem('theme', value);
        }, theme);
        await expect(
          page.getByRole('heading', { name: 'Staged medicines', exact: true })
        ).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        const search = page.getByRole('textbox', { name: 'Name, legacy code or source key' });
        await search.focus();
        await expect(search).toBeFocused();
        await page.screenshot({
          path: testInfo.outputPath(`staged-${width}-${theme}-${reducedMotion}.png`),
          fullPage: true,
        });
        const scan = await new AxeBuilder({ page }).analyze();
        findings.push({ width, theme, motion: reducedMotion, violations: scan.violations });
      }
    }
  }
  await testInfo.attach('staged-accessibility-matrix', {
    body: JSON.stringify(findings, null, 2),
    contentType: 'application/json',
  });
  expect(errors).toEqual([]);
  expect(findings.flatMap((result) => result.violations)).toEqual([]);
});
