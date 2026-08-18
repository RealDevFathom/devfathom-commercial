import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const client = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);

const BASE_RESTAURANT_TABLES = [
  'restaurant_branches',
  'restaurant_branch_assignments',
  'restaurant_staff_profiles',
  'restaurant_operator_credentials',
  'restaurant_registered_devices',
  'restaurant_terminal_sessions',
  'restaurant_co_authorizations',
] as const;

const M3_COLUMNS = {
  restaurant_brands: [
    'id',
    'organizationId',
    'name',
    'nameLocalized',
    'status',
    'isDefault',
    'createdAt',
    'updatedAt',
  ],
  restaurant_categories: [
    'id',
    'organizationId',
    'parentId',
    'name',
    'nameLocalized',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_products: [
    'id',
    'organizationId',
    'categoryId',
    'type',
    'status',
    'name',
    'nameLocalized',
    'description',
    'descriptionLocalized',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_product_variants: [
    'id',
    'organizationId',
    'productId',
    'name',
    'nameLocalized',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_modifier_groups: [
    'id',
    'organizationId',
    'name',
    'nameLocalized',
    'minSelect',
    'maxSelect',
    'createdAt',
    'updatedAt',
  ],
  restaurant_modifier_options: [
    'id',
    'organizationId',
    'modifierGroupId',
    'name',
    'nameLocalized',
    'priceDelta',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_product_modifier_groups: [
    'id',
    'organizationId',
    'productId',
    'modifierGroupId',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_combo_component_groups: [
    'id',
    'organizationId',
    'comboProductId',
    'name',
    'nameLocalized',
    'minChoose',
    'maxChoose',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_combo_component_options: [
    'id',
    'organizationId',
    'componentGroupId',
    'productId',
    'variantId',
    'priceDelta',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_units: ['id', 'organizationId', 'name', 'abbreviation', 'createdAt', 'updatedAt'],
  restaurant_unit_conversions: [
    'id',
    'organizationId',
    'fromUnitId',
    'toUnitId',
    'factor',
    'createdAt',
    'updatedAt',
  ],
  restaurant_allergens: ['id', 'organizationId', 'name', 'nameLocalized', 'createdAt', 'updatedAt'],
  restaurant_product_allergens: ['id', 'organizationId', 'productId', 'allergenId', 'createdAt'],
  restaurant_ingredient_allergens: [
    'id',
    'organizationId',
    'ingredientId',
    'allergenId',
    'createdAt',
  ],
  restaurant_ingredients: [
    'id',
    'organizationId',
    'name',
    'nameLocalized',
    'baseUnitId',
    'referenceCost',
    'createdAt',
    'updatedAt',
  ],
  restaurant_recipes: [
    'id',
    'organizationId',
    'productId',
    'variantId',
    'name',
    'createdAt',
    'updatedAt',
  ],
  restaurant_recipe_versions: [
    'id',
    'organizationId',
    'recipeId',
    'versionNumber',
    'status',
    'yieldQuantity',
    'yieldUnitId',
    'portionCount',
    'notes',
    'activatedAt',
    'supersededAt',
    'createdAt',
    'updatedAt',
  ],
  restaurant_recipe_lines: [
    'id',
    'organizationId',
    'recipeVersionId',
    'ingredientId',
    'subRecipeId',
    'quantity',
    'unitId',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_price_lists: ['id', 'organizationId', 'name', 'isDefault', 'createdAt', 'updatedAt'],
  restaurant_price_list_versions: [
    'id',
    'organizationId',
    'priceListId',
    'versionNumber',
    'effectiveFrom',
    'status',
    'activatedAt',
    'supersededAt',
    'createdAt',
    'updatedAt',
  ],
  restaurant_price_list_entries: [
    'id',
    'organizationId',
    'priceListVersionId',
    'productId',
    'variantId',
    'price',
    'createdAt',
    'updatedAt',
  ],
  restaurant_menus: [
    'id',
    'organizationId',
    'brandId',
    'name',
    'nameLocalized',
    'description',
    'createdAt',
    'updatedAt',
  ],
  restaurant_menu_sections: [
    'id',
    'organizationId',
    'menuId',
    'name',
    'nameLocalized',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_menu_items: [
    'id',
    'organizationId',
    'sectionId',
    'productId',
    'variantId',
    'displayName',
    'nameLocalized',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_branch_menu_publications: [
    'id',
    'organizationId',
    'branchId',
    'menuId',
    'priceListId',
    'status',
    'channels',
    'publishedAt',
    'retiredAt',
    'createdAt',
    'updatedAt',
  ],
  restaurant_menu_availability_windows: [
    'id',
    'organizationId',
    'publicationId',
    'menuItemId',
    'label',
    'daysOfWeek',
    'startMinutes',
    'endMinutes',
    'createdAt',
    'updatedAt',
  ],
  restaurant_menu_availability_exceptions: [
    'id',
    'organizationId',
    'publicationId',
    'date',
    'isClosed',
    'label',
    'createdAt',
    'updatedAt',
  ],
  restaurant_branch_menu_item_overrides: [
    'id',
    'organizationId',
    'publicationId',
    'menuItemId',
    'isAvailable',
    'priceOverride',
    'createdAt',
    'updatedAt',
  ],
} as const;

type M3Table = keyof typeof M3_COLUMNS;
const M3_TABLES = Object.keys(M3_COLUMNS) as M3Table[];
const CANONICAL_TABLES = M3_TABLES.filter(
  (table) =>
    ![
      'restaurant_branch_menu_publications',
      'restaurant_menu_availability_windows',
      'restaurant_menu_availability_exceptions',
      'restaurant_branch_menu_item_overrides',
    ].includes(table)
);

async function readM3Columns() {
  const result = await client!.query<{ table_name: M3Table; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [M3_TABLES]
  );
  return Object.fromEntries(
    M3_TABLES.map((table) => [
      table,
      result.rows.filter((row) => row.table_name === table).map((row) => row.column_name),
    ])
  ) as Record<M3Table, string[]>;
}

describeIfDatabase('M3 schema governance (real PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(TEST_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run M3 governance probes against a non-local database.');
    }
    await client!.connect();
  }, 60_000);

  afterAll(async () => {
    await client?.end();
  });

  it('pins the complete restaurant table and M3 column allowlists', async () => {
    const tables = await client!.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name LIKE 'restaurant\_%' ESCAPE '\\'
        ORDER BY table_name`
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      [...BASE_RESTAURANT_TABLES, ...M3_TABLES].sort()
    );

    expect(await readM3Columns()).toEqual(M3_COLUMNS);
  });

  it('keeps canonical tables branch-free and publication children publication-owned', async () => {
    const columns = await readM3Columns();
    for (const table of CANONICAL_TABLES) {
      expect(columns[table], table).not.toContain('branchId');
      expect(columns[table], table).not.toContain('branch_id');
    }

    expect(
      columns.restaurant_menu_availability_windows.filter((column) => column.endsWith('Id'))
    ).toEqual(['organizationId', 'publicationId', 'menuItemId']);
    expect(
      columns.restaurant_menu_availability_exceptions.filter((column) => column.endsWith('Id'))
    ).toEqual(['organizationId', 'publicationId']);
    expect(
      columns.restaurant_branch_menu_item_overrides.filter((column) => column.endsWith('Id'))
    ).toEqual(['organizationId', 'publicationId', 'menuItemId']);
  });

  it('limits branch item overrides to availability and price data', async () => {
    const columns = await readM3Columns();
    const linkageAndMetadata = new Set([
      'id',
      'organizationId',
      'publicationId',
      'menuItemId',
      'createdAt',
      'updatedAt',
    ]);
    expect(
      columns.restaurant_branch_menu_item_overrides.filter(
        (column) => !linkageAndMetadata.has(column)
      )
    ).toEqual(['isAvailable', 'priceOverride']);
  });

  it('requires tenant-safe publication ownership and canonical references', async () => {
    const result = await client!.query<{
      table_name: string;
      columns: string[];
      referenced_table: string;
      referenced_columns: string[];
      condeferrable: boolean;
      condeferred: boolean;
    }>(
      `SELECT child.relname AS table_name,
              array_agg(child_column.attname ORDER BY key.ordinality) AS columns,
              parent.relname AS referenced_table,
              array_agg(parent_column.attname ORDER BY key.ordinality) AS referenced_columns,
              constraint_row.condeferrable,
              constraint_row.condeferred
         FROM pg_catalog.pg_constraint constraint_row
         JOIN pg_catalog.pg_class child ON child.oid = constraint_row.conrelid
         JOIN pg_catalog.pg_class parent ON parent.oid = constraint_row.confrelid
         CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, ordinality)
         JOIN pg_catalog.pg_attribute child_column
           ON child_column.attrelid = constraint_row.conrelid AND child_column.attnum = key.attnum
         JOIN pg_catalog.pg_attribute parent_column
           ON parent_column.attrelid = constraint_row.confrelid
          AND parent_column.attnum = constraint_row.confkey[key.ordinality]
        WHERE constraint_row.contype = 'f'
          AND child.relname = ANY($1::text[])
        GROUP BY child.relname, parent.relname, constraint_row.oid,
                 constraint_row.condeferrable, constraint_row.condeferred`,
      [
        [
          'restaurant_branch_menu_publications',
          'restaurant_menu_availability_windows',
          'restaurant_menu_availability_exceptions',
          'restaurant_branch_menu_item_overrides',
        ],
      ]
    );
    const composite = result.rows.filter((row) => row.columns.length === 2);
    const signatures = composite.map(
      (row) =>
        `${row.table_name}(${row.columns.join(',')})->${row.referenced_table}(${row.referenced_columns.join(',')})`
    );
    expect(signatures).toEqual(
      expect.arrayContaining([
        'restaurant_branch_menu_publications(organizationId,branchId)->restaurant_branches(organizationId,id)',
        'restaurant_branch_menu_publications(organizationId,menuId)->restaurant_menus(organizationId,id)',
        'restaurant_branch_menu_publications(organizationId,priceListId)->restaurant_price_lists(organizationId,id)',
        'restaurant_menu_availability_windows(organizationId,publicationId)->restaurant_branch_menu_publications(organizationId,id)',
        'restaurant_menu_availability_windows(organizationId,menuItemId)->restaurant_menu_items(organizationId,id)',
        'restaurant_menu_availability_exceptions(organizationId,publicationId)->restaurant_branch_menu_publications(organizationId,id)',
        'restaurant_branch_menu_item_overrides(organizationId,publicationId)->restaurant_branch_menu_publications(organizationId,id)',
        'restaurant_branch_menu_item_overrides(organizationId,menuItemId)->restaurant_menu_items(organizationId,id)',
      ])
    );
    expect(composite.every((row) => row.condeferrable && row.condeferred)).toBe(true);
  });

  it('enforces one default brand under concurrent insert attempts', async () => {
    const index = await client!.query<{ indisunique: boolean; predicate: string | null }>(
      `SELECT index_row.indisunique,
              pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
         FROM pg_catalog.pg_index index_row
         JOIN pg_catalog.pg_class table_row ON table_row.oid = index_row.indrelid
         JOIN pg_catalog.pg_class index_name ON index_name.oid = index_row.indexrelid
        WHERE table_row.relname = 'restaurant_brands'
          AND index_name.relname = 'restaurant_brands_organizationId_default_key'`
    );
    expect(index.rows).toEqual([{ indisunique: true, predicate: '"isDefault"' }]);

    const first = new pg.Client({ connectionString: TEST_DATABASE_URL });
    const second = new pg.Client({ connectionString: TEST_DATABASE_URL });
    const organizationId = `org_m3_default_${suffix}`;
    let firstCommitted = false;

    await Promise.all([first.connect(), second.connect()]);
    try {
      await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
      await Promise.all([
        first.query(`SELECT set_config('app.is_platform_admin', 'true', true)`),
        second.query(`SELECT set_config('app.is_platform_admin', 'true', true)`),
      ]);
      await first.query(
        `INSERT INTO "restaurant_brands" (
          "id", "organizationId", "name", "isDefault", "updatedAt"
        ) VALUES ($1, $2, 'Default A', true, CURRENT_TIMESTAMP)`,
        [`brand_default_a_${suffix}`, organizationId]
      );

      const secondAttempt = second
        .query(
          `INSERT INTO "restaurant_brands" (
            "id", "organizationId", "name", "isDefault", "updatedAt"
          ) VALUES ($1, $2, 'Default B', true, CURRENT_TIMESTAMP)`,
          [`brand_default_b_${suffix}`, organizationId]
        )
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error })
        );
      await first.query('COMMIT');
      firstCommitted = true;

      expect(await secondAttempt).toMatchObject({ ok: false, error: { code: '23505' } });
    } finally {
      await second.query('ROLLBACK').catch(() => undefined);
      await first.query('ROLLBACK').catch(() => undefined);
      if (firstCommitted) {
        await first.query('BEGIN');
        await first.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
        await first.query(`DELETE FROM "restaurant_brands" WHERE "organizationId" = $1`, [
          organizationId,
        ]);
        await first.query('COMMIT');
      }
      await Promise.all([first.end(), second.end()]);
    }
  });
});
