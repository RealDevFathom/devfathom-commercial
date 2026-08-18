import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const client = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const role = `devfathom_m3_${suffix}`;
const ids = {
  orgA: `org_m3_a_${suffix}`,
  orgB: `org_m3_b_${suffix}`,
  rowA: `m3_a_${suffix}`,
  rowB: `m3_b_${suffix}`,
};

const M3_TABLES = [
  'restaurant_brands',
  'restaurant_categories',
  'restaurant_products',
  'restaurant_product_variants',
  'restaurant_modifier_groups',
  'restaurant_modifier_options',
  'restaurant_product_modifier_groups',
  'restaurant_combo_component_groups',
  'restaurant_combo_component_options',
  'restaurant_units',
  'restaurant_unit_conversions',
  'restaurant_allergens',
  'restaurant_product_allergens',
  'restaurant_ingredient_allergens',
  'restaurant_ingredients',
  'restaurant_recipes',
  'restaurant_recipe_versions',
  'restaurant_recipe_lines',
  'restaurant_price_lists',
  'restaurant_price_list_versions',
  'restaurant_price_list_entries',
  'restaurant_menus',
  'restaurant_menu_sections',
  'restaurant_menu_items',
  'restaurant_branch_menu_publications',
  'restaurant_menu_availability_windows',
  'restaurant_menu_availability_exceptions',
  'restaurant_branch_menu_item_overrides',
] as const;

type M3Table = (typeof M3_TABLES)[number];

const FIXTURES: ReadonlyArray<readonly [M3Table, readonly string[]]> = [
  ['restaurant_brands', ['id', 'organizationId', 'name', 'updatedAt']],
  ['restaurant_categories', ['id', 'organizationId', 'name', 'updatedAt']],
  ['restaurant_products', ['id', 'organizationId', 'name', 'updatedAt']],
  ['restaurant_product_variants', ['id', 'organizationId', 'productId', 'name', 'updatedAt']],
  ['restaurant_modifier_groups', ['id', 'organizationId', 'name', 'updatedAt']],
  ['restaurant_modifier_options', ['id', 'organizationId', 'modifierGroupId', 'name', 'updatedAt']],
  [
    'restaurant_product_modifier_groups',
    ['id', 'organizationId', 'productId', 'modifierGroupId', 'updatedAt'],
  ],
  [
    'restaurant_combo_component_groups',
    ['id', 'organizationId', 'comboProductId', 'name', 'updatedAt'],
  ],
  [
    'restaurant_combo_component_options',
    ['id', 'organizationId', 'componentGroupId', 'productId', 'updatedAt'],
  ],
  ['restaurant_units', ['id', 'organizationId', 'name', 'updatedAt']],
  [
    'restaurant_unit_conversions',
    ['id', 'organizationId', 'fromUnitId', 'toUnitId', 'factor', 'updatedAt'],
  ],
  ['restaurant_allergens', ['id', 'organizationId', 'name', 'updatedAt']],
  ['restaurant_ingredients', ['id', 'organizationId', 'name', 'baseUnitId', 'updatedAt']],
  ['restaurant_product_allergens', ['id', 'organizationId', 'productId', 'allergenId']],
  ['restaurant_ingredient_allergens', ['id', 'organizationId', 'ingredientId', 'allergenId']],
  ['restaurant_recipes', ['id', 'organizationId', 'productId', 'name', 'updatedAt']],
  [
    'restaurant_recipe_versions',
    ['id', 'organizationId', 'recipeId', 'versionNumber', 'updatedAt'],
  ],
  [
    'restaurant_recipe_lines',
    ['id', 'organizationId', 'recipeVersionId', 'ingredientId', 'quantity', 'unitId', 'updatedAt'],
  ],
  ['restaurant_price_lists', ['id', 'organizationId', 'name', 'updatedAt']],
  [
    'restaurant_price_list_versions',
    ['id', 'organizationId', 'priceListId', 'versionNumber', 'effectiveFrom', 'updatedAt'],
  ],
  [
    'restaurant_price_list_entries',
    ['id', 'organizationId', 'priceListVersionId', 'productId', 'price', 'updatedAt'],
  ],
  ['restaurant_menus', ['id', 'organizationId', 'brandId', 'name', 'updatedAt']],
  ['restaurant_menu_sections', ['id', 'organizationId', 'menuId', 'name', 'updatedAt']],
  ['restaurant_menu_items', ['id', 'organizationId', 'sectionId', 'productId', 'updatedAt']],
  [
    'restaurant_branch_menu_publications',
    ['id', 'organizationId', 'branchId', 'menuId', 'updatedAt'],
  ],
  [
    'restaurant_menu_availability_windows',
    ['id', 'organizationId', 'publicationId', 'startMinutes', 'endMinutes', 'updatedAt'],
  ],
  [
    'restaurant_menu_availability_exceptions',
    ['id', 'organizationId', 'publicationId', 'date', 'updatedAt'],
  ],
  [
    'restaurant_branch_menu_item_overrides',
    ['id', 'organizationId', 'publicationId', 'menuItemId', 'updatedAt'],
  ],
];

function fixtureValue(column: string, organizationId: string, rowId: string, referenceId: string) {
  if (column === 'organizationId') return organizationId;
  if (column === 'id') return rowId;
  if (column.endsWith('Id')) return referenceId;
  if (column === 'name') return `Fixture ${rowId}`;
  if (column === 'startMinutes') return 0;
  if (column === 'endMinutes') return 60;
  if (['factor', 'price', 'quantity', 'versionNumber'].includes(column)) return 1;
  if (column === 'date') return '2030-01-01';
  if (['effectiveFrom', 'updatedAt'].includes(column)) return new Date('2030-01-01T00:00:00Z');
  throw new Error(`No M3 fixture value for ${column}`);
}

async function insertFixture(
  database: pg.Client,
  table: M3Table,
  organizationId: string,
  rowId: string,
  referenceId = rowId
) {
  const columns = FIXTURES.find(([fixtureTable]) => fixtureTable === table)?.[1];
  if (!columns) throw new Error(`Missing M3 fixture for ${table}`);
  const values = columns.map((column) => fixtureValue(column, organizationId, rowId, referenceId));
  await database.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})`,
    values
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

describeIfDatabase('M3 cross-tenant RLS probes (real PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(TEST_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run M3 RLS probes against a non-local database.');
    }

    expect([...FIXTURES.map(([table]) => table)].sort()).toEqual([...M3_TABLES].sort());

    await client!.connect();
    await client!.query('BEGIN');
    await client!.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client!.query(`GRANT "${role}" TO CURRENT_USER`);
    await client!.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client!.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${M3_TABLES.map((table) => `"${table}"`).join(', ')} TO "${role}"`
    );
    await client!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client!.query(
      `INSERT INTO "organizations" (
        "id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt"
      ) VALUES
        ($1, $2, 'M3 Tenant A', 'M3 Tenant A', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, $4, 'M3 Tenant B', 'M3 Tenant B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.orgA, `m3-a-${suffix}`, ids.orgB, `m3-b-${suffix}`]
    );
    await client!.query(
      `INSERT INTO "restaurant_branches" ("id", "organizationId", "name", "updatedAt") VALUES
        ($1, $2, 'M3 A', CURRENT_TIMESTAMP), ($3, $4, 'M3 B', CURRENT_TIMESTAMP)`,
      [ids.rowA, ids.orgA, ids.rowB, ids.orgB]
    );
    for (const [table] of FIXTURES) await insertFixture(client!, table, ids.orgA, ids.rowA);
    for (const [table] of FIXTURES) await insertFixture(client!, table, ids.orgB, ids.rowB);

    await client!.query(`SET LOCAL ROLE "${role}"`);
    await client!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [ids.orgA]);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    await client.end();
  });

  it('pins the exact 28-table M3 allowlist and forced-RLS flags', async () => {
    const result = await client!.query<{
      table_name: string;
      rls_enabled: boolean;
      rls_forced: boolean;
    }>(
      `SELECT c.relname AS table_name,
              c.relrowsecurity AS rls_enabled,
              c.relforcerowsecurity AS rls_forced
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      [[...M3_TABLES]]
    );

    expect(result.rows).toEqual(
      [...M3_TABLES]
        .sort()
        .map((table_name) => ({ table_name, rls_enabled: true, rls_forced: true }))
    );
  });

  it.each(M3_TABLES)('%s permits tenant A writes and hides tenant B', async (table) => {
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
  });

  it.each(M3_TABLES)('%s rejects INSERT and UPDATE tenant escape via WITH CHECK', async (table) => {
    await expectDatabaseError('42501', () =>
      insertFixture(client!, table, ids.orgB, `deny_${table}_${suffix}`, ids.rowB)
    );
    await expectDatabaseError('42501', () =>
      client!.query(`UPDATE "${table}" SET "organizationId" = $1 WHERE "id" = $2`, [
        ids.orgB,
        ids.rowA,
      ])
    );
  });

  it.each(M3_TABLES)(
    '%s remains reachable through the platform-admin policy path',
    async (table) => {
      await client!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      try {
        const visible = await client!.query<{ id: string }>(
          `SELECT "id" FROM "${table}" WHERE "id" IN ($1, $2) ORDER BY "id"`,
          [ids.rowA, ids.rowB]
        );
        expect(visible.rows).toEqual([{ id: ids.rowA }, { id: ids.rowB }]);
        expect(
          (
            await client!.query(
              `UPDATE "${table}" SET "organizationId" = "organizationId" WHERE "id" = $1`,
              [ids.rowB]
            )
          ).rowCount
        ).toBe(1);
      } finally {
        await client!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
      }
    }
  );
});
