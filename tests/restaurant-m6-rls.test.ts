import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const client = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  orgA: `org_m6_a_${suffix}`,
  orgB: `org_m6_b_${suffix}`,
  rowA: `m6_a_${suffix}`,
  rowB: `m6_b_${suffix}`,
  destinationA: `m6_destination_a_${suffix}`,
  destinationB: `m6_destination_b_${suffix}`,
};

const M6_TABLES = [
  'restaurant_stock_locations',
  'restaurant_stock_items',
  'restaurant_stock_movements',
  'restaurant_stock_batches',
  'restaurant_stock_counts',
  'restaurant_stock_count_lines',
  'restaurant_stock_transfers',
  'restaurant_stock_transfer_lines',
  'restaurant_low_stock_rules',
  'restaurant_suppliers',
  'restaurant_purchase_orders',
  'restaurant_purchase_order_lines',
  'restaurant_purchase_receipts',
  'restaurant_purchase_receipt_lines',
  'restaurant_receiving_discrepancies',
  'restaurant_inventory_idempotency_keys',
] as const;

type M6Table = (typeof M6_TABLES)[number];
type FixtureColumn = {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  is_identity: 'YES' | 'NO';
  is_generated: 'ALWAYS' | 'NEVER';
};

const fixtureColumns = new Map<M6Table, FixtureColumn[]>();
const enumValues = new Map<string, string>();

function fixtureValue(
  column: FixtureColumn,
  organizationId: string,
  rowId: string,
  referenceId: string
) {
  if (column.column_name === 'organizationId') return organizationId;
  if (column.column_name === 'id') return rowId;
  if (column.column_name === 'destinationLocationId') {
    return organizationId === ids.orgA ? ids.destinationA : ids.destinationB;
  }
  if (column.column_name.endsWith('Id')) return referenceId;
  if (column.data_type === 'USER-DEFINED') {
    const value = enumValues.get(column.udt_name);
    if (!value) throw new Error(`No enum fixture value for ${column.udt_name}`);
    return value;
  }
  if (column.data_type === 'boolean') return false;
  if (column.data_type === 'numeric') return rowId === referenceId ? '1.000000' : '2.000000';
  if (['smallint', 'integer', 'bigint'].includes(column.data_type)) {
    return rowId === referenceId ? 1 : 2;
  }
  if (column.data_type === 'date') return rowId === referenceId ? '2030-01-01' : '2030-01-02';
  if (column.data_type.startsWith('timestamp')) return new Date('2030-01-01T00:00:00Z');
  if (['json', 'jsonb'].includes(column.data_type)) return {};
  if (['character', 'character varying', 'text'].includes(column.data_type)) {
    return `${column.column_name}_${rowId}`;
  }
  throw new Error(`No M6 fixture value for ${column.column_name} (${column.data_type})`);
}

async function loadFixtureMetadata() {
  const columns = await client!.query<FixtureColumn & { table_name: M6Table }>(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable,
            column_default, is_identity, is_generated
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [[...M6_TABLES]]
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
  for (const table of M6_TABLES) {
    const tableColumns = columns.rows.filter((column) => column.table_name === table);
    if (tableColumns.length === 0) throw new Error(`Missing M6 table: ${table}`);
    fixtureColumns.set(
      table,
      tableColumns.filter(
        (column) =>
          column.column_name === 'organizationId' ||
          (column.is_nullable === 'NO' &&
            column.column_default === null &&
            column.is_identity === 'NO' &&
            column.is_generated === 'NEVER')
      )
    );
  }
}

async function insertFixture(
  table: M6Table,
  organizationId: string,
  rowId: string,
  referenceId = rowId
) {
  const columns = fixtureColumns.get(table);
  if (!columns) throw new Error(`Missing M6 fixture metadata for ${table}`);
  const values = columns.map((column) => fixtureValue(column, organizationId, rowId, referenceId));
  await client!.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column.column_name}"`).join(', ')})
     VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})`,
    values
  );
}

async function insertPrerequisites(organizationId: string, rowId: string, label: string) {
  await client!.query(
    `INSERT INTO "restaurant_branches" ("id", "organizationId", "name", "updatedAt")
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} branch`]
  );
  await client!.query(
    `INSERT INTO "restaurant_units" ("id", "organizationId", "name", "updatedAt")
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} unit`]
  );
  await client!.query(
    `INSERT INTO "restaurant_ingredients" (
      "id", "organizationId", "name", "baseUnitId", "updatedAt"
    ) VALUES ($1, $2, $3, $1, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} ingredient`]
  );
}

async function insertTenantFixtures(organizationId: string, rowId: string, destinationId: string) {
  for (const table of M6_TABLES) {
    await insertFixture(table, organizationId, rowId);
    if (table === 'restaurant_stock_locations') {
      await insertFixture(table, organizationId, destinationId, rowId);
    }
  }
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

describeIfDatabase('M6 cross-tenant RLS probes (real PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(TEST_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run M6 RLS probes against a non-local database.');
    }

    await client!.connect();
    const role = await client!.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user`
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    await client!.query('BEGIN');
    await client!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client!.query(
      `INSERT INTO "organizations" (
        "id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt"
      ) VALUES
        ($1, $2, 'M6 Tenant A', 'M6 Tenant A', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, $4, 'M6 Tenant B', 'M6 Tenant B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.orgA, `m6-a-${suffix}`, ids.orgB, `m6-b-${suffix}`]
    );
    await insertPrerequisites(ids.orgA, ids.rowA, 'A');
    await insertPrerequisites(ids.orgB, ids.rowB, 'B');
    await loadFixtureMetadata();
    await insertTenantFixtures(ids.orgA, ids.rowA, ids.destinationA);
    await insertTenantFixtures(ids.orgB, ids.rowB, ids.destinationB);

    await client!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [ids.orgA]);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    await client.end();
  });

  it.each(M6_TABLES)('%s isolates tenant B reads, updates, and deletes', async (table) => {
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

  it.each(M6_TABLES)('%s rejects a tenant-B insert under tenant-A scope', async (table) => {
    await expectDatabaseError('42501', () =>
      insertFixture(table, ids.orgB, `deny_${table}_${suffix}`, ids.rowB)
    );
  });

  it('permits a signed negative stock movement and keeps it visible (D07)', async () => {
    const movementId = `negative_m6_${suffix}`;
    await client!.query(
      `INSERT INTO "restaurant_stock_movements" (
        "id", "organizationId", "stockItemId", "locationId", "reason", "quantity"
      ) VALUES ($1, $2, $3, $3, 'MANUAL_CORRECTION', -1.250000)`,
      [movementId, ids.orgA, ids.rowA]
    );
    const visible = await client!.query<{ id: string; quantity: string }>(
      `SELECT "id", "quantity"::text AS quantity
         FROM "restaurant_stock_movements"
        WHERE "id" = $1`,
      [movementId]
    );
    expect(visible.rows).toEqual([{ id: movementId, quantity: '-1.250000' }]);
  });

  it('denies tenant-A stock movement UPDATE and DELETE', async () => {
    expect(
      (
        await client!.query(
          `UPDATE "restaurant_stock_movements"
              SET "quantity" = "quantity"
            WHERE "id" = $1`,
          [ids.rowA]
        )
      ).rowCount
    ).toBe(0);
    expect(
      (await client!.query(`DELETE FROM "restaurant_stock_movements" WHERE "id" = $1`, [ids.rowA]))
        .rowCount
    ).toBe(0);
  });
});
