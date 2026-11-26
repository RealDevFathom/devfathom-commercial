import { expect, test, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

type Workspace = { slug: string; password: string; approvalPin: string; group: string };

async function signIn(browser: Browser, workspace: Workspace, role: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const port = Number(process.env.PLAYWRIGHT_PORT ?? 3124);
  await page.goto(`http://${workspace.slug}.localhost:${port}/login`);
  await page.locator('input[name=email]').fill(role + '@' + workspace.group + '.example.test');
  await page.locator('input[name=password]').fill(workspace.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const link = page.getByRole('link', { name: /Medicine catalog$/ });
  const stock = page.getByRole('button', { name: 'Stock', exact: true });
  await expect(link.or(stock).first()).toBeVisible();
  if (!(await link.isVisible())) await stock.click();
  await link.click();
  await expect(
    page.getByRole('heading', { name: 'Catalogue edits awaiting approval' })
  ).toBeVisible();
  if (role.startsWith('owner')) await page.getByRole('link', { name: /^Import history/ }).click();
  return page;
}

async function submitFile(editor: Page, name: string) {
  const csv = `Product name,Units per pack,MRP,Purchase price\n${name} Tablet,10,30.00,21.00\n`;
  await editor.getByLabel('Source file', { exact: true }).setInputFiles({
    name: name + '.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await editor.getByRole('button', { name: 'Stage for review' }).click();
  await expect(editor.getByRole('link', { name: name + ' Tablet', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Ask to create 1 medicines' }).click();
  await expect(editor.getByText('Waiting for approval', { exact: true })).toBeVisible();
}

const scenarios = [
  { name: 'pharmacist', reviewer: 'pharmacist', members: ['owner', 'pharmacist'] },
  {
    name: 'pharmacist-cashier',
    reviewer: 'pharmacist-cashier',
    members: ['owner', 'pharmacist-cashier'],
  },
  { name: 'owner-operator', reviewer: 'owner-operator', members: ['owner', 'owner-operator'] },
  { name: 'solo', reviewer: 'owner', members: ['owner'] },
  { name: 'pair', reviewer: 'owner2', members: ['owner', 'owner2'] },
];

for (const scenario of scenarios) {
  test(`${scenario.name} reviews a proposed import and completes the existing decision workflow`, async ({
    browser,
  }) => {
    const workspace: Workspace = {
      group: scenario.name,
      ...JSON.parse(
        execFileSync('bun', [join(__dirname, 'fixture.ts'), scenario.name, ...scenario.members], {
          encoding: 'utf8',
        })
      ),
    };
    const editor = await signIn(browser, workspace, 'owner');
    const reviewer =
      scenario.reviewer === 'owner' ? editor : await signIn(browser, workspace, scenario.reviewer);
    const member = scenario.reviewer.startsWith('pharmacist');
    try {
      for (const decision of ['Approve', 'Reject'] as const) {
        const name = scenario.name + '-' + decision;
        await submitFile(editor, name);
        const acting = scenario.name === 'pair' && decision === 'Reject' ? editor : reviewer;
        await acting.reload();
        const article = acting.locator('article').filter({ hasText: name + '.csv' });
        await expect(article).toBeVisible();
        if (member) {
          await expect(acting.getByLabel('Source file')).toHaveCount(0);
          await expect(
            acting.getByText('Medicine reference connectors', { exact: true })
          ).toHaveCount(0);
          await article.getByRole('button', { name: 'Review proposed medicines' }).click();
          await expect(article.getByText(name + ' Tablet', { exact: true })).toBeVisible();
          await article.getByText('Medicine details', { exact: true }).click();
          await expect(article.getByText('Rs 30.00')).toBeVisible();
          await expect(article.getByText(/purchase price/i)).toHaveCount(0);
        } else {
          await acting
            .getByRole('link', { name: name + '.csv · ' + name + '.csv', exact: true })
            .click();
          await acting.getByRole('link', { name: name + ' Tablet', exact: true }).click();
          await expect(acting.getByRole('link', { name: 'Close detail' })).toBeVisible();
        }
        if (scenario.name === 'pair' && decision === 'Approve') {
          await editor.reload();
          const own = editor.locator('article').filter({ hasText: name + '.csv' });
          await expect(own.getByRole('note')).toHaveText(
            'You submitted this edit, so another reviewer must approve it. Ask pair owner2 to approve this.'
          );
          await expect(own.getByRole('button', { name: 'Approve edit' })).toHaveCount(0);
        }
        if (decision === 'Approve' && (scenario.name === 'pair' || scenario.name === 'solo')) {
          await expect(article.getByRole('button', { name: 'Approve edit' })).toBeDisabled();
          await acting
            .getByLabel('Solo owner PIN (for self-approval)', { exact: true })
            .fill(workspace.approvalPin);
        }
        await article.getByRole('button', { name: decision + ' edit' }).click();
        await expect(
          acting.getByText(decision === 'Approve' ? 'Edit approved.' : 'Edit rejected.', {
            exact: true,
          })
        ).toBeVisible();
        if (decision === 'Approve') {
          await acting.reload();
          await expect(
            acting.getByRole('button', { name: 'Create medicines', exact: true })
          ).toBeVisible();
          await acting.getByRole('button', { name: 'Create medicines', exact: true }).click();
          await expect(acting.getByText('All medicines created', { exact: true })).toBeVisible();
        }
      }
    } finally {
      if (reviewer !== editor) await reviewer.close();
      await editor.close();
    }
  });
}

test('prepared Abuzar import holds controlled placeholder stock and balances the books once', async ({
  browser,
}) => {
  const { Client } = await import('pg');
  const { syntheticExport } = await import('../fixtures/abuzar-prepared');
  const { readdir, readFile } = await import('node:fs/promises');
  const group = 'abuzar' + Date.now().toString(36);
  const workspace: Workspace = {
    group,
    ...JSON.parse(
      execFileSync('bun', [join(__dirname, 'fixture.ts'), group, 'owner', 'pharmacist'], {
        encoding: 'utf8',
      })
    ),
  };
  const owner = await signIn(browser, workspace, 'owner');
  const origin = new URL(owner.url()).origin;
  const directory = await syntheticExport();
  const files = await readdir(directory);
  const db = new Client({ connectionString: process.env.PHARMACY_E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.current_organization_id',$1,false)", [workspace.slug]);
    const branch = (
      await db.query<{ id: string }>('SELECT id FROM pharmacy_branches WHERE "organizationId"=$1', [
        workspace.slug,
      ])
    ).rows[0]!.id;
    const location = 'shelf-' + branch;
    await db.query(
      'INSERT INTO pharmacy_stock_locations(id,"organizationId","branchId",code,name,kind,"updatedAt") VALUES($1,$2,$3,\'QA\',\'Synthetic shelf\',\'STORE\',now())',
      [location, workspace.slug, branch]
    );
    await db.query(
      'INSERT INTO pharmacy_accounting_periods(id,"organizationId","branchId","startsAt","endsAt",status) VALUES($1,$2,$3,\'2026-11-01\',\'2026-12-01\',\'OPEN\')',
      ['period-' + branch, workspace.slug, branch]
    );
    await db.query('COMMIT');
    await owner.goto(origin + '/pharmacy/inventory/import');
    await owner
      .getByLabel('Prepared export files')
      .setInputFiles(files.map((name) => join(directory, name)));
    await owner.getByLabel('Source branch code').fill('B1');
    await owner.getByRole('button', { name: 'Preview step' }).click();
    await expect(owner.getByRole('heading', { name: 'Review totals' })).toBeVisible();
    await owner.getByRole('button', { name: 'Confirm totals and apply' }).click();
    await owner.getByRole('link', { name: 'Review the staged catalogue' }).click();
    await owner.getByRole('button', { name: /Ask to create 2 medicines/ }).click();
    await expect(owner.getByText('Waiting for approval', { exact: true })).toBeVisible();
    const reviewer = await signIn(browser, workspace, 'pharmacist');
    const review = reviewer
      .locator('article')
      .filter({ hasText: /Imported from Abuzar|products.csv/ });
    await review.getByRole('button', { name: 'Approve edit' }).click();
    await expect(reviewer.getByText('Edit approved.', { exact: true })).toBeVisible();
    await reviewer.reload();
    await reviewer.getByRole('button', { name: 'Create medicines', exact: true }).click();
    await expect(reviewer.getByText('All medicines created', { exact: true })).toBeVisible();

    async function run(step: string, confirmed?: string) {
      const financial = step === 'stock' || step === 'balances';
      const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> =
        {
          selection: JSON.stringify({
            branchId: branch,
            step,
            sourceBranch: 'B1',
            addToExisting: false,
            confirmed,
            ...(financial ? { cutover: '2026-11-26' } : {}),
            ...(step === 'stock'
              ? { stockLocationId: location, witnessId: workspace.slug + '-pharmacist' }
              : {}),
          }),
        };
      if (step === 'stock' && confirmed) multipart.witnessSecret = workspace.approvalPin;
      for (const name of files)
        multipart[name] = {
          name,
          mimeType: 'application/octet-stream',
          buffer: await readFile(join(directory, name)),
        };
      const response = await owner.request.post(origin + '/api/pharmacy/abuzar-import', {
        headers: { origin },
        multipart,
      });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    }
    const snapshot = async () =>
      (
        await db.query(`SELECT
      (SELECT count(*)::int FROM finance_journal_entries) AS journals,
      (SELECT count(*)::int FROM pharmacy_sales) AS sales,
      (SELECT count(*)::int FROM pharmacy_controlled_register_entries WHERE "entryKind"::text='OPENING') AS controlled,
      (SELECT count(*)::int FROM pharmacy_manufacturing_batches WHERE state='QUARANTINED' AND "batchNumber" IS NULL AND "expiresAt" IS NULL AND "stateChangedAt" IS NOT NULL) AS held,
      (SELECT count(*)::int FROM pharmacy_abuzar_history) AS archive,
      (SELECT sum(CASE WHEN side='DEBIT' THEN "amountMinor" ELSE -"amountMinor" END)::text FROM finance_journal_lines) AS net,
      (SELECT md5(string_agg(t::text,',' ORDER BY t."sourceId")) FROM pharmacy_abuzar_openings t) AS checksum`)
      ).rows[0];
    expect(await snapshot()).toMatchObject({ journals: 0, controlled: 0, held: 0, archive: 0 });
    for (const [step, count] of Object.entries({
      parties: 1,
      prices: 2,
      stock: 1,
      balances: 1,
      history: 1,
    })) {
      const before = await snapshot();
      const dry = await run(step);
      expect(await snapshot()).toEqual(before);
      expect(dry.create).toBe(count);
      expect((await run(step, dry.confirmation)).applied).toBe(count);
      const after = await snapshot();
      expect((await run(step, dry.confirmation)).applied).toBe(0);
      expect(await snapshot()).toEqual(after);
    }
    const result = await run('reconcile');
    expect(result.actual).toEqual(result.expected);
    expect(result.actual).toEqual({
      products: 2,
      stockUnits: '23',
      stockValueMinor: '4600',
      customerBalanceMinor: '1250',
      supplierBalanceMinor: '0',
    });
    expect(result.differences.map((d: { reason: string }) => d.reason)).toEqual([
      'negative quantity',
      'fractional quantity',
    ]);
    expect(await snapshot()).toMatchObject({
      journals: 2,
      sales: 0,
      controlled: 1,
      held: 1,
      archive: 1,
      net: '0',
      checksum: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
  } finally {
    await db.end();
  }
});
