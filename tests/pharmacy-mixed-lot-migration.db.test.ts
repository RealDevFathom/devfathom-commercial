// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { expect, it } from 'vitest';

const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;

it.skipIf(!ownerUrl).each([0, 5001])(
  'deploys the exact scripts with committed batches and forced tenant RLS (%i rows per tenant)',
  async (rowsPerTenant) => {
    const client = new pg.Client({ connectionString: ownerUrl });
    const name = `mixed_lot_${randomUUID().replaceAll('-', '')}`;
    await client.connect();
    try {
      await client.query(`CREATE ROLE ${name} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await client.query(`CREATE SCHEMA ${name} AUTHORIZATION ${name}`);
      await client.query(`SET ROLE ${name}`);
      await client.query(`SET search_path TO ${name}`);
      await client.query(`
      CREATE TABLE organizations (id TEXT PRIMARY KEY);
      INSERT INTO organizations VALUES ('a'), ('b');
      CREATE TABLE pharmacy_sale_lines (
        id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL,
        "quantity" INTEGER NOT NULL, "unitPriceMinor" INTEGER NOT NULL,
        "proRataCeilingMinor" INTEGER NOT NULL, "unitCostMinor" INTEGER NOT NULL,
        "discountMinor" INTEGER NOT NULL,
        CONSTRAINT pharmacy_sale_lines_price_check CHECK (
          "unitPriceMinor" >= 0 AND "unitPriceMinor" <= "proRataCeilingMinor"
          AND "discountMinor" >= 0 AND "discountMinor" <= "unitPriceMinor" * quantity
        )
      );
      INSERT INTO pharmacy_sale_lines
        SELECT org.id || n, org.id, 3, 100, 100, 1, 0
        FROM organizations org CROSS JOIN generate_series(1, ${rowsPerTenant}) n;
      CREATE TABLE pharmacy_sale_line_allocations (id TEXT PRIMARY KEY);
      CREATE TABLE pharmacy_sale_return_lines (id TEXT PRIMARY KEY);
      CREATE TABLE pharmacy_unidentified_return_holds (id TEXT PRIMARY KEY);
      ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON organizations USING (
        current_setting('app.is_platform_admin', true) = 'true'
        OR id = current_setting('app.current_organization_id', true)
      );
      ALTER TABLE pharmacy_sale_lines ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pharmacy_sale_lines FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON pharmacy_sale_lines USING (
        "organizationId" = current_setting('app.current_organization_id', true)
      );
    `);
      for (const migration of [
        '20261029000206_pharmacy_mixed_lot_gross',
        '20261029000207_pharmacy_mixed_lot_backfill',
        '20261029000208_pharmacy_mixed_lot_validate',
        '20261029000209_pharmacy_mixed_lot_contract',
      ]) {
        // One raw query per file, matching migration deployment statement boundaries.
        await client.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
      }
      for (const tenant of ['a', 'b']) {
        await client.query("SELECT set_config('app.current_organization_id', $1, false)", [tenant]);
        const result = await client.query(
          'SELECT count(*)::int AS rows, min("grossMinor") AS gross FROM pharmacy_sale_lines'
        );
        expect(result.rows).toEqual([{ rows: rowsPerTenant, gross: rowsPerTenant ? 300 : null }]);
      }
      await client.query(`INSERT INTO pharmacy_sale_lines
      (id, "organizationId", quantity, "unitPriceMinor", "proRataCeilingMinor", "unitCostMinor", "discountMinor", "grossMinor")
      VALUES ('probe', 'b', 3, 100, 100, 1, 0, 250)`);
      // The new app's explicit weighted gross must not be overwritten.
      expect(
        (await client.query('SELECT "grossMinor" FROM pharmacy_sale_lines WHERE id = $1', [
          'probe',
        ])).rows
      ).toEqual([{ grossMinor: 250 }]);
      // The predecessor is still serving during deployment and available for rollback.
      await client.query(`INSERT INTO pharmacy_sale_lines
      (id, "organizationId", quantity, "unitPriceMinor", "proRataCeilingMinor", "unitCostMinor", "discountMinor")
      VALUES ('legacy', 'b', 3, 100, 100, 1, 0)`);
      expect(
        (await client.query('SELECT "grossMinor" FROM pharmacy_sale_lines WHERE id = $1', [
          'legacy',
        ])).rows
      ).toEqual([{ grossMinor: 300 }]);
      // The role owns the table but cannot bypass FORCE RLS or the billed ceiling.
      await expect(
        client.query('UPDATE pharmacy_sale_lines SET "grossMinor" = 1000000 WHERE id = $1', [
          'probe',
        ])
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query('UPDATE pharmacy_sale_lines SET "grossMinor" = NULL WHERE id = $1', ['probe'])
      ).rejects.toMatchObject({ code: '23502' });
      const functions = await client.query(
        'SELECT p.proname, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1',
        [name]
      );
      expect(functions.rows).toEqual([
        { proname: 'pharmacy_default_sale_line_gross_minor', prokind: 'f' },
      ]);
    } finally {
      await client.query('RESET ROLE');
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
      await client.query(`DROP ROLE IF EXISTS ${name}`);
      await client.end();
    }
  },
  30000
);
