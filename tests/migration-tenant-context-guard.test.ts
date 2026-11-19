import { describe, expect, it } from 'vitest';

import {
  analyzeMigrations,
  MigrationTenantContextAnalyzer,
  migrationNames,
} from './helpers/migration-tenant-context';

// DEV-951. A table that forces row-level security with no `app.is_platform_admin` clause in
// any policy shows a NOSUPERUSER NOBYPASSRLS migration owner (how deploy and the QA gate
// migrate) no rows unless `app.current_organization_id` is set. A migration that reads or
// writes such a table outside a function body before setting it silently does nothing, as
// the voucher-count and receipt-print backfills did. Loop over organizations and set the
// tenant for each, as 20261029000206_pharmacy_mixed_lot_gross and the DEV-951 corrections do.
//
// Applied migrations are never edited, so these existing offenders are pinned. The list may
// only shrink: nothing stamped after PINNED_UP_TO may be added to it.
const PINNED_UP_TO = '20261118124100';
const PINNED_OFFENDERS = [
  // Preflight reads that always passed; the table they read was created empty in the same
  // deploy (both arrived on develop in #388), and its FKs already enforce the orphan checks.
  '20260829180000_restaurant_tax_refund_allocations:restaurant_tax_rate_bucket_snapshots',
  '20260829180000_restaurant_tax_refund_allocations:restaurant_tax_tender_allocation_snapshots',
  '20260829180000_restaurant_tax_refund_allocations:restaurant_tax_transaction_snapshots',
  // Normalized PENDING rows of a table created empty in the same deploy (#388): nothing to fix.
  '20260831180000_restaurant_delivery_money_contract:restaurant_delivery_fulfillments',
  // Corrected by 20261118124500_pharmacy_receipt_print_state_correction.
  '20261110111300_pharmacy_receipt_print_cutover:pharmacy_sales',
  // Corrected by 20261118124400_pharmacy_voucher_use_count_correction.
  '20261116121200_pharmacy_voucher_controls:pharmacy_sale_lines',
];

const analyzer = analyzeMigrations();
const offenders = analyzer.offenders.map((o) => `${o.migration}:${o.table}`).sort();

describe('migrations set the tenant before touching tenant-only tables (DEV-951)', () => {
  it('derives the tenant-only tables from the policies in the migrations', () => {
    const tables = analyzer.tenantOnlyTables();
    // Forced, tenant-only policies.
    for (const table of [
      'pharmacy_sales',
      'pharmacy_sale_lines',
      'restaurant_delivery_fulfillments',
    ])
      expect(tables).toContain(table);
    // Forced, but every policy admits the platform.
    for (const table of ['organizations', 'pharmacy_vouchers', 'pharmacy_receipt_print_states'])
      expect(tables).not.toContain(table);
    // The reviewed schema had 93; more may be added, never silently fewer.
    expect(tables.length).toBeGreaterThanOrEqual(93);
  });

  it('finds no migration outside the pinned list that reads or writes one before setting the tenant', () => {
    expect(offenders).toEqual([...PINNED_OFFENDERS].sort());
  });

  it('only shrinks the pinned list', () => {
    const latest = migrationNames().at(-1)!;
    expect(latest.slice(0, 14) >= PINNED_UP_TO).toBe(true);
    for (const entry of PINNED_OFFENDERS) expect(entry.slice(0, 14) <= PINNED_UP_TO).toBe(true);
  });
});

describe('tenant-context detector', () => {
  const setup = `
    CREATE TABLE "tenant_rows" ("id" TEXT, "organizationId" TEXT);
    ALTER TABLE "tenant_rows" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "tenant_rows" FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "tenant_rows"
      USING ("organizationId" = current_setting('app.current_organization_id', true));
    CREATE TABLE "shared_rows" ("id" TEXT, "organizationId" TEXT);
    ALTER TABLE "shared_rows" FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "shared_rows"
      USING (current_setting('app.is_platform_admin', true) = 'true'
        OR "organizationId" = current_setting('app.current_organization_id', true));
    CREATE TABLE "looped_a" ("id" TEXT);
    CREATE TABLE "looped_b" ("id" TEXT);
    DO $$ DECLARE t text; BEGIN
      FOREACH t IN ARRAY ARRAY['looped_a', 'looped_b'] LOOP
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("organizationId" = current_setting(''app.current_organization_id'', true))', t);
      END LOOP;
    END $$;
  `;
  const known = new Set(['tenant_rows', 'shared_rows', 'looped_a', 'looped_b']);

  function offendersOf(sql: string): string[] {
    const probe = new MigrationTenantContextAnalyzer();
    probe.analyze('0001_setup', setup, known);
    probe.analyze('0002_probe', sql, known);
    return probe.offenders.map((o) => `${o.migration}:${o.table}`);
  }

  it('flags a backfill that sets only the platform flag', () => {
    expect(
      offendersOf(`BEGIN;
        SELECT set_config('app.is_platform_admin', 'true', true);
        UPDATE "shared_rows" s SET "id" = t."id" FROM (SELECT "id" FROM "tenant_rows") t;
        COMMIT;`)
    ).toEqual(['0002_probe:tenant_rows']);
  });

  it('flags tables made tenant-only by a dynamic loop, and reads inside a DO block', () => {
    expect(
      offendersOf(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "looped_b") THEN RAISE EXCEPTION 'tenant_rows has rows'; END IF;
      END $$; INSERT INTO "looped_a" SELECT 'x';`)
    ).toEqual(['0002_probe:looped_b', '0002_probe:looped_a']);
  });

  it('accepts a per-organization loop that sets the tenant first', () => {
    expect(
      offendersOf(`BEGIN;
        SELECT set_config('app.is_platform_admin', 'true', true);
        DO $$ DECLARE tenant_id TEXT; BEGIN
          FOR tenant_id IN SELECT "id" FROM "organizations" LOOP
            PERFORM set_config('app.current_organization_id', tenant_id, true);
            UPDATE "tenant_rows" SET "id" = "id";
          END LOOP;
          PERFORM set_config('app.current_organization_id', '', true);
        END $$;
        COMMIT;`)
    ).toEqual([]);
  });

  it('does not accept a tenant set after the read, or reset to empty', () => {
    expect(
      offendersOf(`DELETE FROM "tenant_rows";
        SELECT set_config('app.current_organization_id', 'org', true);`)
    ).toEqual(['0002_probe:tenant_rows']);
    expect(
      offendersOf(`SELECT set_config('app.current_organization_id', '', true);
        SELECT count(*) FROM "tenant_rows";`)
    ).toEqual(['0002_probe:tenant_rows']);
  });

  it('does not carry a tenant past a later reset or the end of its transaction', () => {
    expect(
      offendersOf(`SELECT set_config('app.current_organization_id', 'org', true);
        SELECT set_config('app.current_organization_id', '', true);
        UPDATE "tenant_rows" SET "id" = "id";`)
    ).toEqual(['0002_probe:tenant_rows']);
    expect(
      offendersOf(`BEGIN;
        SELECT set_config('app.current_organization_id', 'org', true);
        COMMIT;
        BEGIN;
        UPDATE "tenant_rows" SET "id" = "id";
        COMMIT;`)
    ).toEqual(['0002_probe:tenant_rows']);
    expect(
      offendersOf(`SET app.current_organization_id = 'org';
        RESET app.current_organization_id;
        DELETE FROM "tenant_rows";`)
    ).toEqual(['0002_probe:tenant_rows']);
    // A session-level setting outlives the transaction.
    expect(
      offendersOf(`SELECT set_config('app.current_organization_id', 'org', false);
        COMMIT;
        DELETE FROM "tenant_rows";`)
    ).toEqual([]);
  });

  it('ignores function bodies, DDL and tables whose policy admits the platform', () => {
    expect(
      offendersOf(`
        CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO "tenant_rows" VALUES (NEW."id", NEW."organizationId"); RETURN NEW; END $$;
        CREATE INDEX "tenant_rows_idx" ON "tenant_rows" ("id");
        ALTER TABLE "tenant_rows" ADD CONSTRAINT "tenant_rows_id" CHECK ("id" <> '');
        UPDATE "shared_rows" SET "id" = "id";
        -- UPDATE "tenant_rows" SET "id" = "id";
      `)
    ).toEqual([]);
  });

  it('stops flagging a table once a policy admits the platform', () => {
    expect(
      offendersOf(`
        DROP POLICY IF EXISTS tenant_isolation ON "tenant_rows";
        CREATE POLICY tenant_isolation ON "tenant_rows"
          USING (current_setting('app.is_platform_admin', true) = 'true');
        UPDATE "tenant_rows" SET "id" = "id";
      `)
    ).toEqual([]);
  });
});
