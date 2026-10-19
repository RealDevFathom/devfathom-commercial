import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { createTRPCClient, httpLink } from '@trpc/client';
import superjson from 'superjson';
import type { AppRouter } from '../../src/server/routers/_app';
import { randomUUID } from 'node:crypto';
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
      "SELECT set_config('app.current_organization_id',$1,true), set_config('app.current_user_id',$2,true), set_config('app.current_branch_id',$3,true), set_config('app.is_platform_admin','false',true)",
      [fixture.organizationId, fixture.adminId, fixture.branchId]
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

test('authenticated delivery reserves stock, tracks dispatch, requires collected cash, and reconciles return/refund', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await tenant(async (db) => {
    await db.query(
      `INSERT INTO organization_role_permissions
        (id,"organizationId","organizationRoleId",capability,effect)
        VALUES ('operations_order_role_permission',$1,$2,'pharmacy:orders','ALLOW')
        ON CONFLICT("organizationRoleId",capability) DO NOTHING`,
      [fixture.organizationId, fixture.roleId]
    );
    await db.query(
      `INSERT INTO pharmacy_customers
      (id,"organizationId","patientId","displayName","updatedAt")
      VALUES ('operations_order_customer',$1,$2,'Synthetic delivery customer',now())
      ON CONFLICT("organizationId","patientId") DO NOTHING`,
      [fixture.organizationId, fixture.patientId]
    );
  });
  await login(page);
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
  const customers = await api.pharmacyOrdering.customers.query();
  const customerId = customers.find((c) => c.displayName === 'Synthetic delivery customer')?.id;
  expect(customerId).toBeTruthy();
  const branchId = fixture.branchId;
  const medicine = fixture.medicines.otc;
  const input = {
    branchId,
    customerId,
    fulfillment: 'DELIVER' as const,
    intendedPaymentMethod: 'CASH' as const,
    addressLine: 'Synthetic 1',
    city: 'Synthetic',
    lines: [
      {
        medicineId: medicine.id,
        presentationId: medicine.presentationId,
        packLevelId: medicine.packLevelIds.box,
        saleUnit: 'PACK' as const,
        quantity: 1,
      },
    ],
  };
  // Controlled medicines remain unavailable to this ordinary ordering path.
  await expect(
    api.pharmacyOrdering.place.mutate({
      ...input,
      lines: [
        {
          ...input.lines[0],
          medicineId: fixture.medicines.rx.id,
          presentationId: fixture.medicines.rx.presentationId,
          packLevelId: fixture.medicines.rx.packLevelIds.box,
        },
      ],
    })
  ).rejects.toThrow('ITEM_NOT_ORDERABLE');
  const order = await api.pharmacyOrdering.place.mutate(input);
  if (!order) throw new Error('Order missing after placement');
  expect(order.status).toBe('PROPOSED');
  const scope = { branchId, orderId: order.id };
  await expect(api.pharmacyOrdering.complete.mutate(scope)).rejects.toThrow('SALE_NOT_COMPLETED');
  for (const action of ['accept', 'pack'] as const)
    await api.pharmacyOrdering.transition.mutate({ ...scope, action });
  const dispatched = await api.pharmacyOrdering.transition.mutate({
    ...scope,
    action: 'dispatch',
    runnerUserId: fixture.adminId,
  });
  if (!dispatched) throw new Error('Order missing after dispatch');
  expect(dispatched.status).toBe('OUT_FOR_DELIVERY');
  const checkout = await api.pharmacyOrdering.startCheckout.mutate(scope);
  expect(await api.pharmacyOrdering.startCheckout.mutate(scope)).toEqual({
    ...checkout,
    replayed: true,
  });
  const cart = await api.pharmacySales.counterCart.query({ branchId, saleId: checkout.saleId });
  expect(cart.lines).toHaveLength(1);
  const businessDate = new Date();
  const deviceId = `delivery-${randomUUID()}`;
  const tender = {
    branchId,
    saleId: checkout.saleId,
    deviceId,
    businessDate,
    type: 'CASH' as const,
    amountMinor: cart.totals.netMinor,
    idempotencyKey: randomUUID(),
  };
  await expect(api.pharmacySales.tender.mutate({ ...tender, type: 'CARD' })).rejects.toThrow(
    'UNCERTIFIED_PROVIDER'
  );
  await expect(api.pharmacyOrdering.complete.mutate(scope)).rejects.toThrow('SALE_NOT_COMPLETED');
  await api.pharmacySales.openDrawer.mutate({
    branchId,
    deviceId,
    businessDate,
    openingFloatMinor: 0,
  });
  const collection = {
    ...scope,
    action: 'COLLECT' as const,
    amountMinor: tender.amountMinor,
    reference: 'Synthetic runner collection',
    requestKey: randomUUID(),
  };
  await page.goto('/pharmacy/orders');
  const orderCard = page.locator('article').filter({ hasText: order.id.slice(-8) });
  await expect(orderCard).toBeVisible();
  await orderCard.getByText('Delivery custody and reconciliation', { exact: true }).click();
  await orderCard.getByLabel('Evidence action').selectOption('COLLECT');
  await orderCard.getByLabel('Actual amount in minor units').fill(String(collection.amountMinor));
  await orderCard.getByLabel('Evidence reference').fill(collection.reference);
  await orderCard.getByLabel('Operation key (reuse for retry)').fill(collection.requestKey);
  await orderCard.getByRole('button', { name: 'Record custody evidence' }).click();
  await expect(
    orderCard.getByRole('status').filter({ hasText: `collected ${collection.amountMinor}` })
  ).toBeVisible();
  expect((await api.pharmacyOrdering.deliveryCommand.mutate(collection)).totals.custodyMinor).toBe(
    tender.amountMinor
  );
  expect((await api.pharmacyOrdering.deliveryCommand.mutate(collection)).replayed).toBe(true);
  const remittance = {
    ...scope,
    action: 'REMIT' as const,
    amountMinor: tender.amountMinor,
    reference: 'Synthetic independent receiver',
    requestKey: randomUUID(),
    deviceId,
    businessDate,
  };
  await expect(api.pharmacyOrdering.deliveryCommand.mutate(remittance)).rejects.toThrow(
    'INDEPENDENT_RECEIVER_REQUIRED'
  );
  const variance = await api.pharmacyOrdering.deliveryCommand.mutate({
    ...scope,
    action: 'VARIANCE',
    reference: 'Synthetic custody count',
    requestKey: randomUUID(),
  });
  expect(variance.evidence.amountMinor).toBe(tender.amountMinor);
  await page.context().clearCookies();
  await login(page, 'cod-receiver@example.test');
  const remitted = await api.pharmacyOrdering.deliveryCommand.mutate(remittance);
  expect(remitted.totals).toMatchObject({ custodyMinor: 0, remittedMinor: tender.amountMinor });
  expect((await api.pharmacyOrdering.deliveryCommand.mutate(remittance)).replayed).toBe(true);
  const settledReceipt = await api.pharmacySales.counterReceipt.query({
    branchId,
    saleId: checkout.saleId,
  });
  const paid = settledReceipt.tenders[0]!;
  const completed = await api.pharmacyOrdering.complete.mutate(scope);
  if (!completed) throw new Error('Order missing after completion');
  expect(completed.status).toBe('COMPLETED');
  expect(completed.events.map((e) => e.kind)).toContain('COMPLETED');
  const receipt = await api.pharmacySales.counterReceipt.query({
    branchId,
    saleId: checkout.saleId,
  });
  await api.pharmacySales.returnLine.mutate({
    branchId,
    saleLineId: cart.lines[0]!.saleLineId,
    canonicalUnits: 100,
    disposition: 'RESTOCK',
    reason: 'Synthetic intact delivery return',
    integrityDecision: 'Intact sealed pack',
    idempotencyKey: randomUUID(),
  });
  const refund = {
    branchId,
    originalTenderId: paid.tenderId,
    deviceId,
    businessDate,
    amountMinor: tender.amountMinor,
    reason: 'Synthetic delivery refund',
    requireReturnedValue: true,
    idempotencyKey: randomUUID(),
  };
  await api.pharmacySales.refundTender.mutate(refund);
  await expect(
    api.pharmacySales.refundTender.mutate({ ...refund, idempotencyKey: randomUUID() })
  ).rejects.toThrow();
  expect(
    await api.pharmacySales.counterReceipt.query({ branchId, saleId: checkout.saleId })
  ).toEqual(receipt);
  // A failed second delivery retains stock custody until an independent physical return.
  const refusedOrder = await api.pharmacyOrdering.place.mutate(input);
  if (!refusedOrder) throw new Error('Second order missing');
  const refusedScope = { branchId, orderId: refusedOrder.id };
  for (const action of ['accept', 'pack'] as const)
    await api.pharmacyOrdering.transition.mutate({ ...refusedScope, action });
  await api.pharmacyOrdering.transition.mutate({
    ...refusedScope,
    action: 'dispatch',
    runnerUserId: fixture.adminId,
  });
  const refusedCheckout = await api.pharmacyOrdering.startCheckout.mutate(refusedScope);
  const refusal = {
    ...refusedScope,
    action: 'REFUSED' as const,
    reference: 'Synthetic customer refusal',
    requestKey: randomUUID(),
  };
  await api.pharmacyOrdering.deliveryCommand.mutate(refusal);
  await expect(api.pharmacyOrdering.startCheckout.mutate(refusedScope)).rejects.toThrow();
  await expect(api.pharmacyOrdering.complete.mutate(refusedScope)).rejects.toThrow();
  const physical = {
    ...refusedScope,
    action: 'PHYSICAL_RETURN' as const,
    reference: 'Sealed items physically counted at branch',
    requestKey: randomUUID(),
    quarantineLocationId: fixture.quarantineLocationId,
  };
  const recovered = await api.pharmacyOrdering.deliveryCommand.mutate(physical);
  expect(recovered.totals.physicallyReturned).toBe(true);
  expect((await api.pharmacyOrdering.deliveryCommand.mutate(physical)).replayed).toBe(true);
  await tenant(async (db) => {
    const returned = await db.query('SELECT status FROM pharmacy_customer_orders WHERE id=$1', [
      refusedOrder.id,
    ]);
    expect(returned.rows[0].status).toBe('RETURNED');
    const voided = await db.query('SELECT status FROM pharmacy_sales WHERE id=$1', [
      refusedCheckout.saleId,
    ]);
    expect(voided.rows[0].status).toBe('VOID');
    const evidence = await db.query(
      'SELECT action FROM pharmacy_order_delivery_evidence WHERE "orderId"=$1',
      [refusedOrder.id]
    );
    expect(evidence.rows.map((row) => row.action).sort()).toEqual(['PHYSICAL_RETURN', 'REFUSED']);
  });
});
