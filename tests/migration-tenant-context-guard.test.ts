import { describe, expect, it } from 'vitest';

import {
  analyzeMigrations,
  DYNAMIC_SQL,
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
    // A session-level setting outlives the transaction. (The value is an expression: a literal
    // id is one fixed organisation, which DEV-954 does not accept as setting the tenant.)
    expect(
      offendersOf(`SELECT set_config('app.current_organization_id', current_setting('app.seed_organization_id'), false);
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

  // DEV-954: forms of reading or writing, and of setting the tenant, the first guard missed.
  describe('DEV-954 widening', () => {
    const flagged = ['0002_probe:tenant_rows'];
    const dynamic = [`0002_probe:${DYNAMIC_SQL}`];

    it('flags a tenant-only table later in a comma-separated FROM or USING list', () => {
      expect(
        offendersOf(`SELECT count(*) FROM "shared_rows" o, "tenant_rows" l WHERE l."id" = o."id";`)
      ).toEqual(flagged);
      expect(
        offendersOf(`UPDATE "shared_rows" s SET "id" = b."id"
          FROM "shared_rows" a, ONLY "tenant_rows" b WHERE a."id" = s."id";`)
      ).toEqual(flagged);
      expect(
        offendersOf(`DELETE FROM "shared_rows" s USING "shared_rows" a, public."tenant_rows" b
          WHERE s."id" = b."id";`)
      ).toEqual(flagged);
      expect(
        offendersOf(`SELECT 1 FROM "shared_rows" a JOIN "shared_rows" b ON a."id" = b."id",
          LATERAL (SELECT 1) x, "tenant_rows" c;`)
      ).toEqual(flagged);
      expect(
        offendersOf(`DO $$ DECLARE n int; BEGIN
          SELECT count(*) INTO n FROM "shared_rows" a, "tenant_rows" b;
        END $$;`)
      ).toEqual(flagged);
    });

    it('does not read a value list as a FROM list', () => {
      expect(
        offendersOf(`SELECT EXTRACT(EPOCH FROM "createdAt"), tenant_rows FROM "shared_rows";
          SELECT "id" IS DISTINCT FROM "organizationId", tenant_rows FROM "shared_rows";
          SELECT "id" FROM "shared_rows" WHERE "id" IN ('a', 'b') ORDER BY "id", tenant_rows;`)
      ).toEqual([]);
    });

    it('flags TABLE queries: CREATE TABLE ... AS TABLE, INSERT ... TABLE, set operations', () => {
      expect(offendersOf(`CREATE TABLE "tenant_copy" AS TABLE "tenant_rows";`)).toEqual(flagged);
      expect(offendersOf(`CREATE TEMP TABLE tenant_copy AS (TABLE tenant_rows);`)).toEqual(flagged);
      expect(
        offendersOf(`INSERT INTO "shared_rows" ("id", "organizationId") TABLE "tenant_rows";`)
      ).toEqual(flagged);
      expect(offendersOf(`TABLE "tenant_rows";`)).toEqual(flagged);
      expect(
        offendersOf(
          `SELECT "id", "organizationId" FROM "shared_rows" UNION ALL TABLE "tenant_rows";`
        )
      ).toEqual(flagged);
      expect(offendersOf(`CREATE TABLE "shared_copy" AS TABLE "shared_rows";`)).toEqual([]);
    });

    it('flags a statement that opens with a parenthesis', () => {
      expect(
        offendersOf(`(SELECT "id" FROM "tenant_rows") UNION (SELECT "id" FROM "shared_rows");`)
      ).toEqual(flagged);
      expect(offendersOf(`((SELECT "id" FROM "shared_rows"));`)).toEqual([]);
    });

    it('does not accept the tenant set to a constant', () => {
      for (const set of [
        `SELECT set_config('app.current_organization_id', 'org_1', true);`,
        `SELECT set_config('app.current_organization_id', 'org_1'::text, false);`,
        `SET LOCAL app.current_organization_id = 'org_1';`,
        `SET app.current_organization_id TO org_1;`,
      ])
        expect(offendersOf(`BEGIN; ${set} UPDATE "tenant_rows" SET "id" = "id"; COMMIT;`)).toEqual(
          flagged
        );
      // A literal also replaces a tenant set earlier: the backfill then reaches one shop only.
      expect(
        offendersOf(`DO $$ DECLARE tenant_id TEXT; BEGIN
          FOR tenant_id IN SELECT "id" FROM "organizations" LOOP
            PERFORM set_config('app.current_organization_id', tenant_id, true);
            PERFORM set_config('app.current_organization_id', 'org_1', true);
            UPDATE "tenant_rows" SET "id" = "id";
          END LOOP;
        END $$;`)
      ).toEqual(flagged);
    });

    it('does not carry a tenant set inside a branch past the end of that branch', () => {
      // A branch that never runs.
      expect(
        offendersOf(`DO $$ DECLARE tenant_id TEXT; BEGIN
          FOR tenant_id IN SELECT "id" FROM "organizations" LOOP
            IF false THEN
              PERFORM set_config('app.current_organization_id', tenant_id, true);
            END IF;
            UPDATE "tenant_rows" SET "id" = "id";
          END LOOP;
        END $$;`)
      ).toEqual(flagged);
      // The other branch of the same IF.
      expect(
        offendersOf(`DO $$ DECLARE tenant_id TEXT; BEGIN
          FOR tenant_id IN SELECT "id" FROM "organizations" LOOP
            IF tenant_id = 'org_1' THEN
              PERFORM set_config('app.current_organization_id', tenant_id, true);
            ELSIF tenant_id = 'org_2' THEN
              NULL;
            ELSE
              DELETE FROM "tenant_rows";
            END IF;
          END LOOP;
        END $$;`)
      ).toEqual(flagged);
      // A CASE statement branch (a CASE expression inside it does not end the branch).
      expect(
        offendersOf(`DO $$ DECLARE tenant_id TEXT; n int; BEGIN
          FOR tenant_id IN SELECT "id" FROM "organizations" LOOP
            CASE tenant_id
              WHEN 'org_1' THEN
                n := CASE WHEN true THEN 1 ELSE 2 END;
                PERFORM set_config('app.current_organization_id', tenant_id, true);
              ELSE
                NULL;
            END CASE;
            UPDATE "tenant_rows" SET "id" = "id";
          END LOOP;
        END $$;`)
      ).toEqual(flagged);
    });

    it('accepts a tenant set inside a branch for the rest of that branch', () => {
      expect(
        offendersOf(`DO $$ DECLARE tenant_id TEXT; n int; BEGIN
          FOR tenant_id IN SELECT "id" FROM "organizations" LOOP
            IF EXISTS (SELECT 1 FROM "shared_rows" WHERE "organizationId" = tenant_id) THEN
              PERFORM set_config('app.current_organization_id', tenant_id, true);
              n := CASE WHEN true THEN 1 ELSE 2 END;
              IF n = 1 THEN
                UPDATE "tenant_rows" SET "id" = "id";
              END IF;
              DROP POLICY IF EXISTS nothing ON "shared_rows";
              DELETE FROM "tenant_rows" WHERE "id" = '';
            END IF;
          END LOOP;
          PERFORM set_config('app.current_organization_id', '', true);
        END $$;`)
      ).toEqual([]);
    });

    it('reads a static EXECUTE like any other statement', () => {
      expect(
        offendersOf(`DO $$ BEGIN EXECUTE 'UPDATE "tenant_rows" SET "id" = ''x'''; END $$;`)
      ).toEqual(flagged);
      expect(
        offendersOf(`DO $$ BEGIN EXECUTE $sql$DELETE FROM "tenant_rows"$sql$; END $$;`)
      ).toEqual(flagged);
      expect(
        offendersOf(
          `DO $$ BEGIN EXECUTE format('DELETE FROM "tenant_rows" WHERE "id" = %L', 'x'); END $$;`
        )
      ).toEqual(flagged);
      expect(
        offendersOf(`DO $$ BEGIN EXECUTE 'UPDATE "shared_rows" SET "id" = "id"'; END $$;`)
      ).toEqual([]);
    });

    it('requires a per-organisation loop or an allow comment for EXECUTE that could name any table', () => {
      for (const execute of [
        `EXECUTE format('UPDATE %I SET "id" = "id"', t);`,
        `EXECUTE format($q$DELETE FROM %s$q$, t);`,
        `EXECUTE 'DELETE FROM ' || quote_ident(t);`,
        `EXECUTE statement_text;`,
      ])
        expect(
          offendersOf(`DO $$ DECLARE t text := 'shared_rows'; statement_text text; BEGIN
            ${execute}
          END $$;`)
        ).toEqual(dynamic);
      // The per-organisation loop sets the tenant before the EXECUTE.
      expect(
        offendersOf(`DO $$ DECLARE tenant_id TEXT; t text := 'tenant_rows'; BEGIN
          FOR tenant_id IN SELECT "id" FROM "organizations" LOOP
            PERFORM set_config('app.current_organization_id', tenant_id, true);
            EXECUTE format('UPDATE %I SET "id" = "id"', t);
          END LOOP;
        END $$;`)
      ).toEqual([]);
      // An inline allow comment with a reason, on the line or right above it.
      const allowed = (comment: string, same = false) =>
        offendersOf(`DO $$ DECLARE t text := 'shared_rows'; BEGIN
          ${same ? '' : comment}
          EXECUTE format('UPDATE %I SET "id" = "id"', t); ${same ? comment : ''}
        END $$;`);
      expect(allowed('-- tenant-context: allow every table here admits the platform')).toEqual([]);
      expect(allowed('-- tenant-context: allow shared_rows admits the platform', true)).toEqual([]);
      expect(allowed('-- tenant-context: allow')).toEqual(dynamic);
      expect(allowed('-- tenant-context: allow ok')).toEqual(dynamic);
      // A tenant set in a branch that has ended, or to a constant, is not a loop.
      expect(
        offendersOf(`DO $$ DECLARE t text := 'tenant_rows'; BEGIN
          PERFORM set_config('app.current_organization_id', 'org_1', true);
          EXECUTE format('UPDATE %I SET "id" = "id"', t);
        END $$;`)
      ).toEqual(dynamic);
    });

    it('lets DDL and trigger EXECUTE through', () => {
      expect(
        offendersOf(`DO $$ DECLARE t text; BEGIN
          FOREACH t IN ARRAY ARRAY['tenant_rows'] LOOP
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
            EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("id")', t || '_idx', t);
            EXECUTE 'GRANT SELECT ON ' || quote_ident(t) || ' TO PUBLIC';
            EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION f()', t, t);
          END LOOP;
          CREATE TRIGGER g BEFORE UPDATE ON "tenant_rows" FOR EACH ROW EXECUTE FUNCTION f();
        END $$;`)
      ).toEqual([]);
      // CREATE TABLE ... AS a query is not DDL: it reads rows.
      expect(
        offendersOf(`DO $$ DECLARE t text := 'tenant_rows'; BEGIN
          EXECUTE format('CREATE TABLE %I AS TABLE %I', t || '_copy', t);
        END $$;`)
      ).toEqual(dynamic);
    });
  });
});
