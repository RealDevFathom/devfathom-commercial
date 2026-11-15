// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20261116110000_restaurant_purchasing_finite_decimals/migration.sql'
  ),
  'utf8'
);
const SPECIALS = `('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`;
const CONSTRAINTS = [
  ['restaurant_stock_movements', 'restaurant_stock_movements_finite_ck'],
  ['restaurant_purchase_order_lines', 'restaurant_purchase_order_lines_finite_ck'],
  ['restaurant_purchase_receipt_lines', 'restaurant_purchase_receipt_lines_finite_ck'],
  ['restaurant_receiving_discrepancies', 'restaurant_receiving_discrepancies_finite_ck'],
] as const;

/** The migration body without its own BEGIN/COMMIT, run inside a test transaction. */
const body = migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');

async function createTemporaryTables(client: Client) {
  await client.query(`
    CREATE TEMP TABLE "restaurant_stock_movements" (
      "organizationId" text, "id" text, "quantity" DECIMAL(18,6) NOT NULL, "unitCost" DECIMAL(18,6));
    CREATE TEMP TABLE "restaurant_purchase_order_lines" (
      "organizationId" text, "id" text, "orderedQuantity" DECIMAL(18,6) NOT NULL,
      "unitCost" DECIMAL(18,6) NOT NULL);
    CREATE TEMP TABLE "restaurant_purchase_receipt_lines" (
      "organizationId" text, "id" text, "receivedQuantity" DECIMAL(18,6) NOT NULL,
      "unitCost" DECIMAL(18,6) NOT NULL);
    CREATE TEMP TABLE "restaurant_receiving_discrepancies" (
      "organizationId" text, "id" text, "expectedQuantity" DECIMAL(18,6) NOT NULL,
      "receivedQuantity" DECIMAL(18,6) NOT NULL);
  `);
}

describe('restaurant purchasing finite-decimal migration (DEV-774)', () => {
  it('is a single transaction', () => {
    expect(migration.split('\n').find((line) => line.trim() && !line.startsWith('--'))).toBe(
      'BEGIN;'
    );
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('installs an idempotent finite CHECK on every purchasing/stock decimal table', () => {
    for (const [table, constraint] of CONSTRAINTS) {
      expect(migration).toContain(
        `ALTER TABLE "${table}"\n  DROP CONSTRAINT IF EXISTS "${constraint}";`
      );
      expect(migration).toContain(`ALTER TABLE "${table}"\n  ADD CONSTRAINT "${constraint}"`);
    }
  });

  it('rejects numeric special values in every constrained column', () => {
    for (const column of [
      '"quantity"',
      '"unitCost" IS NULL OR "unitCost"',
      '"orderedQuantity"',
      '"receivedQuantity"',
      '"expectedQuantity"',
    ]) {
      expect(migration).toContain(`${column} NOT IN ${SPECIALS}`);
    }
    // One CHECK expression per decimal column (8) — never a bare `>= 0`, which NaN passes.
    expect(migration.split(`NOT IN ${SPECIALS}`)).toHaveLength(9);
  });

  it('has a diagnostic preflight instead of silently changing legacy stock data', () => {
    expect(migration).toContain('invalid legacy rows exist');
    expect(migration).toContain('Repair the listed rows according to an approved business rule');
    expect(migration).toContain('"organizationId"');
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
(databaseUrl ? describe : describe.skip)(
  'restaurant purchasing finite-decimal migration on PostgreSQL',
  () => {
    it('fails fast with record context when legacy NaN rows exist', async () => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        await createTemporaryTables(client);
        await client.query(
          `INSERT INTO "restaurant_stock_movements" VALUES ('org-legacy', 'movement-nan', 'NaN', NULL)`
        );
        await expect(client.query(body)).rejects.toMatchObject({
          message: expect.stringContaining('invalid legacy rows exist'),
          detail: expect.stringContaining('movement-nan'),
        });
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    });

    it('re-applies cleanly and rejects NaN writes while finite values round-trip', async () => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        await createTemporaryTables(client);
        await client.query(body);
        await client.query(body);
        await client.query(
          `INSERT INTO "restaurant_stock_movements" VALUES ('org', 'ok', '-2.500000', '10.123456')`
        );
        const { rows } = await client.query(
          `SELECT "quantity"::text AS quantity, "unitCost"::text AS cost
             FROM "restaurant_stock_movements" WHERE "id" = 'ok'`
        );
        expect(rows).toEqual([{ quantity: '-2.500000', cost: '10.123456' }]);
        await client.query('SAVEPOINT nan_write');
        await expect(
          client.query(
            `INSERT INTO "restaurant_purchase_receipt_lines" VALUES ('org', 'bad', 'NaN', 1)`
          )
        ).rejects.toMatchObject({
          constraint: 'restaurant_purchase_receipt_lines_finite_ck',
        });
        await client.query('ROLLBACK TO SAVEPOINT nan_write');
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    });
  }
);
