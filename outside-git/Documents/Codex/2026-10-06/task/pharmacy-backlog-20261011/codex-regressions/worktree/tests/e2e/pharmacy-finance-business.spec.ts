import { randomUUID } from 'node:crypto';
import { expect, test, type Request } from '@playwright/test';
import { Client } from 'pg';
import { createTRPCClient, httpLink } from '@trpc/client';
import superjson from 'superjson';
import type { AppRouter } from '../../src/server/routers/_app';
import { resolvePharmacyE2eDatabaseUrl } from '../../scripts/pharmacy-e2e-environment';
import { PHARMACY_E2E as fixture } from './pharmacy-counter-fixture';
import { waitForLoginHydrated } from './fixtures/login-hydration';

function observedInput<T>(request: Request, procedure: string): T {
  const url = new URL(request.url());
  const payload = JSON.parse(request.postData()!);
  const index = url.pathname.split('/').at(-1)!.split(',').indexOf(procedure);
  const serialized = url.searchParams.get('batch') === '1' ? payload[String(index)] : payload;
  if (!serialized || !('json' in serialized)) throw new Error('Expected real tRPC input envelope');
  return superjson.deserialize<T>(serialized);
}

test('pharmacy Finance normal login posts once; revoked license denies API writes and standalone page', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const url = new URL(resolvePharmacyE2eDatabaseUrl());
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '55625' ||
    url.pathname !== '/wha1364_business_disposable_20261008' ||
    baseURL !== 'http://127.0.0.1:4333'
  )
    throw new Error('Dedicated synthetic pharmacy business lane required');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login');
  await waitForLoginHydrated(page);
  await page.getByLabel('Email').fill(process.env.PHARMACY_E2E_ADMIN_EMAIL!);
  await page
    .getByRole('textbox', { name: 'Password' })
    .fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).press('Enter');
  await expect(page).toHaveURL(/\/(dashboard|pharmacy)/, { timeout: 30_000 });
  const api = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${baseURL}/api/trpc`,
        transformer: superjson,
        fetch: async (url, options) => {
          const result = await page.request.fetch(String(url), {
            method: options?.method,
            headers: options?.headers as Record<string, string>,
            data: options?.body as string | undefined,
          });
          return new Response(await result.text(), {
            status: result.status(),
            headers: result.headers(),
          });
        },
      }),
    ],
  });
  const branchId = fixture.branchId;
  await api.pharmacyFinance.workspace.query({ branchId });
  const input = {
    branchId,
    reference: `Synthetic-${randomUUID()}`,
    kind: 'EXPENSE' as const,
    amountMinor: 100,
    occurredAt: new Date(),
    fundingAccount: 'CASH' as const,
    idempotencyKey: randomUUID(),
    allocations: [],
  };
  const posted = await api.pharmacyFinance.post.mutate(input);
  expect((await api.pharmacyFinance.post.mutate(input)).id).toBe(posted.id);
  await page.goto(`/pharmacy/finance?branch=${branchId}`);
  await expect(page.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();
  await expect(page.getByText(input.reference, { exact: true })).toBeVisible();
  const formReference = `Form-${randomUUID()}`;
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Post transaction', exact: true }) });
  await form.getByRole('combobox', { name: 'Workflow', exact: true }).selectOption('EXPENSE');
  await form.getByLabel('Reference', { exact: true }).fill(formReference);
  await form.getByLabel('Amount (PKR)', { exact: true }).fill('1.23');
  await form
    .getByRole('combobox', { name: 'Pay from / receive into', exact: true })
    .selectOption('CASH');
  await form.getByRole('button', { name: 'Post transaction', exact: true }).click();
  await expect(page.getByText(formReference, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(formReference, { exact: true })).toBeVisible();
  const db = new Client({ connectionString: url.href });
  await db.connect();
  const overrideId = `finance-revoked-${randomUUID()}`;
  try {
    await db.query('BEGIN');
    await db.query(
      "SELECT set_config('app.current_organization_id',$1,true),set_config('app.is_platform_admin','false',true)",
      [fixture.organizationId]
    );
    const formRows = await db.query(
      'SELECT "amountMinor",kind FROM pharmacy_bookkeeping_transactions WHERE reference=$1',
      [formReference]
    );
    expect(formRows.rows).toEqual([{ amountMinor: 123, kind: 'EXPENSE' }]);
    await db.query('COMMIT');
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.is_platform_admin','true',true)");
    await db.query(
      `INSERT INTO organization_modules (id,"organizationId","moduleId",status,"updatedAt") SELECT $1,$2,id,'DISABLED',now() FROM platform_modules WHERE key='pharmacy-finance'`,
      [overrideId, fixture.organizationId]
    );
    await db.query('COMMIT');
    await expect(api.pharmacyFinance.workspace.query({ branchId })).rejects.toThrow();
    const refused = {
      ...input,
      idempotencyKey: randomUUID(),
      reference: `Refused-${randomUUID()}`,
    };
    await expect(api.pharmacyFinance.post.mutate(refused)).rejects.toThrow();
    // Reports-only licensing remains usable through the separate report procedure.
    const now = new Date();
    await api.pharmacyFinance.grossMargin.query({
      branchId,
      from: new Date(now.getTime() - 86_400_000).toISOString(),
      to: new Date(now.getTime() + 86_400_000).toISOString(),
      by: 'branch',
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'This module is not enabled' })).toBeVisible();
    await expect(page.getByText(input.reference, { exact: true })).toHaveCount(0);
    await db.query('BEGIN');
    await db.query(
      "SELECT set_config('app.current_organization_id',$1,true),set_config('app.is_platform_admin','false',true)",
      [fixture.organizationId]
    );
    const count = await db.query(
      'SELECT count(*)::int AS count FROM pharmacy_bookkeeping_transactions WHERE "idempotencyKey"=$1',
      [refused.idempotencyKey]
    );
    expect(count.rows[0].count).toBe(0);
    await db.query('COMMIT');
    await page.screenshot({
      path: testInfo.outputPath('finance-license-denial.png'),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await db.query('ROLLBACK');
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.is_platform_admin','true',true)");
    await db.query('DELETE FROM organization_modules WHERE id=$1 AND "organizationId"=$2', [
      overrideId,
      fixture.organizationId,
    ]);
    await db.query('COMMIT');
    await db.end();
  }
});

test('sandbox card form preserves unknown identity and records distinct equal payments and refunds', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(300_000);
  const url = new URL(resolvePharmacyE2eDatabaseUrl());
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '55625' ||
    url.pathname !== '/wha1364_business_disposable_20261008' ||
    baseURL !== 'http://127.0.0.1:4333'
  )
    throw new Error('Dedicated synthetic business lane required');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login');
  await waitForLoginHydrated(page);
  await page.getByLabel('Email').fill(process.env.PHARMACY_E2E_ADMIN_EMAIL!);
  await page
    .getByRole('textbox', { name: 'Password' })
    .fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).press('Enter');
  await expect(page).toHaveURL(/\/(dashboard|pharmacy)/, { timeout: 30_000 });
  const api = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${baseURL}/api/trpc`,
        transformer: superjson,
        fetch: async (url, options) => {
          const response = await page.request.fetch(String(url), {
            method: options?.method,
            headers: options?.headers as Record<string, string>,
            data: options?.body as string | undefined,
          });
          return new Response(await response.text(), {
            status: response.status(),
            headers: response.headers(),
          });
        },
      }),
    ],
  });
  const cameras = await api.pharmacyCameras.workspace.query();
  expect(cameras.availability).toMatchObject({ available: true, mode: 'simulated' });
  const cameraName = 'Synthetic business counter';
  const gateway = await api.pharmacyCameras.enrollGateway.mutate({
    branchId: fixture.branchId,
    name: cameraName,
    retentionDays: 7,
  });
  const camera = await api.pharmacyCameras.register.mutate({
    branchId: fixture.branchId,
    gatewayId: gateway.id,
    name: cameraName,
    sourceRef: 'sim-counter-1',
    username: 'diagnostic-simulator',
    password: 'synthetic-no-hardware',
  });
  await api.pharmacyCameras.configure.mutate({
    cameraId: camera.id,
    preset: 'COUNTER',
    enabled: true,
  });
  const patient = await api.pharmacyPrescriptions.createPatient.mutate({
    displayName: `Synthetic loyalty ${randomUUID()}`,
  });
  await api.pharmacyPrescriptions.recordConsent.mutate({
    patientId: patient.id,
    purpose: 'LOYALTY',
    channel: 'IN_PERSON',
    granted: true,
  });
  await page.goto('/pharmacy/counter');
  await expect(page.getByRole('heading', { name: 'Counter', exact: true })).toBeVisible();
  await page.getByLabel('Scan or search').fill(fixture.medicines.otc.barcode);
  await page.getByLabel('Scan or search').press('Enter');
  await page
    .getByRole('list', { name: 'Search results' })
    .getByRole('button')
    .filter({ hasText: fixture.medicines.otc.name })
    .first()
    .click();
  await page.keyboard.press('F4');
  await page.getByLabel('Quantity', { exact: true }).fill('1');
  await page.getByLabel('Quantity', { exact: true }).press('Tab');
  await page.keyboard.press('F6');
  await expect(page.getByRole('list', { name: 'Cart lines' })).toContainText(
    fixture.medicines.otc.name
  );
  await page.getByLabel('Find patient').fill(patient.displayName);
  await page.getByLabel('Find patient').press('Enter');
  await page.getByRole('button', { name: patient.displayName, exact: true }).click();
  await page.getByRole('button', { name: 'Link selected patient' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Loyalty customer linked' })
  ).toBeVisible();
  const panel = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Record sandbox operation', exact: true }) });
  await panel.getByLabel('Amount in minor units').fill('1250');
  await panel.getByLabel('Evidence reason').fill('Synthetic card evidence');
  await panel.getByLabel('Simulated evidence').selectOption('UNKNOWN');
  const requestPromise = page.waitForRequest(
    (request) =>
      request.url().includes('pharmacySales.sandboxPayment') && request.method() === 'POST'
  );
  await panel.getByRole('button', { name: 'Record sandbox operation', exact: true }).click();
  const request = await requestPromise;
  const original = observedInput<Parameters<typeof api.pharmacySales.sandboxPayment.mutate>[0]>(
    request,
    'pharmacySales.sandboxPayment'
  );
  await expect(panel.getByRole('status')).toContainText('UNKNOWN');
  await expect(panel.getByRole('button', { name: 'New sandbox operation' })).toBeDisabled();
  const db = new Client({ connectionString: url.href });
  await db.connect();
  const snapshot = async () => {
    await db.query('BEGIN');
    await db.query(
      "SELECT set_config('app.current_organization_id',$1,true),set_config('app.is_platform_admin','false',true)",
      [fixture.organizationId]
    );
    const tenders = await db.query(
      'SELECT id,"amountMinor" FROM pharmacy_tenders WHERE "saleId"=$1 ORDER BY id',
      [original.saleId]
    );
    const refunds = await db.query(
      'SELECT id,"amountMinor" FROM pharmacy_refunds WHERE "saleId"=$1 ORDER BY id',
      [original.saleId]
    );
    await db.query('COMMIT');
    return { tenders: tenders.rows, refunds: refunds.rows };
  };
  try {
    const before = await snapshot();
    expect(before.tenders).toEqual([]);
    await expect(
      api.pharmacySales.sandboxPayment.mutate({
        ...original,
        operationKey: randomUUID(),
        type: 'WALLET',
        amountMinor: 100,
        outcome: 'APPROVED',
      })
    ).rejects.toThrow('RECONCILIATION_REQUIRED');
    expect(await snapshot()).toEqual(before);
    await panel.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('RECONCILE');
    await panel.getByLabel('Simulated evidence').selectOption('APPROVED');
    await panel.getByRole('button', { name: 'Record sandbox operation', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('APPROVED');
    expect(
      (
        await api.pharmacySales.sandboxPayment.mutate({
          ...original,
          mode: 'RECONCILE',
          outcome: 'APPROVED',
        })
      ).replayed
    ).toBe(true);
    await panel.getByRole('button', { name: 'New sandbox operation' }).click();
    await panel.getByRole('button', { name: 'Record sandbox operation', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('APPROVED');
    const paid = await snapshot();
    expect(paid.tenders.map((row) => row.amountMinor)).toEqual([1250, 1250]);
    const receipt = await api.pharmacySales.counterReceipt.query({
      branchId: fixture.branchId,
      saleId: original.saleId,
    });
    expect(receipt.tenders).toHaveLength(2);
    await db.query('BEGIN');
    await db.query(
      "SELECT set_config('app.current_organization_id',$1,true),set_config('app.is_platform_admin','false',true)",
      [fixture.organizationId]
    );
    const earned = await db.query(
      'SELECT "customerId",points,"netPaidMinor",kind FROM pharmacy_loyalty_points_entries WHERE "saleId"=$1',
      [original.saleId]
    );
    await db.query('COMMIT');
    expect(earned.rows).toHaveLength(1);
    expect(earned.rows[0]).toMatchObject({ kind: 'EARN', points: 25, netPaidMinor: 2500 });

    const from = new Date(new Date().toISOString().slice(0, 10));
    const to = new Date(from.getTime() + 86_400_000);
    await db.query('BEGIN');
    await db.query(
      "SELECT set_config('app.current_organization_id',$1,true),set_config('app.is_platform_admin','false',true)",
      [fixture.organizationId]
    );
    const journal = await db.query(
      `SELECT line."accountCode",line.side,line."amountMinor" FROM finance_journal_lines line JOIN finance_journal_entries entry ON entry.id=line."entryId" AND entry."organizationId"=line."organizationId" WHERE line."branchId"=$1 AND entry."occurredAt">=$2 AND entry."occurredAt"<$3 AND line."accountCode" IN ('SALES_REVENUE','SALES_DISCOUNT','COST_OF_GOODS_SOLD')`,
      [fixture.branchId, from, to]
    );
    await db.query('COMMIT');
    const signed = (code: string) =>
      journal.rows
        .filter((row) => row.accountCode === code)
        .reduce((sum, row) => sum + (row.side === 'DEBIT' ? row.amountMinor : -row.amountMinor), 0);
    const revenue = -signed('SALES_REVENUE'),
      discount = signed('SALES_DISCOUNT'),
      cogs = signed('COST_OF_GOODS_SOLD');
    const margin = await api.pharmacyFinance.grossMargin.query({
      branchId: fixture.branchId,
      from: from.toISOString(),
      to: to.toISOString(),
      by: 'branch',
    });
    expect(margin.rows).toEqual([
      {
        key: fixture.branchId,
        revenueMinor: revenue,
        discountMinor: discount,
        cogsMinor: cogs,
        grossMarginMinor: revenue - discount - cogs,
      },
    ]);
    const financePage = await page.context().newPage();
    financePage.on('pageerror', (error) => errors.push(error.message));
    await financePage.goto(
      `/pharmacy/finance?branch=${fixture.branchId}&ledgerFrom=${from.toISOString().slice(0, 10)}&ledgerTo=${to.toISOString().slice(0, 10)}&ledgerBy=branch`
    );
    const marginRow = financePage
      .getByRole('table')
      .filter({
        has: financePage.locator('caption', { hasText: 'Gross margin grouped by branch' }),
      })
      .getByRole('row')
      .filter({ hasText: fixture.branchId });
    await expect(marginRow.getByRole('cell')).toHaveText([
      fixture.branchId,
      ...[revenue, discount, revenue - discount, cogs, revenue - discount - cogs].map(
        (minor) => `Currency unknown ${(minor / 100).toFixed(2)}`
      ),
    ]);
    await expect(
      financePage.getByRole('heading', { name: 'Ledger gross margin', exact: true, level: 2 })
    ).toBeVisible();
    await financePage.screenshot({
      path: testInfo.outputPath('finance-reconciled-margin.png'),
      fullPage: true,
    });
    await financePage.close();
    // Captured marketing is a retail sandbox workflow; no model or live provider call.
    // Synthetic global-channel consent setup only: no normal global-consent UI exists.
    // Match consent-writer.ts lock protocol: patient first, then its exact customer.
    // Purpose consent below still goes through the normal authenticated API.
    await db.query('BEGIN');
    await db.query(
      "SELECT set_config('app.current_organization_id',$1,true),set_config('app.is_platform_admin','false',true)",
      [fixture.organizationId]
    );
    const lockedPatient = await db.query(
      'SELECT id FROM pharmacy_patients WHERE "organizationId"=$1 AND id=$2 FOR UPDATE',
      [fixture.organizationId, patient.id]
    );
    expect(lockedPatient.rows).toEqual([{ id: patient.id }]);
    const customerId = earned.rows[0].customerId;
    const lockedCustomer = await db.query(
      'SELECT "patientId","whatsappOptIn","whatsappOptInChangedAt" FROM pharmacy_customers WHERE "organizationId"=$1 AND id=$2 AND active=true FOR UPDATE',
      [fixture.organizationId, customerId]
    );
    expect(lockedCustomer.rows).toEqual([
      { patientId: patient.id, whatsappOptIn: null, whatsappOptInChangedAt: null },
    ]);
    const ownedSale = await db.query(
      `SELECT "customerId" FROM pharmacy_sales WHERE "organizationId"=$1 AND "branchId"=$2 AND id=$3 AND status='COMPLETED'`,
      [fixture.organizationId, fixture.branchId, original.saleId]
    );
    expect(ownedSale.rows).toEqual([{ customerId }]);
    const syntheticOptInAt = new Date();
    const optedIn = await db.query(
      'UPDATE pharmacy_customers SET "whatsappOptIn"=true,"whatsappOptInChangedAt"=$4,"updatedAt"=$4 WHERE "organizationId"=$1 AND id=$2 AND "patientId"=$3 AND active=true AND "whatsappOptIn" IS NULL AND "whatsappOptInChangedAt" IS NULL RETURNING "whatsappOptIn","whatsappOptInChangedAt"',
      [fixture.organizationId, customerId, patient.id, syntheticOptInAt]
    );
    expect(optedIn.rows).toEqual([
      { whatsappOptIn: true, whatsappOptInChangedAt: syntheticOptInAt },
    ]);
    await db.query('COMMIT');
    await testInfo.attach('synthetic-global-channel-consent', {
      body: JSON.stringify({
        preparation: 'Scoped synthetic global WhatsApp opt-in; not global-consent UI proof',
        changedCustomers: optedIn.rowCount,
        priorFlag: null,
        priorTimestamp: null,
        optedInAt: syntheticOptInAt.toISOString(),
      }),
      contentType: 'application/json',
    });
    await api.pharmacyPrescriptions.recordConsent.mutate({
      patientId: patient.id,
      purpose: 'MARKETING',
      channel: 'WHATSAPP',
      granted: true,
    });
    const marketing = await api.pharmacyMarketing.history.query({ branchId: fixture.branchId });
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: marketing.timezone,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date())
    );
    const template = await api.pharmacyMarketing.approveTemplate.mutate({
      branchId: fixture.branchId,
      name: `Retail ${randomUUID()}`,
      body: 'Visit our retail counter. Reply STOP to opt out.',
      reviewed: true,
    });
    const campaign = await api.pharmacyMarketing.createDraft.mutate({
      branchId: fixture.branchId,
      templateId: template.id,
      name: `Sandbox ${randomUUID()}`,
      definition: { version: 1, all: [{ field: 'receiptCount', operator: 'gte', value: 1 }] },
      scheduledAt: new Date(Date.now() - 1000),
      quietHours: { startHour: (hour + 2) % 24, endHour: (hour + 3) % 24 },
      frequencyCap: { max: 1, windowDays: 1 },
      promotesRegulatedItem: false,
    });
    const marketingPage = await page.context().newPage();
    marketingPage.on('pageerror', (error) => errors.push(error.message));
    await marketingPage.goto(
      `/pharmacy/marketing?branch=${fixture.branchId}&campaign=${campaign.id}`
    );
    await marketingPage.getByRole('checkbox', { name: /I reviewed the copy/ }).check();
    await marketingPage.getByRole('button', { name: 'Approve campaign', exact: true }).click();
    await expect(marketingPage.getByRole('status').filter({ hasText: /approved/i })).toBeVisible();
    await marketingPage.reload();
    await marketingPage.getByRole('button', { name: 'Save prepared captures' }).click();
    await expect(
      marketingPage.getByRole('status').filter({ hasText: /capture|prepared/i })
    ).toBeVisible();
    const captured = await api.pharmacyMarketing.capture.mutate({
      branchId: fixture.branchId,
      campaignId: campaign.id,
    });
    expect(captured.replay).toBe(true);
    expect(captured.prepared).toBeGreaterThan(0);
    await marketingPage.reload();
    await marketingPage.getByRole('checkbox', { name: campaign.name, exact: true }).check();
    const batchKey = randomUUID();
    await marketingPage.getByLabel('Batch request key (reuse for replay)').fill(batchKey);
    await marketingPage.getByRole('button', { name: 'Run bounded sandbox batch' }).click();
    await expect(
      marketingPage.getByRole('status').filter({ hasText: 'processed 1 due captured campaigns' })
    ).toBeVisible();
    const beforeReplay = await api.pharmacyMarketing.deliveryHistory.query({
      branchId: fixture.branchId,
      campaignId: campaign.id,
    });
    await api.pharmacyMarketing.sandboxDue.mutate({
      branchId: fixture.branchId,
      campaignIds: [campaign.id],
      requestKey: batchKey,
    });
    expect(
      await api.pharmacyMarketing.deliveryHistory.query({
        branchId: fixture.branchId,
        campaignId: campaign.id,
      })
    ).toEqual(beforeReplay);
    const marketingReport = await api.pharmacyReports.marketing.query({
      branchId: fixture.branchId,
      from: from.toISOString().slice(0, 10),
      to: from.toISOString().slice(0, 10),
    });
    expect(marketingReport.sandbox.delivered).toBeGreaterThan(0);
    expect(marketingReport.providerAccepted).toBe(0);
    expect(marketingReport.delivered).toBe(0);
    await marketingPage.goto(
      `/pharmacy/reports?branch=${fixture.branchId}&from=${from.toISOString().slice(0, 10)}&to=${from.toISOString().slice(0, 10)}`
    );
    await expect(
      marketingPage.getByText(
        `Sandbox only: ${marketingReport.sandbox.captures} captures, ${marketingReport.sandbox.delivered} delivered, ${marketingReport.sandbox.failed} failed, ${marketingReport.sandbox.unknown} unknown. These counts do not prove live delivery.`
      )
    ).toBeVisible();
    await marketingPage.screenshot({
      path: testInfo.outputPath('marketing-sandbox-report.png'),
      fullPage: true,
    });
    await marketingPage.close();

    const cart = await api.pharmacySales.counterCart.query({
      branchId: fixture.branchId,
      saleId: original.saleId,
    });
    await api.pharmacySales.returnLine.mutate({
      branchId: fixture.branchId,
      saleLineId: cart.lines[0].saleLineId,
      canonicalUnits: 10,
      disposition: 'RESTOCK',
      reason: 'Synthetic intact return',
      integrityDecision: 'Sealed goods checked',
      idempotencyKey: randomUUID(),
    });
    await panel.getByRole('button', { name: 'New sandbox operation' }).click();
    await panel.getByRole('combobox', { name: 'Action', exact: true }).selectOption('REFUND');
    await panel.getByLabel('Original sandbox tender ID').fill(paid.tenders[0].id);
    await panel.getByLabel('Amount in minor units').fill('625');
    await panel.getByRole('button', { name: 'Record sandbox operation', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('APPROVED');
    await panel.getByRole('button', { name: 'New sandbox operation' }).click();
    await panel.getByRole('button', { name: 'Record sandbox operation', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('APPROVED');
    expect((await snapshot()).refunds.map((row) => row.amountMinor)).toEqual([625, 625]);
    await page.screenshot({
      path: testInfo.outputPath('sandbox-equal-refunds.png'),
      fullPage: true,
    });
    const cameraPage = await page.context().newPage();
    cameraPage.on('pageerror', (error) => errors.push(error.message));
    await cameraPage.goto('/pharmacy/cameras');
    const cameraCard = cameraPage
      .locator('article')
      .filter({ has: cameraPage.getByRole('heading', { name: cameraName, exact: true }) });
    await cameraCard.getByRole('button', { name: 'Open private evidence' }).click();
    const evidenceInput = { branchId: fixture.branchId, saleId: original.saleId };
    const requestedEvidence = await api.pharmacySales.counterEvidence.query(evidenceInput);
    expect(requestedEvidence).toHaveLength(4);
    const evidenceIds = requestedEvidence.map((row) => row.id).sort();
    expect(new Set(evidenceIds).size).toBe(4);
    const captureProcedure = 'pharmacyCameras.capturePending';
    const captureResponse = cameraPage.waitForResponse((response) => {
      const request = response.request();
      const url = new URL(response.url());
      return (
        request.method() === 'POST' &&
        url.pathname.startsWith('/api/trpc/') &&
        url.pathname.split('/').at(-1)!.split(',').includes(captureProcedure) &&
        observedInput<{ cameraId: string }>(request, captureProcedure).cameraId === camera.id
      );
    });
    await cameraCard.getByRole('button', { name: 'Capture pending stills' }).click();
    const capturedResponse = await captureResponse;
    expect(capturedResponse.ok()).toBe(true);
    const captureUrl = new URL(capturedResponse.url());
    const captureBody = await capturedResponse.json();
    const captureIndex = captureUrl.pathname
      .split('/')
      .at(-1)!
      .split(',')
      .indexOf(captureProcedure);
    const captureEnvelope =
      captureUrl.searchParams.get('batch') === '1' ? captureBody[captureIndex] : captureBody;
    expect(captureEnvelope.error).toBeUndefined();
    expect(captureEnvelope.result?.data).toHaveProperty('json');
    const captureResult = superjson.deserialize<{ processed: number }>(captureEnvelope.result.data);
    expect(captureResult.processed).toBeGreaterThan(0);
    expect(captureResult.processed).toBeLessThanOrEqual(10);
    let evidence = requestedEvidence;
    await expect
      .poll(
        async () => {
          evidence = await api.pharmacySales.counterEvidence.query(evidenceInput);
          expect(evidence).toHaveLength(4);
          expect(evidence.map((row) => row.id).sort()).toEqual(evidenceIds);
          const terminal = evidence.filter(
            (row) => row.status === 'FAILED' || row.status === 'PURGED'
          );
          if (terminal.length)
            throw new Error(`Target camera evidence failed or purged: ${JSON.stringify(terminal)}`);
          return evidence.every((row) => row.status === 'CAPTURED');
        },
        {
          timeout: 10_000,
          message: 'Original sale evidence must finish capture with stable identities',
        }
      )
      .toBe(true);
    await expect(cameraCard.getByRole('img').first()).toBeVisible();
    expect(evidence).toHaveLength(4);
    expect(evidence.every((row) => row.status === 'CAPTURED')).toBe(true);
    const retentionForm = cameraPage.getByRole('form', {
      name: `Retention for ${fixture.branchName}`,
    });
    await retentionForm.getByLabel('Retention days').fill('1');
    await retentionForm.getByRole('button', { name: 'Save retention' }).click();
    await expect(retentionForm).toContainText('Current policy 1 days');
    await cameraPage.screenshot({
      path: testInfo.outputPath('camera-private-simulator.png'),
      fullPage: true,
    });
    await api.pharmacyCameras.configure.mutate({
      cameraId: camera.id,
      preset: 'COUNTER',
      enabled: false,
    });
    await cameraCard.getByRole('button', { name: 'Refresh evidence', exact: true }).click();
    await expect(cameraCard.getByRole('alert')).toContainText(
      'Viewer access expired or was revoked'
    );
    await expect(cameraCard.getByRole('img')).toHaveCount(0);
    await cameraPage.close();
    await page.goto(
      `/pharmacy/loyalty?branchId=${fixture.branchId}&customerId=${earned.rows[0].customerId}`
    );
    const loyaltyHistory = page.getByRole('region', { name: 'Loyalty history', exact: true });
    const reversalRows = loyaltyHistory.getByRole('row').filter({
      has: page.getByRole('cell', { name: /^Earned points reversed(?:\s|$)/ }),
    });
    const refundedSale = await snapshot();
    expect(refundedSale.refunds).toHaveLength(2);
    const assertEarnedReversals = async () => {
      await expect(loyaltyHistory.getByRole('table')).toHaveAccessibleName(
        `Points history for ${patient.displayName} at ${fixture.branchName}`
      );
      await expect(
        loyaltyHistory.getByRole('cell', { name: 'Points earned', exact: true })
      ).toBeVisible();
      await expect(reversalRows).toHaveCount(2);
      for (const points of ['-7', '-6']) {
        await expect(reversalRows.getByRole('cell', { name: points, exact: true })).toBeVisible();
      }
      for (const refund of refundedSale.refunds) {
        const row = reversalRows.filter({
          has: page.getByRole('cell', {
            name: `Earned points reversed Refund: ${refund.id}`,
            exact: true,
          }),
        });
        await expect(row).toHaveCount(1);
        await expect(row.getByRole('cell', { name: /^Receipt #/ })).toContainText(
          `Sale: ${original.saleId}`
        );
      }
    };
    await assertEarnedReversals();
    await page.reload();
    await assertEarnedReversals();
    const loyalty = await api.pharmacySales.customerSnapshot.query({
      branchId: fixture.branchId,
      customerId: earned.rows[0].customerId,
    });
    expect(loyalty.pointsBalance).toBe(12);
    // Ordinary one-point redemption. No held floor/excess-policy fixture.
    await page.goto('/pharmacy/counter');
    await page.getByRole('button', { name: 'Open drawer', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Cash drawer opened' })).toBeVisible();
    await page.getByLabel('Scan or search').fill(fixture.medicines.otc.barcode);
    await page.getByLabel('Scan or search').press('Enter');
    await page
      .getByRole('list', { name: 'Search results' })
      .getByRole('button')
      .filter({ hasText: fixture.medicines.otc.name })
      .first()
      .click();
    await page.keyboard.press('F4');
    await page.getByLabel('Quantity', { exact: true }).fill('1');
    await page.getByLabel('Quantity', { exact: true }).press('Tab');
    await page.keyboard.press('F6');
    await expect(page.getByRole('list', { name: 'Cart lines' })).toContainText(
      fixture.medicines.otc.name
    );
    await page.getByLabel('Find patient').fill(patient.displayName);
    await page.getByLabel('Find patient').press('Enter');
    await page.getByRole('button', { name: patient.displayName, exact: true }).click();
    await page.getByRole('button', { name: 'Link selected patient' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Loyalty customer linked' })
    ).toBeVisible();
    await page.getByLabel('Points to redeem').fill('1');
    await page.getByRole('button', { name: 'Redeem', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '1 points added as a loyalty tender' })
    ).toBeVisible();
    await page.getByLabel('Amount', { exact: true }).fill('24.00');
    await page.getByLabel('Cash received', { exact: true }).fill('24.00');
    const paidRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname
          .split('/')
          .at(-1)!
          .split(',')
          .includes('pharmacySales.tender') && request.method() === 'POST'
    );
    await page.getByRole('button', { name: 'Take payment', exact: true }).click();
    const cashInput = observedInput<Parameters<typeof api.pharmacySales.tender.mutate>[0]>(
      await paidRequest,
      'pharmacySales.tender'
    );
    await expect(page.getByRole('region', { name: /^Receipt \d+$/ })).toBeVisible();
    const redeemedReceipt = await api.pharmacySales.counterReceipt.query({
      branchId: fixture.branchId,
      saleId: cashInput.saleId,
    });
    expect(
      redeemedReceipt.tenders.map((row) => ({ type: row.type, amountMinor: row.amountMinor }))
    ).toEqual(
      expect.arrayContaining([
        { type: 'LOYALTY', amountMinor: 100 },
        { type: 'CASH', amountMinor: 2400 },
      ])
    );
    const redeemedCart = await api.pharmacySales.counterCart.query({
      branchId: fixture.branchId,
      saleId: cashInput.saleId,
    });
    await api.pharmacySales.returnLine.mutate({
      branchId: fixture.branchId,
      saleLineId: redeemedCart.lines[0].saleLineId,
      canonicalUnits: 10,
      disposition: 'RESTOCK',
      reason: 'Synthetic ordinary redemption return',
      integrityDecision: 'Intact sealed units',
      idempotencyKey: randomUUID(),
    });
    const loyaltyRefund = {
      branchId: fixture.branchId,
      originalTenderId: redeemedReceipt.tenders.find((row) => row.type === 'LOYALTY')!.tenderId,
      deviceId: cashInput.deviceId,
      businessDate: cashInput.businessDate,
      amountMinor: 100,
      reason: 'Synthetic loyalty tender refund',
      requireReturnedValue: true,
      idempotencyKey: randomUUID(),
    };
    await api.pharmacySales.refundTender.mutate(loyaltyRefund);
    await api.pharmacySales.refundTender.mutate(loyaltyRefund);
    await api.pharmacySales.refundTender.mutate({
      ...loyaltyRefund,
      originalTenderId: redeemedReceipt.tenders.find((row) => row.type === 'CASH')!.tenderId,
      amountMinor: 2400,
      idempotencyKey: randomUUID(),
    });
    expect(
      (
        await api.pharmacySales.customerSnapshot.query({
          branchId: fixture.branchId,
          customerId: earned.rows[0].customerId,
        })
      ).pointsBalance
    ).toBe(12);
    await page.goto(
      `/pharmacy/loyalty?branchId=${fixture.branchId}&customerId=${earned.rows[0].customerId}`
    );
    const restoredRows = loyaltyHistory.getByRole('row').filter({
      has: page.getByRole('cell', { name: /^Redeemed points restored(?:\s|$)/ }),
    });
    const assertRedeemedRestoration = async () => {
      await expect(
        loyaltyHistory.getByRole('cell', { name: 'Points redeemed', exact: true })
      ).toBeVisible();
      await expect(restoredRows).toHaveCount(1);
      await expect(restoredRows.getByRole('cell', { name: '+1', exact: true })).toBeVisible();
      await expect(
        restoredRows.getByRole('cell', { name: /^Redeemed points restored/ })
      ).toContainText('Refund:');
      await expect(restoredRows.getByRole('cell', { name: /^Receipt #/ })).toContainText(
        `Sale: ${cashInput.saleId}`
      );
    };
    await assertRedeemedRestoration();
    await page.reload();
    await assertRedeemedRestoration();
    await page.screenshot({
      path: testInfo.outputPath('ordinary-redemption-return-history.png'),
      fullPage: true,
    });

    expect(errors).toEqual([]);
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
});

test('normal synthetic platform operator assigns pharmacy package and fresh tenant login inherits it', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const target = new URL(resolvePharmacyE2eDatabaseUrl());
  if (
    target.hostname !== '127.0.0.1' ||
    target.port !== '55625' ||
    target.pathname !== '/wha1364_business_disposable_20261008' ||
    baseURL !== 'http://127.0.0.1:4333'
  )
    throw new Error('Dedicated synthetic pharmacy business lane required');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://admin.localhost:4333/platform/login');
  await page
    .getByLabel('Work email', { exact: true })
    .fill('pharmacy-business-platform@example.test');
  await page.getByLabel('Password', { exact: true }).fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Continue to control desk' }).click();
  await expect(page).toHaveURL('http://admin.localhost:4333/platform', { timeout: 30_000 });
  await page.goto(`http://admin.localhost:4333/platform/organizations/${fixture.organizationId}`);
  const profile = page
    .locator('form')
    .filter({ has: page.getByText('Workspace profile', { exact: true }) });
  const assign = async (packageId: string) => {
    await profile.locator('select[name="packageId"]').selectOption(packageId);
    const response = page.waitForResponse(
      (r) => r.url().includes('/api/platform/control') && r.request().method() === 'POST'
    );
    await profile.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await response).ok()).toBe(true);
    await page.reload();
    await expect(profile.locator('select[name="packageId"]')).toHaveValue(packageId);
  };
  await assign('package_pharmacy_business_assignment_e2e');
  const db = new Client({ connectionString: target.href });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.is_platform_admin','true',true)");
    const assigned = await db.query('SELECT "packageId" FROM organizations WHERE id=$1', [
      fixture.organizationId,
    ]);
    expect(assigned.rows[0].packageId).toBe('package_pharmacy_business_assignment_e2e');
    const audit = await db.query(
      `SELECT id FROM platform_audit_logs WHERE "actorPlatformUserId"=$1 AND action='organization.update' AND "targetId"=$2 AND success=true`,
      ['platform_pharmacy_business_e2e', fixture.organizationId]
    );
    expect(audit.rowCount).toBeGreaterThan(0);
    await db.query('COMMIT');
    const context = await browser.newContext({ baseURL });
    try {
      const tenant = await context.newPage();
      tenant.on('pageerror', (error) => errors.push(error.message));
      await tenant.goto('/login');
      await waitForLoginHydrated(tenant);
      await tenant.getByLabel('Email').fill(process.env.PHARMACY_E2E_ADMIN_EMAIL!);
      await tenant
        .getByRole('textbox', { name: 'Password' })
        .fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
      await tenant.getByRole('button', { name: 'Sign in' }).press('Enter');
      await expect(tenant).toHaveURL(/\/(dashboard|pharmacy)/, { timeout: 30_000 });
      await tenant.goto('/pharmacy/counter');
      await expect(tenant.getByLabel('Scan or search')).toBeVisible();
      await tenant.screenshot({
        path: testInfo.outputPath('package-assigned-tenant.png'),
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  } finally {
    await db.end();
    await assign(fixture.packageId);
  }
  expect(errors).toEqual([]);
});
