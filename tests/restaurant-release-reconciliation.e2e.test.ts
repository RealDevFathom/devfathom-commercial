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
  branchB: `branch_wha435_b_${suffix}`,
  staffA: `staff_wha435_a_${suffix}`,
  staffB: `staff_wha435_b_${suffix}`,
  deviceA: `device_wha435_a_${suffix}`,
  deviceB: `device_wha435_b_${suffix}`,
  orderA: `order_wha435_a_${suffix}`,
  orderB: `order_wha435_b_${suffix}`,
  eventA: `event_wha435_a_${suffix}`,
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
     VALUES ($1, $2, 'A', CURRENT_TIMESTAMP), ($3, $4, 'B', CURRENT_TIMESTAMP)`,
    [ids.branchA, ids.orgA, ids.branchB, ids.orgB]
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
});
