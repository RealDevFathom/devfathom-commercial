// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';

const url = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const migration = (name: string) => readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');
const grossMigration = migration('20261026000000_pharmacy_sale_line_exact_gross');
const allocationMigration = migration('20261026120000_pharmacy_allocation_money');
const original = migration('20260902170000_pharmacy_sales_demand');

describe.skipIf(!url)('allocation money migration on populated, append-only evidence', () => {
  let client: Client;

  beforeEach(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    // Temporary relations isolate the complete migration from the migrated
    // application tables, without changing any operational rows or guards.
    await client.query(`
      CREATE TEMP TABLE pharmacy_sale_lines (
        id text PRIMARY KEY, "organizationId" text, quantity integer,
        "canonicalUnits" integer, "unitPriceMinor" integer,
        "proRataCeilingMinor" integer, "unitCostMinor" integer, "discountMinor" integer
      );
      CREATE TEMP TABLE pharmacy_sale_line_allocations (
        id text PRIMARY KEY, "organizationId" text, "saleLineId" text,
        "inventoryLotId" text, "canonicalUnits" integer
      );
      CREATE TEMP TABLE pharmacy_sale_return_lines (
        id text PRIMARY KEY, "organizationId" text, "saleLineId" text,
        "inventoryLotId" text, "canonicalUnits" integer, "createdAt" timestamp
      );
    `);
    const priceCheck = original.match(
      /ALTER TABLE "pharmacy_sale_lines" ADD CONSTRAINT "pharmacy_sale_lines_price_check"[\s\S]*?;/
    )![0];
    await client.query(priceCheck);
    await client.query(`
      CREATE FUNCTION pg_temp.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
      CREATE TRIGGER pharmacy_sale_allocations_append_only
        BEFORE UPDATE OR DELETE ON pharmacy_sale_line_allocations
        FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_mutation();
      CREATE TRIGGER pharmacy_sale_return_lines_append_only
        BEFORE UPDATE OR DELETE ON pharmacy_sale_return_lines
        FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_mutation();
      INSERT INTO pharmacy_sale_lines VALUES ('line', 'org', 3, 3, 100, 100, 0, 40);
      INSERT INTO pharmacy_sale_line_allocations VALUES
        ('a', 'org', 'line', 'cheap', 2), ('b', 'org', 'line', 'dear', 1);
      INSERT INTO pharmacy_sale_return_lines VALUES
        ('r1', 'org', 'line', 'cheap', 1, '2026-01-01'),
        ('r2', 'org', 'line', 'cheap', 1, '2026-01-02'),
        ('r3', 'org', 'line', 'dear', 1, '2026-01-03');
    `);
  });

  afterEach(async () => {
    await client?.end();
  });

  it('backfills exact totals and restores both append-only triggers', async () => {
    await client.query(grossMigration);
    await client.query(allocationMigration);
    expect(
      (await client.query('SELECT "grossMinor" FROM pg_temp.pharmacy_sale_lines')).rows
    ).toEqual([{ grossMinor: 300 }]);
    expect(
      (
        await client.query(`SELECT "grossMinor", "discountMinor"
      FROM pg_temp.pharmacy_sale_line_allocations ORDER BY id`)
      ).rows
    ).toEqual([
      { grossMinor: 200, discountMinor: 26 },
      { grossMinor: 100, discountMinor: 14 },
    ]);
    expect(
      (
        await client.query(`SELECT "grossMinor", "discountMinor"
      FROM pg_temp.pharmacy_sale_return_lines ORDER BY id`)
      ).rows
    ).toEqual([
      { grossMinor: 100, discountMinor: 13 },
      { grossMinor: 100, discountMinor: 13 },
      { grossMinor: 100, discountMinor: 14 },
    ]);
    await expect(
      client.query('UPDATE pg_temp.pharmacy_sale_line_allocations SET "grossMinor" = 0')
    ).rejects.toThrow('append-only');
    await expect(client.query('DELETE FROM pg_temp.pharmacy_sale_return_lines')).rejects.toThrow(
      'append-only'
    );
  });

  it('validates discounts against exact gross while retaining the price and cost guards', async () => {
    await client.query(grossMigration);
    await client.query(`UPDATE pg_temp.pharmacy_sale_lines
      SET "unitPriceMinor" = 133, "proRataCeilingMinor" = 133,
          "grossMinor" = 400, "discountMinor" = 400`);
    for (const change of [
      '"discountMinor" = 401',
      '"unitCostMinor" = -1',
      '"unitPriceMinor" = 134',
      '"grossMinor" = -1',
      '"grossMinor" = 10000',
    ]) {
      await expect(
        client.query(`UPDATE pg_temp.pharmacy_sale_lines SET ${change}`)
      ).rejects.toThrow('pharmacy_sale_lines_price_check');
    }
  });

  it('rolls back schema changes and trigger suspension if a backfill fails', async () => {
    await client.query(grossMigration);
    await client.query(
      'ALTER TABLE pg_temp.pharmacy_sale_return_lines ADD COLUMN "grossMinor" integer'
    );
    await expect(client.query(allocationMigration)).rejects.toThrow('already exists');
    await client.query('ROLLBACK');
    await expect(
      client.query('UPDATE pg_temp.pharmacy_sale_line_allocations SET "canonicalUnits" = 0')
    ).rejects.toThrow('append-only');
    await expect(client.query('DELETE FROM pg_temp.pharmacy_sale_return_lines')).rejects.toThrow(
      'append-only'
    );
    expect(
      (
        await client.query(`SELECT attname FROM pg_attribute
      WHERE attrelid = 'pg_temp.pharmacy_sale_line_allocations'::regclass
      AND attname = 'grossMinor' AND NOT attisdropped`)
      ).rows
    ).toEqual([]);
  });
});
