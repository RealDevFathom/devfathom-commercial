import { expect, test, type Page } from '@playwright/test';

import { AGENCY_E2E } from './agency-fixture';

test.describe.configure({ mode: 'serial' });

if (process.env.AGENCY_E2E !== '1') throw new Error('AGENCY_E2E=1 is required.');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.AGENCY_E2E_ADMIN_EMAIL!);
  await page
    .getByRole('textbox', { name: 'Password' })
    .fill(process.env.AGENCY_E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByText('Choose a workspace', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Northstar Agency E2E/i }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/);
  await expect(page.getByText('Northstar Agency E2E', { exact: true })).toBeVisible();
}

test('onboarding selection and dashboard navigation retain the Agency tenant', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { name: /Agency Gate Admin/ })).toBeVisible();
  await expect(page.getByText('Active Projects', { exact: true })).toBeVisible();
  for (const route of [
    '/clients',
    '/projects',
    '/team',
    '/meetings',
    '/finance',
    '/team/stats',
    '/settings',
  ]) {
    await expect(page.locator(`a[href="${route}"]`).first()).toBeVisible();
  }
});

test('clients expose owned tenant data and a working search state', async ({ page }) => {
  await signIn(page);
  await page.goto('/clients');
  await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
  await expect(page.getByText('Atlas Labs E2E')).toBeVisible();
  await page.getByPlaceholder('Search clients...').fill('missing-owned-client');
  await expect(page.getByText('No clients found')).toBeVisible();
});

test('projects and tasks resolve the exact owned board', async ({ page }) => {
  await signIn(page);
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByText('Atlas Launch E2E')).toBeVisible();
  await page.goto(`/projects/${AGENCY_E2E.projectId}/board/${AGENCY_E2E.boardId}`);
  await expect(page.getByText('Delivery Board', { exact: true })).toBeVisible();
  await expect(page.getByText('Ship Agency acceptance gate', { exact: true })).toBeVisible();
});

test('team and custom roles are visible to the Agency administrator', async ({ page }) => {
  await signIn(page);
  await page.goto('/team');
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
  await expect(page.getByText('Agency Gate Admin')).toBeVisible();
  await page.getByPlaceholder('Search by name or role...').fill('Agency Administrator');
  await expect(page.getByText('Agency Administrator')).toBeVisible();
  await page.goto('/organization');
  await expect(page.getByText('Custom roles', { exact: true })).toBeVisible();
  await expect(page.getByText('Delivery Lead', { exact: true })).toBeVisible();
});

test('meetings expose only the owned scheduled meeting', async ({ page }) => {
  await signIn(page);
  await page.goto('/meetings');
  await expect(page.getByRole('heading', { name: 'Meetings' })).toBeVisible();
  await expect(page.getByText('Atlas launch review E2E', { exact: true })).toBeVisible();
});

test('finance exposes the owned transaction and invoice surface', async ({ page }) => {
  await signIn(page);
  await page.goto('/finance');
  await expect(page.getByRole('heading', { name: 'Finance' })).toBeVisible();
  await expect(page.getByText('Atlas launch deposit E2E')).toBeVisible();
  await page.getByRole('tab', { name: 'Invoices' }).click();
  await expect(page.getByText('AGENCY-E2E-001')).toBeVisible();
});

test('Insights and reports calculate from the owned Agency work state', async ({ page }) => {
  await signIn(page);
  await page.goto('/team/stats');
  await expect(page.getByRole('heading', { name: 'Team Insights' })).toBeVisible();
  await expect(page.getByText('Agency Gate Admin')).toBeVisible();
  await expect(page.getByText(/with active work/i)).toBeVisible();
});

test('disabled integrations are honest and Restaurant-only surfaces do not leak', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'API access disabled' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Webhooks disabled' })).toBeDisabled();
  await expect(page.locator('a[href^="/restaurant"]')).toHaveCount(0);

  await page.goto('/restaurant/orders');
  await expect(page).not.toHaveURL(/\/restaurant\/orders/);
  await expect(page.getByText('Northstar Agency E2E', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Restaurant/i })).toHaveCount(0);
});
