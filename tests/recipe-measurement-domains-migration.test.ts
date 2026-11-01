// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20261026000000_recipe_measurement_domains/migration.sql'
  ),
  'utf8'
);

async function createTemporaryTables(client: Client) {
  await client.query(`
    CREATE TEMP TABLE "restaurant_unit_conversions" (
      "organizationId" text, "fromUnitId" text, "toUnitId" text, "factor" numeric);
    CREATE TEMP TABLE "restaurant_recipe_versions" (
      "organizationId" text, "id" text, "yieldQuantity" numeric);
    CREATE TEMP TABLE "restaurant_recipe_lines" (
      "organizationId" text, "id" text, "quantity" numeric);
    CREATE TEMP TABLE "restaurant_ingredients" (
      "organizationId" text, "id" text, "referenceCost" numeric);
  `);
}

describe('recipe measurement domain migration', () => {
  it('rejects numeric special values in every constraint', () => {
    expect(
      migration.match(/NOT IN \('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric\)/g)
    ).toHaveLength(4);
  });

  it('has a diagnostic preflight instead of silently changing legacy financial data', () => {
    expect(migration).toContain('invalid legacy rows exist');
    expect(migration).toContain('Repair the listed rows according to an approved business rule');
    expect(migration).toContain('"organizationId"');
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
(databaseUrl ? describe : describe.skip)('recipe measurement migration on PostgreSQL', () => {
  it('fails fast with record context when legacy invalid rows exist', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await createTemporaryTables(client);
      await client.query(
        `INSERT INTO "restaurant_recipe_lines" VALUES ('org-legacy', 'line-bad', 0)`
      );
      await expect(client.query(migration)).rejects.toMatchObject({
        message: expect.stringContaining('invalid legacy rows exist'),
        detail: expect.stringContaining('line-bad'),
      });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it.each([
    [
      'restaurant_unit_conversions',
      '"organizationId", "fromUnitId", "toUnitId", "factor"',
      "'org', 'from', 'to', 'NaN'",
    ],
    [
      'restaurant_recipe_versions',
      '"organizationId", "id", "yieldQuantity"',
      "'org', 'version', 'NaN'",
    ],
    ['restaurant_recipe_lines', '"organizationId", "id", "quantity"', "'org', 'line', 'NaN'"],
    [
      'restaurant_ingredients',
      '"organizationId", "id", "referenceCost"',
      "'org', 'ingredient', 'NaN'",
    ],
  ])('rejects NaN writes to %s after installation', async (table, columns, values) => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await createTemporaryTables(client);
      await client.query(migration);
      await expect(
        client.query(`INSERT INTO "${table}" (${columns}) VALUES (${values})`)
      ).rejects.toMatchObject({
        code: '23514',
      });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('rejects nonpositive measurements, negative costs, and infinities after installation', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await createTemporaryTables(client);
      await client.query(migration);
      for (const [table, column, allowsZero] of [
        ['restaurant_unit_conversions', 'factor', false],
        ['restaurant_recipe_versions', 'yieldQuantity', false],
        ['restaurant_recipe_lines', 'quantity', false],
        ['restaurant_ingredients', 'referenceCost', true],
      ] as const) {
        const invalidValues = ['-1', 'Infinity', '-Infinity', ...(allowsZero ? [] : ['0'])];
        for (const value of invalidValues) {
          await client.query('SAVEPOINT invalid_measurement');
          await expect(
            client.query(`INSERT INTO "${table}" ("${column}") VALUES ($1)`, [value])
          ).rejects.toMatchObject({ code: '23514' });
          await client.query('ROLLBACK TO SAVEPOINT invalid_measurement');
        }
      }
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('accepts positive measurements, zero reference costs, and optional nulls', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await createTemporaryTables(client);
      await client.query(migration);
      await client.query(`
        INSERT INTO "restaurant_unit_conversions" ("factor") VALUES (0.000001);
        INSERT INTO "restaurant_recipe_versions" ("yieldQuantity") VALUES (0.001), (NULL);
        INSERT INTO "restaurant_recipe_lines" ("quantity") VALUES (0.0001);
        INSERT INTO "restaurant_ingredients" ("referenceCost") VALUES (0), (0.0001), (NULL);
      `);
      const result = await client.query('SELECT COUNT(*)::int AS count FROM "restaurant_ingredients"');
      expect(result.rows[0].count).toBe(3);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
