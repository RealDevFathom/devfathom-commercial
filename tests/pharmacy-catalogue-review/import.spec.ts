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
          if (!member) await acting.reload();
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
