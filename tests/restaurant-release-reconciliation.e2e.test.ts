/**
 * WHA-435 — real-PostgreSQL acceptance for the append-only order-event ledger.
 *
 * TEST_DATABASE_URL must target a fresh, fully migrated disposable database
 * through a LOGIN / NOSUPERUSER / NOBYPASSRLS runtime role. The suite refuses
 * remote databases and fails rather than silently weakening its RLS proof.
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is required; WHA-435 acceptance must run with zero skips.');
}

const parsedUrl = new URL(TEST_DATABASE_URL);
if (
  !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsedUrl.hostname) &&
  process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
) {
  throw new Error('Refusing to run WHA-435 acceptance against a non-local database.');
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  orgA: `org_wha435_a_${suffix}`,
  orgB: `org_wha435_b_${suffix}`,
  branchA: `branch_wha435_a_${suffix}`,
  branchAControl: `branch_wha435_a_control_${suffix}`,
  branchB: `branch_wha435_b_${suffix}`,
  staffA: `staff_wha435_a_${suffix}`,
  staffB: `staff_wha435_b_${suffix}`,
  deviceA: `device_wha435_a_${suffix}`,
  deviceB: `device_wha435_b_${suffix}`,
  orderA: `order_wha435_a_${suffix}`,
  orderB: `order_wha435_b_${suffix}`,
  eventA: `event_wha435_a_${suffix}`,
  flowOrder: `order_wha472_${suffix}`,
};

const writer = new pg.Client({ connectionString: TEST_DATABASE_URL });
const observer = new pg.Client({ connectionString: TEST_DATABASE_URL });

async function scope(client: pg.Client, organizationId: string, platform = false) {
  await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
    organizationId,
  ]);
  await client.query(`SELECT set_config('app.is_platform_admin', $1, true)`, [String(platform)]);
}

async function expectDatabaseError(code: string, run: () => Promise<unknown>) {
  await writer.query('SAVEPOINT expected_database_error');
  try {
    await run();
    throw new Error(`Expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  } finally {
    await writer.query('ROLLBACK TO SAVEPOINT expected_database_error');
    await writer.query('RELEASE SAVEPOINT expected_database_error');
  }
}

beforeAll(async () => {
  await Promise.all([writer.connect(), observer.connect()]);

  await writer.query('BEGIN');
  await scope(writer, '', true);
  await writer.query(
    `INSERT INTO "organizations"
      ("id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt")
     VALUES ($1, $2, 'WHA-435 A', 'WHA-435 A', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            ($3, $4, 'WHA-435 B', 'WHA-435 B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.orgA, `wha435-a-${suffix}`, ids.orgB, `wha435-b-${suffix}`]
  );
  await writer.query(
    `INSERT INTO "restaurant_branches" ("id", "organizationId", "name", "updatedAt")
     VALUES ($1, $2, 'A', CURRENT_TIMESTAMP),
            ($3, $2, 'A control', CURRENT_TIMESTAMP),
            ($4, $5, 'B', CURRENT_TIMESTAMP)`,
    [ids.branchA, ids.orgA, ids.branchAControl, ids.branchB, ids.orgB]
  );
  await writer.query(
    `INSERT INTO "restaurant_staff_profiles"
      ("id", "organizationId", "displayName", "primaryBranchId", "updatedAt")
     VALUES ($1, $2, 'A', $3, CURRENT_TIMESTAMP), ($4, $5, 'B', $6, CURRENT_TIMESTAMP)`,
    [ids.staffA, ids.orgA, ids.branchA, ids.staffB, ids.orgB, ids.branchB]
  );
  await writer.query(
    `INSERT INTO "restaurant_registered_devices"
      ("id", "organizationId", "branchId", "name", "deviceSecretHash", "updatedAt")
     VALUES ($1, $2, $3, 'A', $4, CURRENT_TIMESTAMP),
            ($5, $6, $7, 'B', $8, CURRENT_TIMESTAMP)`,
    [
      ids.deviceA,
      ids.orgA,
      ids.branchA,
      `hash-a-${suffix}`,
      ids.deviceB,
      ids.orgB,
      ids.branchB,
      `hash-b-${suffix}`,
    ]
  );
  await writer.query(
    `INSERT INTO "restaurant_orders"
      ("id", "organizationId", "branchId", "orderNumber", "businessDate", "channel",
       "staffProfileId", "deviceId", "updatedAt")
     VALUES ($1, $2, $3, 1, DATE '2026-08-29', 'DINE_IN', $4, $5, CURRENT_TIMESTAMP),
            ($6, $7, $8, 1, DATE '2026-08-29', 'DINE_IN', $9, $10, CURRENT_TIMESTAMP)`,
    [
      ids.orderA,
      ids.orgA,
      ids.branchA,
      ids.staffA,
      ids.deviceA,
      ids.orderB,
      ids.orgB,
      ids.branchB,
      ids.staffB,
      ids.deviceB,
    ]
  );
  await writer.query('COMMIT');
});

afterAll(async () => {
  await Promise.all([writer.end(), observer.end()]);
});

describe('WHA-435 append-only restaurant order events', () => {
  it('runs as LOGIN NOSUPERUSER NOBYPASSRLS and pins forced command policies', async () => {
    const role = await writer.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role.rows).toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false }]);

    const table = await writer.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE oid = 'public.restaurant_order_events'::regclass`
    );
    expect(table.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

    const policies = await writer.query<{ policyname: string; cmd: string }>(
      `SELECT policyname, cmd FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'restaurant_order_events'
        ORDER BY policyname`
    );
    expect(policies.rows).toEqual([
      { policyname: 'tenant_isolation_insert', cmd: 'INSERT' },
      { policyname: 'tenant_isolation_select', cmd: 'SELECT' },
    ]);
  });

  it('allows same-tenant insert/select and fails closed across tenants', async () => {
    await writer.query('BEGIN');
    await scope(writer, ids.orgA);
    await writer.query(
      `INSERT INTO "restaurant_order_events"
        ("id", "organizationId", "orderId", "sequence", "eventType", "payload")
       VALUES ($1, $2, $3, 1, 'order.opened', '{}'::jsonb)`,
      [ids.eventA, ids.orgA, ids.orderA]
    );
    expect(
      (
        await writer.query(`SELECT "id" FROM "restaurant_order_events" WHERE "id" = $1`, [
          ids.eventA,
        ])
      ).rows
    ).toEqual([{ id: ids.eventA }]);
    await expectDatabaseError('42501', () =>
      writer.query(
        `INSERT INTO "restaurant_order_events"
          ("id", "organizationId", "orderId", "sequence", "eventType", "payload")
         VALUES ($1, $2, $3, 1, 'order.opened', '{}'::jsonb)`,
        [`wrong_${suffix}`, ids.orgB, ids.orderB]
      )
    );
    await expectDatabaseError('23503', async () => {
      await writer.query(
        `INSERT INTO "restaurant_order_events"
          ("id", "organizationId", "orderId", "sequence", "eventType", "payload")
         VALUES ($1, $2, $3, 2, 'order.opened', '{}'::jsonb)`,
        [`foreign_order_${suffix}`, ids.orgA, ids.orderB]
      );
      await writer.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
    await writer.query('COMMIT');

    await writer.query('BEGIN');
    await scope(writer, ids.orgB);
    expect(
      (
        await writer.query(`SELECT "id" FROM "restaurant_order_events" WHERE "id" = $1`, [
          ids.eventA,
        ])
      ).rowCount
    ).toBe(0);
    await writer.query('ROLLBACK');
  });

  it.each([
    ['tenant', false],
    ['platform', true],
  ] as const)('%s context has no UPDATE or DELETE path', async (_label, platform) => {
    await writer.query('BEGIN');
    await scope(writer, ids.orgA, platform);
    expect(
      (
        await writer.query(
          `UPDATE "restaurant_order_events" SET "eventType" = 'tampered' WHERE "id" = $1`,
          [ids.eventA]
        )
      ).rowCount
    ).toBe(0);
    expect(
      (await writer.query(`DELETE FROM "restaurant_order_events" WHERE "id" = $1`, [ids.eventA]))
        .rowCount
    ).toBe(0);
    await writer.query('ROLLBACK');
  });

  it('keeps rolled-back events invisible and reconciles a committed sequence across connections', async () => {
    await writer.query('BEGIN');
    await scope(writer, ids.orgA);
    await writer.query(
      `INSERT INTO "restaurant_order_events"
        ("id", "organizationId", "orderId", "sequence", "eventType", "payload")
       VALUES ($1, $2, $3, 2, 'order.held', '{}'::jsonb)`,
      [`rollback_${suffix}`, ids.orgA, ids.orderA]
    );

    await observer.query('BEGIN');
    await scope(observer, ids.orgA);
    expect(
      (
        await observer.query(
          `SELECT count(*)::int AS count FROM "restaurant_order_events" WHERE "orderId" = $1`,
          [ids.orderA]
        )
      ).rows
    ).toEqual([{ count: 1 }]);
    await observer.query('COMMIT');
    await writer.query('ROLLBACK');

    await writer.query('BEGIN');
    await scope(writer, ids.orgA);
    await writer.query(
      `INSERT INTO "restaurant_order_events"
        ("id", "organizationId", "orderId", "sequence", "eventType", "payload")
       VALUES ($1, $2, $3, 2, 'order.held', '{}'::jsonb)`,
      [`commit_${suffix}`, ids.orgA, ids.orderA]
    );
    await writer.query('COMMIT');

    await observer.query('BEGIN');
    await scope(observer, ids.orgA);
    const reconciled = await observer.query<{ sequence: number; eventType: string }>(
      `SELECT "sequence", "eventType" FROM "restaurant_order_events"
        WHERE "orderId" = $1 ORDER BY "sequence"`,
      [ids.orderA]
    );
    expect(reconciled.rows).toEqual([
      { sequence: 1, eventType: 'order.opened' },
      { sequence: 2, eventType: 'order.held' },
    ]);
    await observer.query('COMMIT');
  });

  it('reconciles one settled order across its persisted release ledgers exactly once', async () => {
    const flow = {
      key: `flow_${suffix}`,
      product: `product_${suffix}`,
      item: `item_${suffix}`,
      bill: `bill_${suffix}`,
      billLine: `bill_line_${suffix}`,
      drawer: `drawer_${suffix}`,
      tender: `tender_${suffix}`,
      drawerMovement: `drawer_movement_${suffix}`,
      unit: `unit_${suffix}`,
      ingredient: `ingredient_${suffix}`,
      stockItem: `stock_item_${suffix}`,
      location: `location_${suffix}`,
      stockMovement: `stock_movement_${suffix}`,
      customer: `customer_${suffix}`,
      program: `program_${suffix}`,
      account: `account_${suffix}`,
      loyalty: `loyalty_${suffix}`,
      close: `close_${suffix}`,
      closeTender: `close_tender_${suffix}`,
      insight: `insight_${suffix}`,
    };

    async function runFlow(commandType: string) {
      await writer.query('BEGIN');
      await scope(writer, ids.orgA);
      try {
        const claimed = await writer.query(
          `INSERT INTO "restaurant_order_idempotency_keys"
            ("id", "organizationId", "deviceId", "key", "commandType", "resultRef", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
           ON CONFLICT ("deviceId", "key") DO NOTHING
           RETURNING "commandType"`,
          [`idem_${suffix}`, ids.orgA, ids.deviceA, flow.key, commandType, ids.flowOrder]
        );
        if (claimed.rowCount === 0) {
          const existing = await writer.query<{ commandType: string }>(
            `SELECT "commandType" FROM "restaurant_order_idempotency_keys"
              WHERE "deviceId" = $1 AND "key" = $2`,
            [ids.deviceA, flow.key]
          );
          if (existing.rows[0]?.commandType !== commandType) {
            throw new Error('IDEMPOTENCY_KEY_CONFLICT');
          }
          await writer.query('COMMIT');
          return { replayed: true };
        }

        await writer.query(
          `INSERT INTO "restaurant_products" ("id", "organizationId", "name", "updatedAt")
           VALUES ($1, $2, 'Release reconciliation item', CURRENT_TIMESTAMP)`,
          [flow.product, ids.orgA]
        );
        await writer.query(
          `INSERT INTO "restaurant_orders"
            ("id", "organizationId", "branchId", "orderNumber", "businessDate", "status",
             "channel", "staffProfileId", "deviceId", "openedAt", "updatedAt")
           VALUES ($1, $2, $3, 472, DATE '2026-08-29', 'CLOSED', 'DINE_IN', $4, $5,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [ids.flowOrder, ids.orgA, ids.branchA, ids.staffA, ids.deviceA]
        );
        await writer.query(
          `INSERT INTO "restaurant_order_items"
            ("id", "organizationId", "orderId", "productId", "name", "unitPrice", "quantity",
             "taxAmount", "status", "updatedAt")
           VALUES ($1, $2, $3, $4, 'Release reconciliation item', 10.00, 1, 0.90,
                   'SERVED', CURRENT_TIMESTAMP)`,
          [flow.item, ids.orgA, ids.flowOrder, flow.product]
        );
        for (const [index, eventType] of [
          'order.opened',
          'item.added',
          'order.payment_pending',
          'order.closed',
        ].entries()) {
          const sequence = index + 1;
          await writer.query(
            `INSERT INTO "restaurant_order_events"
              ("id", "organizationId", "orderId", "sequence", "eventType",
               "actorStaffProfileId", "actorDeviceId", "payload")
             VALUES ($1, $2, $3, $4, $5, $6, $7, jsonb_build_object('branchId', $8::text))`,
            [
              `flow_event_${sequence}_${suffix}`,
              ids.orgA,
              ids.flowOrder,
              sequence,
              eventType,
              ids.staffA,
              ids.deviceA,
              ids.branchA,
            ]
          );
          await writer.query(
            `INSERT INTO "restaurant_event_outbox"
              ("id", "organizationId", "eventType", "aggregateType", "aggregateId", "payload", "updatedAt")
             VALUES ($1, $2, $3, 'restaurant.order', $4,
                     jsonb_build_object('sequence', $5::int), CURRENT_TIMESTAMP)`,
            [`flow_outbox_${sequence}_${suffix}`, ids.orgA, eventType, ids.flowOrder, sequence]
          );
        }
        await writer.query(
          `INSERT INTO "restaurant_bills"
            ("id", "organizationId", "orderId", "branchId", "businessDate", "status",
             "subtotal", "taxTotal", "discountTotal", "grandTotal", "receiptNumber", "settledAt",
             "openerStaffProfileId", "deviceId", "updatedAt")
           VALUES ($1, $2, $3, $4, DATE '2026-08-29', 'SETTLED', 10.00, 0.90, 1.00,
                   9.90, 472, CURRENT_TIMESTAMP, $5, $6, CURRENT_TIMESTAMP)`,
          [flow.bill, ids.orgA, ids.flowOrder, ids.branchA, ids.staffA, ids.deviceA]
        );
        await writer.query(
          `INSERT INTO "restaurant_bill_lines"
            ("id", "organizationId", "billId", "orderItemId", "name", "quantity", "unitPrice",
             "lineSubtotal", "taxAmount", "lineTotal", "updatedAt")
           VALUES ($1, $2, $3, $4, 'Release reconciliation item', 1, 10.00, 10.00, 0.90,
                   10.90, CURRENT_TIMESTAMP)`,
          [flow.billLine, ids.orgA, flow.bill, flow.item]
        );
        await writer.query(
          `INSERT INTO "restaurant_drawer_sessions"
            ("id", "organizationId", "branchId", "deviceId", "staffProfileId", "businessDate",
             "status", "openingFloat", "expectedCash", "countedCash", "variance", "closedAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, DATE '2026-08-29', 'CLOSED', 20.00, 29.90, 29.90,
                   0.00, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [flow.drawer, ids.orgA, ids.branchA, ids.deviceA, ids.staffA]
        );
        await writer.query(
          `INSERT INTO "restaurant_tenders"
            ("id", "organizationId", "billId", "type", "amount", "cashReceived", "changeGiven",
             "drawerSessionId", "businessDate", "staffProfileId", "deviceId")
           VALUES ($1, $2, $3, 'CASH', 9.90, 10.00, 0.10, $4, DATE '2026-08-29', $5, $6)`,
          [flow.tender, ids.orgA, flow.bill, flow.drawer, ids.staffA, ids.deviceA]
        );
        await writer.query(
          `INSERT INTO "restaurant_drawer_movements"
            ("id", "organizationId", "drawerSessionId", "kind", "amount", "tenderId",
             "staffProfileId", "deviceId")
           VALUES ($1, $2, $3, 'CASH_SALE', 9.90, $4, $5, $6)`,
          [flow.drawerMovement, ids.orgA, flow.drawer, flow.tender, ids.staffA, ids.deviceA]
        );
        await writer.query(
          `INSERT INTO "restaurant_units" ("id", "organizationId", "name", "abbreviation", "updatedAt")
           VALUES ($1, $2, 'Each', 'ea', CURRENT_TIMESTAMP)`,
          [flow.unit, ids.orgA]
        );
        await writer.query(
          `INSERT INTO "restaurant_ingredients"
             ("id", "organizationId", "name", "baseUnitId", "updatedAt")
           VALUES ($1, $2, 'Release ingredient', $3, CURRENT_TIMESTAMP)`,
          [flow.ingredient, ids.orgA, flow.unit]
        );
        await writer.query(
          `INSERT INTO "restaurant_stock_items"
             ("id", "organizationId", "ingredientId", "canonicalUnitId", "updatedAt")
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
          [flow.stockItem, ids.orgA, flow.ingredient, flow.unit]
        );
        await writer.query(
          `INSERT INTO "restaurant_stock_locations"
             ("id", "organizationId", "branchId", "name", "updatedAt")
           VALUES ($1, $2, $3, 'Release location', CURRENT_TIMESTAMP)`,
          [flow.location, ids.orgA, ids.branchA]
        );
        await writer.query(
          `INSERT INTO "restaurant_stock_movements"
            ("id", "organizationId", "stockItemId", "locationId", "reason", "quantity", "orderId",
             "staffProfileId", "deviceId")
           VALUES ($1, $2, $3, $4, 'RECIPE_CONSUMPTION', -1, $5, $6, $7)`,
          [
            flow.stockMovement,
            ids.orgA,
            flow.stockItem,
            flow.location,
            ids.flowOrder,
            ids.staffA,
            ids.deviceA,
          ]
        );
        await writer.query(
          `INSERT INTO "restaurant_customers" ("id", "organizationId", "displayName", "updatedAt")
           VALUES ($1, $2, 'Release customer', CURRENT_TIMESTAMP)`,
          [flow.customer, ids.orgA]
        );
        await writer.query(
          `UPDATE "restaurant_orders" SET "customerId" = $1, "closedAt" = CURRENT_TIMESTAMP WHERE "id" = $2`,
          [flow.customer, ids.flowOrder]
        );
        await writer.query(
          `INSERT INTO "restaurant_loyalty_program_versions"
             ("id", "organizationId", "versionNumber", "effectiveFrom", "earnRate", "redemptionValue", "updatedAt")
           VALUES ($1, $2, 1, TIMESTAMPTZ '2026-01-01 00:00:00+00', 1, 0.01, CURRENT_TIMESTAMP)`,
          [flow.program, ids.orgA]
        );
        await writer.query(
          `INSERT INTO "restaurant_loyalty_accounts"
             ("id", "organizationId", "customerId", "updatedAt")
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
          [flow.account, ids.orgA, flow.customer]
        );
        await writer.query(
          `INSERT INTO "restaurant_loyalty_points_entries"
             ("id", "organizationId", "accountId", "programVersionId", "kind", "points", "billId", "idempotencyKey")
           VALUES ($1, $2, $3, $4, 'EARN', 9, $5, $6)`,
          [flow.loyalty, ids.orgA, flow.account, flow.program, flow.bill, `earn_${suffix}`]
        );
        await writer.query(
          `INSERT INTO "restaurant_daily_closes"
            ("id", "organizationId", "branchId", "businessDate", "cutByStaffProfileId", "deviceId",
             "grossSales", "netSales", "taxTotal", "discountTotal", "cashExpected", "cashCounted")
           VALUES ($1, $2, $3, DATE '2026-08-29', $4, $5, 10.00, 9.00, 0.90, 1.00, 29.90, 29.90)`,
          [flow.close, ids.orgA, ids.branchA, ids.staffA, ids.deviceA]
        );
        await writer.query(
          `INSERT INTO "restaurant_daily_close_tender_totals"
             ("id", "organizationId", "dailyCloseId", "tenderType", "amount", "count")
           VALUES ($1, $2, $3, 'CASH', 9.90, 1)`,
          [flow.closeTender, ids.orgA, flow.close]
        );
        await writer.query(
          `INSERT INTO "restaurant_insight_daily_rollups"
             ("id", "organizationId", "branchId", "businessDate", "sourceDailyCloseId", "orderCount",
              "grossSales", "netSales", "loyaltyLiability", "updatedAt")
           VALUES ($1, $2, $3, DATE '2026-08-29', $4, 1, 10.00, 9.00, 0.09, CURRENT_TIMESTAMP)`,
          [flow.insight, ids.orgA, ids.branchA, flow.close]
        );
        await writer.query('COMMIT');
        return { replayed: false };
      } catch (error) {
        await writer.query('ROLLBACK');
        throw error;
      }
    }

    await expect(runFlow('release.reconcile')).resolves.toEqual({ replayed: false });
    await expect(runFlow('release.reconcile')).resolves.toEqual({ replayed: true });
    await expect(runFlow('release.conflict')).rejects.toThrow('IDEMPOTENCY_KEY_CONFLICT');

    await writer.query('BEGIN');
    await scope(writer, ids.orgA);
    await writer.query(
      `INSERT INTO "restaurant_order_events"
        ("id", "organizationId", "orderId", "sequence", "eventType", "payload")
       VALUES ($1, $2, $3, 5, 'forced.rollback', '{}'::jsonb)`,
      [`forced_flow_rollback_${suffix}`, ids.orgA, ids.flowOrder]
    );
    await writer.query(
      `INSERT INTO "restaurant_event_outbox"
        ("id", "organizationId", "eventType", "aggregateType", "aggregateId", "payload", "updatedAt")
       VALUES ($1, $2, 'forced.rollback', 'restaurant.order', $3, '{}'::jsonb, CURRENT_TIMESTAMP)`,
      [`forced_flow_outbox_rollback_${suffix}`, ids.orgA, ids.flowOrder]
    );
    await writer.query('ROLLBACK');

    await observer.query('BEGIN');
    await scope(observer, ids.orgA);
    const reconciled = await observer.query(
      `SELECT
         o.status, o."branchId", o."customerId",
         b.subtotal::text, b."taxTotal"::text, b."discountTotal"::text, b."grandTotal"::text,
         (SELECT coalesce(sum(t.amount), 0)::text FROM restaurant_tenders t WHERE t."billId" = b.id) AS tendered,
         (SELECT count(*)::int FROM restaurant_order_events e WHERE e."orderId" = o.id) AS events,
         (SELECT count(*)::int FROM restaurant_event_outbox x WHERE x."aggregateId" = o.id) AS outbox,
         (SELECT array_agg(e.sequence ORDER BY e.sequence) FROM restaurant_order_events e WHERE e."orderId" = o.id) AS sequences,
         (SELECT count(*)::int FROM restaurant_stock_movements m WHERE m."orderId" = o.id AND m."deviceId" = $2) AS inventory,
         (SELECT count(*)::int FROM restaurant_loyalty_points_entries l WHERE l."billId" = b.id) AS loyalty,
         (SELECT count(*)::int FROM restaurant_drawer_movements d WHERE d."tenderId" = $3 AND d."deviceId" = $2) AS drawer,
         (SELECT count(*)::int FROM restaurant_insight_daily_rollups i WHERE i."sourceDailyCloseId" = $4 AND i."branchId" = o."branchId") AS insight,
         (SELECT count(*)::int FROM restaurant_order_idempotency_keys k WHERE k."deviceId" = $2 AND k.key = $5) AS keys
       FROM restaurant_orders o JOIN restaurant_bills b ON b."orderId" = o.id
       WHERE o.id = $1`,
      [ids.flowOrder, ids.deviceA, flow.tender, flow.close, flow.key]
    );
    expect(reconciled.rows).toEqual([
      expect.objectContaining({
        status: 'CLOSED',
        branchId: ids.branchA,
        customerId: flow.customer,
        subtotal: '10.00',
        taxTotal: '0.90',
        discountTotal: '1.00',
        grandTotal: '9.90',
        tendered: '9.90',
        events: 4,
        outbox: 4,
        sequences: [1, 2, 3, 4],
        inventory: 1,
        loyalty: 1,
        drawer: 1,
        insight: 1,
        keys: 1,
      }),
    ]);
    expect(
      (
        await observer.query(
          `SELECT count(*)::int AS count FROM restaurant_orders WHERE "branchId" = $1 AND id = $2`,
          [ids.branchAControl, ids.flowOrder]
        )
      ).rows
    ).toEqual([{ count: 0 }]);
    await observer.query('COMMIT');

    await observer.query('BEGIN');
    await scope(observer, ids.orgB);
    expect(
      (await observer.query(`SELECT id FROM restaurant_orders WHERE id = $1`, [ids.flowOrder]))
        .rowCount
    ).toBe(0);
    await observer.query('COMMIT');
  });
});
