import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * DEV-859: the quantityUnit migration must leave legacy batches with NO recorded choice
 * (nullable, no default, no backfill), keep stored quantities, enforce valid choices,
 * be idempotent, and leave forced RLS and tenant policies untouched.
 * Needs a PostgreSQL superuser URL in SUPERUSER_URL; skipped (never thrown) when absent.
 */
const adminUrl = process.env.SUPERUSER_URL;
const describeIfDatabase = adminUrl ? describe : describe.skip;
const MIGRATION = 'prisma/migrations/20261117090600_migration_quantity_unit/migration.sql';

function databaseUrl(base: string, database: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describeIfDatabase('migration quantityUnit column (legacy-preserving)', () => {
  const database = `quantity_unit_${randomBytes(6).toString('hex')}`;
  const sql = readFileSync(MIGRATION, 'utf8');
  let admin: pg.Client;
  let db: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    db = new pg.Client({ connectionString: databaseUrl(adminUrl!, database) });
    await db.connect();
    await db.query(`
      CREATE TABLE "pharmacy_migration_batches" (
        "id" text PRIMARY KEY,
        "organizationId" text NOT NULL,
        "label" text NOT NULL,
        "rowCount" integer NOT NULL DEFAULT 0
      );
      CREATE TABLE "pharmacy_migration_rows" (
        "id" text PRIMARY KEY,
        "organizationId" text NOT NULL,
        "batchId" text NOT NULL,
        "quantityCanonical" bigint
      );
      ALTER TABLE "pharmacy_migration_batches" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "pharmacy_migration_batches" FORCE ROW LEVEL SECURITY;
      CREATE POLICY batches_tenant ON "pharmacy_migration_batches"
        USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
      INSERT INTO "pharmacy_migration_batches" VALUES ('legacy_1', 'org_a', 'old upload', 1);
      INSERT INTO "pharmacy_migration_rows" VALUES ('legacy_row_1', 'org_a', 'legacy_1', 29);
    `);
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('applies twice, keeping legacy batches unrecorded and quantities unchanged', async () => {
    await db.query(sql);
    await db.query(sql);

    const batch = await db.query(`SELECT "quantityUnit" FROM "pharmacy_migration_batches"`);
    expect(batch.rows).toEqual([{ quantityUnit: null }]);
    const row = await db.query(
      `SELECT "quantityCanonical"::text AS q FROM "pharmacy_migration_rows"`
    );
    expect(row.rows).toEqual([{ q: '29' }]);

    const column = await db.query(
      `SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'pharmacy_migration_batches' AND column_name = 'quantityUnit'`
    );
    expect(column.rows).toEqual([{ is_nullable: 'YES', column_default: null }]);
    const mapped = await db.query(
      `SELECT "quantityColumn" FROM "pharmacy_migration_batches" WHERE "id" = 'legacy_1'`
    );
    expect(mapped.rows).toEqual([{ quantityColumn: null }]);
  });

  it('accepts only PACKS, UNITS or null', async () => {
    await db.query(
      `INSERT INTO "pharmacy_migration_batches" ("id","organizationId","label","quantityUnit")
       VALUES ('b_packs','org_a','p','PACKS'), ('b_units','org_a','u','UNITS')`
    );
    await expect(
      db.query(
        `INSERT INTO "pharmacy_migration_batches" ("id","organizationId","label","quantityUnit")
         VALUES ('b_bad','org_a','x','BOXES')`
      )
    ).rejects.toThrow(/check constraint/);
  });

  it('retains forced RLS and the tenant policy', async () => {
    const flags = await db.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname = 'pharmacy_migration_batches'`
    );
    expect(flags.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await db.query(
      `SELECT policyname FROM pg_policies WHERE tablename = 'pharmacy_migration_batches'`
    );
    expect(policies.rows).toEqual([{ policyname: 'batches_tenant' }]);
  });
});

describe('migration quantityUnit column (static contract)', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  it('is a plain nullable add: no default, backfill or destructive statements', () => {
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    expect(sql).not.toMatch(/\bNOT NULL\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS/i);
  });
});
