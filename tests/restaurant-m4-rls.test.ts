import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runtimeUrl = process.env.WHA910_TEST_RUNTIME_DATABASE_URL;
const ownerUrl = process.env.WHA910_TEST_OWNER_DATABASE_URL;
if (!runtimeUrl || !ownerUrl) {
  throw new Error(
    'WHA910_TEST_RUNTIME_DATABASE_URL and WHA910_TEST_OWNER_DATABASE_URL are required'
  );
}
if (runtimeUrl === ownerUrl) throw new Error('Runtime and owner database URLs must differ');
const client = new pg.Client({ connectionString: runtimeUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  orgA: `org_m4_a_${suffix}`,
  orgB: `org_m4_b_${suffix}`,
  rowA: `m4_a_${suffix}`,
  rowB: `m4_b_${suffix}`,
};

const M4_TABLES = [
  'restaurant_floors',
  'restaurant_tables',
  'restaurant_server_sections',
  'restaurant_server_section_tables',
  'restaurant_server_section_assignments',
  'restaurant_kitchen_stations',
  'restaurant_station_routing_rules',
  'restaurant_orders',
  'restaurant_order_items',
  'restaurant_order_item_modifiers',
  'restaurant_order_tables',
  'restaurant_order_events',
  'restaurant_event_outbox',
  'restaurant_order_idempotency_keys',
  'restaurant_kitchen_tickets',
  'restaurant_kitchen_ticket_items',
  'restaurant_order_number_sequences',
] as const;

type M4Table = (typeof M4_TABLES)[number];
type FixtureColumn = {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  is_identity: 'YES' | 'NO';
  is_generated: 'ALWAYS' | 'NEVER';
};

const fixtureColumns = new Map<M4Table, FixtureColumn[]>();
const enumValues = new Map<string, string>();

function fixtureValue(
  column: FixtureColumn,
  organizationId: string,
  rowId: string,
  referenceId: string
) {
  if (column.column_name === 'organizationId') return organizationId;
  if (column.column_name === 'id') return rowId;
  if (column.column_name.endsWith('Id')) return referenceId;
  if (column.data_type === 'USER-DEFINED') {
    const value = enumValues.get(column.udt_name);
    if (!value) throw new Error(`No enum fixture value for ${column.udt_name}`);
    return value;
  }
  if (column.data_type === 'ARRAY') return [];
  if (column.data_type === 'boolean') return false;
  if (
    ['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision'].includes(
      column.data_type
    )
  ) {
    return rowId === referenceId ? 1 : 2;
  }
  if (column.data_type === 'date') return rowId === referenceId ? '2030-01-01' : '2030-01-02';
  if (column.data_type.startsWith('timestamp')) return new Date('2030-01-01T00:00:00Z');
  if (column.data_type.startsWith('time')) return '12:00:00';
  if (['json', 'jsonb'].includes(column.data_type)) return {};
  if (column.data_type === 'uuid') return randomUUID();
  if (['character', 'character varying', 'text'].includes(column.data_type))
    return `Fixture ${rowId}`;
  throw new Error(`No M4 fixture value for ${column.column_name} (${column.data_type})`);
}

async function loadFixtureMetadata() {
  const columns = await client!.query<FixtureColumn & { table_name: M4Table }>(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable,
            column_default, is_identity, is_generated
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [[...M4_TABLES]]
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
  for (const table of M4_TABLES) {
    const tableColumns = columns.rows.filter((column) => column.table_name === table);
    if (tableColumns.length === 0) throw new Error(`Missing M4 table: ${table}`);
    fixtureColumns.set(
      table,
      tableColumns.filter(
        (column) =>
          column.column_name === 'organizationId' ||
          (column.is_nullable === 'NO' &&
            column.column_default === null &&
            column.is_identity === 'NO' &&
            column.is_generated === 'NEVER') ||
          (table === 'restaurant_station_routing_rules' && column.column_name === 'productId')
      )
    );
  }
}

async function insertFixture(
  database: pg.Client,
  table: M4Table,
  organizationId: string,
  rowId: string,
  referenceId = rowId
) {
  const columns = fixtureColumns.get(table);
  if (!columns) throw new Error(`Missing M4 fixture metadata for ${table}`);
  const values = columns.map((column) => fixtureValue(column, organizationId, rowId, referenceId));
  await database.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column.column_name}"`).join(', ')})
     VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})`,
    values
  );
}

async function insertBaseFixtures(organizationId: string, rowId: string, label: string) {
  await client!.query(
    `INSERT INTO "restaurant_staff_profiles" (
      "id", "organizationId", "displayName", "primaryBranchId", "updatedAt"
    ) VALUES ($1, $2, $3, $1, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} operator`]
  );
  await client!.query(
    `INSERT INTO "restaurant_registered_devices" (
      "id", "organizationId", "branchId", "name", "deviceSecretHash", "updatedAt"
    ) VALUES ($1, $2, $1, $3, $4, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} POS`, `device-${rowId}`]
  );
  await client!.query(
    `INSERT INTO "restaurant_terminal_sessions" (
      "id", "organizationId", "deviceId", "activeStaffProfileId", "tokenHash", "updatedAt"
    ) VALUES ($1, $2, $1, $1, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `session-${rowId}`]
  );
  await client!.query(
    `INSERT INTO "restaurant_brands" ("id", "organizationId", "name", "updatedAt")
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} brand`]
  );
  await client!.query(
    `INSERT INTO "restaurant_categories" ("id", "organizationId", "name", "updatedAt")
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} category`]
  );
  await client!.query(
    `INSERT INTO "restaurant_products" (
      "id", "organizationId", "categoryId", "name", "updatedAt"
    ) VALUES ($1, $2, $1, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} product`]
  );
  await client!.query(
    `INSERT INTO "restaurant_product_variants" (
      "id", "organizationId", "productId", "name", "updatedAt"
    ) VALUES ($1, $2, $1, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} variant`]
  );
  await client!.query(
    `INSERT INTO "restaurant_modifier_groups" ("id", "organizationId", "name", "updatedAt")
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} modifiers`]
  );
  await client!.query(
    `INSERT INTO "restaurant_modifier_options" (
      "id", "organizationId", "modifierGroupId", "name", "updatedAt"
    ) VALUES ($1, $2, $1, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} modifier`]
  );
  await client!.query(
    `INSERT INTO "restaurant_price_lists" ("id", "organizationId", "name", "updatedAt")
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} prices`]
  );
  await client!.query(
    `INSERT INTO "restaurant_price_list_versions" (
      "id", "organizationId", "priceListId", "versionNumber", "effectiveFrom", "updatedAt"
    ) VALUES ($1, $2, $1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [rowId, organizationId]
  );
  await client!.query(
    `INSERT INTO "restaurant_menus" (
      "id", "organizationId", "brandId", "name", "updatedAt"
    ) VALUES ($1, $2, $1, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} menu`]
  );
  await client!.query(
    `INSERT INTO "restaurant_branch_menu_publications" (
      "id", "organizationId", "branchId", "menuId", "priceListId", "updatedAt"
    ) VALUES ($1, $2, $1, $1, $1, CURRENT_TIMESTAMP)`,
    [rowId, organizationId]
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

describe('M4 cross-tenant RLS probes (real PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(runtimeUrl);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run M4 RLS probes against a non-local database.');
    }

    await client.connect();
    await client.query('BEGIN');
    await client!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client!.query(
      `INSERT INTO "organizations" (
        "id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt"
      ) VALUES
        ($1, $2, 'M4 Tenant A', 'M4 Tenant A', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, $4, 'M4 Tenant B', 'M4 Tenant B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.orgA, `m4-a-${suffix}`, ids.orgB, `m4-b-${suffix}`]
    );
    await client!.query(
      `INSERT INTO "restaurant_branches" ("id", "organizationId", "name", "updatedAt") VALUES
        ($1, $2, 'M4 A', CURRENT_TIMESTAMP), ($3, $4, 'M4 B', CURRENT_TIMESTAMP)`,
      [ids.rowA, ids.orgA, ids.rowB, ids.orgB]
    );
    await insertBaseFixtures(ids.orgA, ids.rowA, 'A');
    await insertBaseFixtures(ids.orgB, ids.rowB, 'B');
    await loadFixtureMetadata();
    for (const table of M4_TABLES) await insertFixture(client!, table, ids.orgA, ids.rowA);
    for (const table of M4_TABLES) await insertFixture(client!, table, ids.orgB, ids.rowB);

    await client!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [ids.orgA]);
  }, 60_000);

  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('uses a LOGIN NOSUPERUSER NOBYPASSRLS runtime role', async () => {
    const roleFlags = await client.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>('SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(roleFlags.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
  });

  it('pins the exact 17-table M4 allowlist, forced RLS, and tenant policies', async () => {
    const result = await client!.query<{
      table_name: string;
      rls_enabled: boolean;
      rls_forced: boolean;
      policy_names: string[];
    }>(
      `SELECT table_row.relname AS table_name,
              table_row.relrowsecurity AS rls_enabled,
              table_row.relforcerowsecurity AS rls_forced,
              array_agg(policy_row.polname::text ORDER BY policy_row.polname) AS policy_names
         FROM pg_catalog.pg_class table_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
         LEFT JOIN pg_catalog.pg_policy policy_row ON policy_row.polrelid = table_row.oid
        WHERE namespace_row.nspname = 'public' AND table_row.relname = ANY($1::text[])
        GROUP BY table_row.relname, table_row.relrowsecurity, table_row.relforcerowsecurity
        ORDER BY table_row.relname`,
      [[...M4_TABLES]]
    );

    expect(result.rows).toEqual(
      [...M4_TABLES].sort().map((table_name) => ({
        table_name,
        rls_enabled: true,
        rls_forced: true,
        policy_names:
          table_name === 'restaurant_order_events'
            ? ['tenant_isolation_insert', 'tenant_isolation_select']
            : ['tenant_isolation'],
      }))
    );
  });

  it.each(M4_TABLES.filter((table) => table !== 'restaurant_order_events'))(
    '%s permits tenant A reads, inserts, updates, and deletes and hides tenant B',
    async (table) => {
      const visible = await client!.query<{ id: string; organizationId: string }>(
        `SELECT "id", "organizationId" FROM "${table}" WHERE "id" IN ($1, $2)`,
        [ids.rowA, ids.rowB]
      );
      expect(visible.rows).toEqual([{ id: ids.rowA, organizationId: ids.orgA }]);
      expect(
        (
          await client!.query(
            `UPDATE "${table}" SET "organizationId" = "organizationId" WHERE "id" = $1`,
            [ids.rowA]
          )
        ).rowCount
      ).toBe(1);
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
      const allowedId = `allow_${table}_${suffix}`;
      await insertFixture(client!, table, ids.orgA, allowedId, ids.rowA);
      expect(
        (await client!.query(`DELETE FROM "${table}" WHERE "id" = $1`, [allowedId])).rowCount
      ).toBe(1);
    }
  );

  it('permits tenant reads and inserts but denies updates and deletes for restaurant_order_events', async () => {
    const visible = await client!.query<{ id: string; organizationId: string }>(
      `SELECT "id", "organizationId" FROM "restaurant_order_events" WHERE "id" IN ($1, $2)`,
      [ids.rowA, ids.rowB]
    );
    expect(visible.rows).toEqual([{ id: ids.rowA, organizationId: ids.orgA }]);

    const allowedId = `allow_restaurant_order_events_${suffix}`;
    await insertFixture(client!, 'restaurant_order_events', ids.orgA, allowedId, ids.rowA);
    expect(
      (
        await client!.query(
          `UPDATE "restaurant_order_events" SET "organizationId" = "organizationId" WHERE "id" = $1`,
          [allowedId]
        )
      ).rowCount
    ).toBe(0);
    expect(
      (await client!.query(`DELETE FROM "restaurant_order_events" WHERE "id" = $1`, [allowedId]))
        .rowCount
    ).toBe(0);
  });

  it.each(M4_TABLES.filter((table) => table !== 'restaurant_order_events'))(
    '%s rejects INSERT and UPDATE tenant escape via WITH CHECK',
    async (table) => {
      await expectDatabaseError('42501', () =>
        insertFixture(client!, table, ids.orgB, `deny_${table}_${suffix}`, ids.rowB)
      );
      await expectDatabaseError('42501', () =>
        client!.query(`UPDATE "${table}" SET "organizationId" = $1 WHERE "id" = $2`, [
          ids.orgB,
          ids.rowA,
        ])
      );
    }
  );
});
