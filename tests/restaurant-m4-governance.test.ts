import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const client = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);

async function uniqueColumnSets(table: string) {
  const result = await client!.query<{ columns: string[] }>(
    `SELECT array_agg(attribute_row.attname::text ORDER BY key_row.ordinality) AS columns
       FROM pg_catalog.pg_index index_row
       JOIN pg_catalog.pg_class table_row ON table_row.oid = index_row.indrelid
       JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
       CROSS JOIN LATERAL unnest(index_row.indkey::smallint[])
         WITH ORDINALITY AS key_row(attnum, ordinality)
       JOIN pg_catalog.pg_attribute attribute_row
         ON attribute_row.attrelid = table_row.oid
        AND attribute_row.attnum = key_row.attnum
      WHERE namespace_row.nspname = 'public'
        AND table_row.relname = $1
        AND index_row.indisunique
        AND index_row.indisvalid
        AND key_row.ordinality <= index_row.indnkeyatts
      GROUP BY index_row.indexrelid`,
    [table]
  );
  return result.rows.map((row) => row.columns);
}

function normalizeCheckDefinition(definition: string) {
  let expression = definition.replace(/^CHECK\s*/i, '').replaceAll(/\s+/g, '');
  while (expression.startsWith('(') && expression.endsWith(')')) {
    let depth = 0;
    let wrapsExpression = true;
    for (let index = 0; index < expression.length - 1; index += 1) {
      if (expression[index] === '(') depth += 1;
      if (expression[index] === ')') depth -= 1;
      if (depth === 0) {
        wrapsExpression = false;
        break;
      }
    }
    if (!wrapsExpression) break;
    expression = expression.slice(1, -1);
  }
  return expression.replaceAll(/\(("(?:productId|categoryId)"IS(?:NOT)?NULL)\)/g, '$1');
}

describeIfDatabase('M4 schema governance (real PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(TEST_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run M4 governance probes against a non-local database.');
    }
    await client!.connect();
  }, 60_000);

  afterAll(async () => {
    await client?.end();
  });

  it.each([
    [
      'RestaurantOrderStatus',
      [
        'DRAFT',
        'OPEN',
        'SENT',
        'IN_PREPARATION',
        'READY',
        'SERVED',
        'PAYMENT_PENDING',
        'CLOSED',
        'CANCELLED',
      ],
    ],
    [
      'RestaurantOrderItemStatus',
      ['HELD', 'QUEUED', 'FIRING', 'PREPARED', 'SERVED', 'REMAKE_REQUESTED', 'VOIDED'],
    ],
  ] as const)('pins the exact %s values', async (typeName, expected) => {
    const result = await client!.query<{ enumlabel: string }>(
      `SELECT enum_row.enumlabel
         FROM pg_catalog.pg_type type_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
         JOIN pg_catalog.pg_enum enum_row ON enum_row.enumtypid = type_row.oid
        WHERE namespace_row.nspname = 'public' AND type_row.typname = $1
        ORDER BY enum_row.enumsortorder`,
      [typeName]
    );
    expect(result.rows.map((row) => row.enumlabel)).toEqual(expected);
  });

  it.each([
    ['restaurant_orders', ['branchId', 'businessDate', 'orderNumber']],
    ['restaurant_order_events', ['orderId', 'sequence']],
    ['restaurant_order_idempotency_keys', ['deviceId', 'key']],
  ] as const)('%s enforces the required unique key', async (table, columns) => {
    expect(await uniqueColumnSets(table)).toContainEqual([...columns]);
  });

  it('keeps order aggregates derived and item sale facts snapshotted', async () => {
    const result = await client!.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('restaurant_orders', 'restaurant_order_items')
        ORDER BY table_name, ordinal_position`
    );
    const orderColumns = result.rows
      .filter((row) => row.table_name === 'restaurant_orders')
      .map((row) => row.column_name);
    const itemColumns = result.rows
      .filter((row) => row.table_name === 'restaurant_order_items')
      .map((row) => row.column_name);

    expect(orderColumns.filter((column) => /total|aggregate/i.test(column))).toEqual([]);
    expect(itemColumns).toEqual(expect.arrayContaining(['name', 'unitPrice']));
  });

  it('enforces one default kitchen station per branch with a partial unique index', async () => {
    const result = await client!.query<{
      columns: string[];
      predicate: string | null;
    }>(
      `SELECT array_agg(attribute_row.attname::text ORDER BY key_row.ordinality) AS columns,
              pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
         FROM pg_catalog.pg_index index_row
         JOIN pg_catalog.pg_class table_row ON table_row.oid = index_row.indrelid
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
         CROSS JOIN LATERAL unnest(index_row.indkey::smallint[])
           WITH ORDINALITY AS key_row(attnum, ordinality)
         JOIN pg_catalog.pg_attribute attribute_row
           ON attribute_row.attrelid = table_row.oid
          AND attribute_row.attnum = key_row.attnum
        WHERE namespace_row.nspname = 'public'
          AND table_row.relname = 'restaurant_kitchen_stations'
          AND index_row.indisunique
          AND index_row.indisvalid
          AND key_row.ordinality <= index_row.indnkeyatts
        GROUP BY index_row.indexrelid, index_row.indpred, index_row.indrelid`
    );

    expect(
      result.rows.some(
        (row) =>
          row.columns.length === 1 &&
          row.columns[0] === 'branchId' &&
          row.predicate === '"isDefault"'
      )
    ).toBe(true);
  });

  it('requires routing rules to target exactly one product, category or positive course', async () => {
    const result = await client!.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(constraint_row.oid) AS definition
         FROM pg_catalog.pg_constraint constraint_row
        WHERE constraint_row.conrelid = 'public.restaurant_station_routing_rules'::regclass
          AND constraint_row.contype = 'c'`
    );
    // 20261022120000_restaurant_course_station_routing deliberately added a
    // positive course as the third mutually exclusive routing target.
    const exactTargetDefinition =
      '(num_nonnulls("productId","categoryId",course)=1)AND((courseISNULL)OR(course>0))';
    expect(result.rows.map((row) => normalizeCheckDefinition(row.definition))).toContain(
      exactTargetDefinition
    );
  });

  it('allocates unique order numbers under concurrent sequence updates', async () => {
    const first = new pg.Client({ connectionString: TEST_DATABASE_URL });
    const second = new pg.Client({ connectionString: TEST_DATABASE_URL });
    const organizationId = `org_m4_sequence_${suffix}`;
    const branchId = `branch_m4_sequence_${suffix}`;
    let organizationInserted = false;
    let branchInserted = false;
    let firstConnected = false;
    let secondConnected = false;

    try {
      await client!.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
      await client!.query(
        `INSERT INTO "organizations" (
          "id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt"
        ) VALUES ($1, $2, 'M4 Sequence', 'M4 Sequence', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [organizationId, `m4-sequence-${suffix}`]
      );
      organizationInserted = true;
      await client!.query(
        `INSERT INTO "restaurant_branches" ("id", "organizationId", "name", "updatedAt")
         VALUES ($1, $2, 'M4 Sequence', CURRENT_TIMESTAMP)`,
        [branchId, organizationId]
      );
      branchInserted = true;

      await Promise.all([first.connect(), second.connect()]);
      firstConnected = true;
      secondConnected = true;
      await Promise.all([
        first.query(`SELECT set_config('app.is_platform_admin', 'true', false)`),
        second.query(`SELECT set_config('app.is_platform_admin', 'true', false)`),
      ]);

      const allocate = (database: pg.Client, id: string) =>
        database.query<{ order_number: number }>(
          `INSERT INTO "restaurant_order_number_sequences" (
            "id", "organizationId", "branchId", "businessDate", "nextNumber", "updatedAt"
          ) VALUES ($1, $2, $3, DATE '2030-01-01', 1, CURRENT_TIMESTAMP)
          ON CONFLICT ("branchId", "businessDate") DO UPDATE
          SET "nextNumber" = "restaurant_order_number_sequences"."nextNumber" + 1,
              "updatedAt" = CURRENT_TIMESTAMP
          RETURNING "nextNumber"::int AS order_number`,
          [id, organizationId, branchId]
        );
      const allocations = await Promise.all([
        allocate(first, `sequence_a_${suffix}`),
        allocate(second, `sequence_b_${suffix}`),
      ]);
      const numbers = allocations.map((result) => result.rows[0]!.order_number);
      expect(new Set(numbers).size).toBe(2);
      expect(numbers.sort((left, right) => left - right)).toEqual([1, 2]);
    } finally {
      await Promise.allSettled([
        ...(firstConnected ? [first.end()] : []),
        ...(secondConnected ? [second.end()] : []),
      ]);
      if (branchInserted) {
        await client!
          .query(`DELETE FROM "restaurant_order_number_sequences" WHERE "branchId" = $1`, [
            branchId,
          ])
          .catch(() => undefined);
        await client!
          .query(`DELETE FROM "restaurant_branches" WHERE "id" = $1`, [branchId])
          .catch(() => undefined);
      }
      if (organizationInserted) {
        await client!
          .query(`DELETE FROM "organizations" WHERE "id" = $1`, [organizationId])
          .catch(() => undefined);
      }
      await client!
        .query(`SELECT set_config('app.is_platform_admin', 'false', false)`)
        .catch(() => undefined);
    }
  }, 20_000);
});
