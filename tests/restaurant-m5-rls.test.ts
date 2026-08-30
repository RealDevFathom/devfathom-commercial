import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const client = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  orgA: `org_m5_a_${suffix}`,
  orgB: `org_m5_b_${suffix}`,
  rowA: `m5_a_${suffix}`,
  rowB: `m5_b_${suffix}`,
  managerA: `m5_manager_a_${suffix}`,
  managerB: `m5_manager_b_${suffix}`,
};

const M5_TABLES = [
  'restaurant_bills',
  'restaurant_bill_lines',
  'restaurant_payments',
  'restaurant_payment_events',
  'restaurant_drawer_sessions',
  'restaurant_tenders',
  'restaurant_refunds',
  'restaurant_drawer_movements',
  'restaurant_daily_closes',
  'restaurant_daily_close_tender_totals',
  'restaurant_receipt_number_sequences',
  'restaurant_money_idempotency_keys',
] as const;

const APPEND_ONLY_TABLES = [
  'restaurant_tenders',
  'restaurant_payment_events',
  'restaurant_refunds',
  'restaurant_drawer_movements',
  'restaurant_daily_closes',
  'restaurant_daily_close_tender_totals',
] as const;

type M5Table = (typeof M5_TABLES)[number];
type FixtureColumn = {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  is_identity: 'YES' | 'NO';
  is_generated: 'ALWAYS' | 'NEVER';
};

const fixtureColumns = new Map<M5Table, FixtureColumn[]>();
const enumValues = new Map<string, string>();

function fixtureValue(
  table: M5Table,
  column: FixtureColumn,
  organizationId: string,
  rowId: string,
  referenceId: string
) {
  if (column.column_name === 'organizationId') return organizationId;
  if (column.column_name === 'id') return rowId;
  if (column.column_name.endsWith('Id')) return referenceId;
  if (column.data_type === 'USER-DEFINED') {
    if (table === 'restaurant_drawer_sessions' && column.column_name === 'status') {
      return rowId === referenceId ? 'OPEN' : 'CLOSED';
    }
    const value = enumValues.get(column.udt_name);
    if (!value) throw new Error(`No enum fixture value for ${column.udt_name}`);
    return value;
  }
  if (column.data_type === 'numeric') return rowId === referenceId ? '1.00' : '2.00';
  if (['smallint', 'integer', 'bigint'].includes(column.data_type)) {
    return rowId === referenceId ? 1 : 2;
  }
  if (column.data_type === 'date') return rowId === referenceId ? '2030-01-01' : '2030-01-02';
  if (column.data_type.startsWith('timestamp')) return new Date('2030-01-01T00:00:00Z');
  if (['json', 'jsonb'].includes(column.data_type)) return {};
  if (['character', 'character varying', 'text'].includes(column.data_type)) {
    return `${column.column_name}_${rowId}`;
  }
  throw new Error(`No M5 fixture value for ${column.column_name} (${column.data_type})`);
}

async function loadFixtureMetadata() {
  const columns = await client!.query<FixtureColumn & { table_name: M5Table }>(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable,
            column_default, is_identity, is_generated
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [[...M5_TABLES]]
  );
  const labels = await client!.query<{ udt_name: string; enumlabel: string }>(
    `SELECT type_row.typname AS udt_name, enum_row.enumlabel
       FROM pg_catalog.pg_type type_row
       JOIN pg_catalog.pg_enum enum_row ON enum_row.enumtypid = type_row.oid
      ORDER BY type_row.typname, enum_row.enumsortorder`
  );
  for (const label of labels.rows) {
    if (!enumValues.has(label.udt_name)) enumValues.set(label.udt_name, label.enumlabel);
  }
  for (const table of M5_TABLES) {
    const tableColumns = columns.rows.filter((column) => column.table_name === table);
    if (tableColumns.length === 0) throw new Error(`Missing M5 table: ${table}`);
    fixtureColumns.set(
      table,
      tableColumns.filter(
        (column) =>
          column.column_name === 'organizationId' ||
          (column.is_nullable === 'NO' &&
            column.column_default === null &&
            column.is_identity === 'NO' &&
            column.is_generated === 'NEVER') ||
          (table === 'restaurant_drawer_sessions' && column.column_name === 'status')
      )
    );
  }
}

async function insertFixture(
  table: M5Table,
  organizationId: string,
  rowId: string,
  referenceId = rowId
) {
  const columns = fixtureColumns.get(table);
  if (!columns) throw new Error(`Missing M5 fixture metadata for ${table}`);
  const values = columns.map((column) =>
    fixtureValue(table, column, organizationId, rowId, referenceId)
  );
  await client!.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column.column_name}"`).join(', ')})
     VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})`,
    values
  );
}

async function insertPrerequisites(
  organizationId: string,
  rowId: string,
  managerId: string,
  label: string
) {
  await client!.query(
    `INSERT INTO "restaurant_branches" ("id", "organizationId", "name", "updatedAt")
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} branch`]
  );
  await client!.query(
    `INSERT INTO "restaurant_staff_profiles" (
      "id", "organizationId", "displayName", "primaryBranchId", "updatedAt"
    ) VALUES
      ($1, $2, $3, $1, CURRENT_TIMESTAMP),
      ($4, $2, $5, $1, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} operator`, managerId, `${label} manager`]
  );
  await client!.query(
    `INSERT INTO "restaurant_registered_devices" (
      "id", "organizationId", "branchId", "name", "deviceSecretHash", "updatedAt"
    ) VALUES ($1, $2, $1, $3, $4, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} POS`, `device-${rowId}`]
  );
  await client!.query(
    `INSERT INTO "restaurant_co_authorizations" (
      "id", "organizationId", "actingStaffProfileId", "approvingStaffProfileId",
      "capability", "reason"
    ) VALUES ($1, $2, $1, $3, 'money:refund', $4)`,
    [rowId, organizationId, managerId, `${label} fixture`]
  );
  await client!.query(
    `INSERT INTO "restaurant_products" ("id", "organizationId", "name", "updatedAt")
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} product`]
  );
  await client!.query(
    `INSERT INTO "restaurant_orders" (
      "id", "organizationId", "branchId", "orderNumber", "businessDate", "channel",
      "staffProfileId", "deviceId", "updatedAt"
    ) VALUES ($1, $2, $1, 1, DATE '2030-01-01', 'DINE_IN', $1, $1, CURRENT_TIMESTAMP)`,
    [rowId, organizationId]
  );
  await client!.query(
    `INSERT INTO "restaurant_order_items" (
      "id", "organizationId", "orderId", "productId", "name", "unitPrice", "updatedAt"
    ) VALUES ($1, $2, $1, $1, $3, 1.00, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} item`]
  );
}

async function expectDatabaseError(code: string, run: () => Promise<unknown>) {
  await client!.query('SAVEPOINT expected_failure');
  try {
    await run();
    throw new Error(`Expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  } finally {
    await client!.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client!.query('RELEASE SAVEPOINT expected_failure');
  }
}

describeIfDatabase('M5 cross-tenant RLS probes (real PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(TEST_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run M5 RLS probes against a non-local database.');
    }

    await client!.connect();
    const role = await client!.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user`
    );
    if (!role.rows[0] || role.rows[0].rolsuper || role.rows[0].rolbypassrls) {
      throw new Error('M5 RLS probes require an unprivileged TEST_DATABASE_URL role.');
    }

    await client!.query('BEGIN');
    await client!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client!.query(
      `INSERT INTO "organizations" (
        "id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt"
      ) VALUES
        ($1, $2, 'M5 Tenant A', 'M5 Tenant A', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, $4, 'M5 Tenant B', 'M5 Tenant B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.orgA, `m5-a-${suffix}`, ids.orgB, `m5-b-${suffix}`]
    );
    await insertPrerequisites(ids.orgA, ids.rowA, ids.managerA, 'A');
    await insertPrerequisites(ids.orgB, ids.rowB, ids.managerB, 'B');
    await loadFixtureMetadata();
    for (const table of M5_TABLES) await insertFixture(table, ids.orgA, ids.rowA);
    for (const table of M5_TABLES) await insertFixture(table, ids.orgB, ids.rowB);

    await client!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [ids.orgA]);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    await client.end();
  });

  it('pins forced RLS on all 12 M5 tables', async () => {
    const result = await client!.query<{
      table_name: string;
      rls_enabled: boolean;
      rls_forced: boolean;
    }>(
      `SELECT table_row.relname AS table_name,
              table_row.relrowsecurity AS rls_enabled,
              table_row.relforcerowsecurity AS rls_forced
         FROM pg_catalog.pg_class table_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
        WHERE namespace_row.nspname = 'public' AND table_row.relname = ANY($1::text[])
        ORDER BY table_row.relname`,
      [[...M5_TABLES]]
    );
    expect(result.rows).toEqual(
      [...M5_TABLES]
        .sort()
        .map((table_name) => ({ table_name, rls_enabled: true, rls_forced: true }))
    );
  });

  it.each(M5_TABLES)('%s isolates tenant B reads, updates, and deletes', async (table) => {
    const visible = await client!.query<{ id: string; organizationId: string }>(
      `SELECT "id", "organizationId" FROM "${table}" WHERE "id" IN ($1, $2)`,
      [ids.rowA, ids.rowB]
    );
    expect(visible.rows).toEqual([{ id: ids.rowA, organizationId: ids.orgA }]);
    expect(
      (
        await client!.query(
          `UPDATE "${table}" SET "organizationId" = "organizationId" WHERE "id" = $1`,
          [ids.rowB]
        )
      ).rowCount
    ).toBe(0);
    expect(
      (await client!.query(`DELETE FROM "${table}" WHERE "id" = $1`, [ids.rowB])).rowCount
    ).toBe(0);
  });

  it.each(M5_TABLES)('%s rejects a tenant-B insert under tenant-A scope', async (table) => {
    await expectDatabaseError('42501', () =>
      insertFixture(table, ids.orgB, `deny_${table}_${suffix}`, ids.rowB)
    );
  });

  it.each(APPEND_ONLY_TABLES)('%s denies tenant-A UPDATE and DELETE', async (table) => {
    const update = () =>
      client!.query(`UPDATE "${table}" SET "organizationId" = "organizationId" WHERE "id" = $1`, [
        ids.rowA,
      ]);
    if (table === 'restaurant_refunds') {
      await expectDatabaseError('55000', update);
    } else {
      expect((await update()).rowCount).toBe(0);
    }
    expect(
      (await client!.query(`DELETE FROM "${table}" WHERE "id" = $1`, [ids.rowA])).rowCount
    ).toBe(0);
  });
});
