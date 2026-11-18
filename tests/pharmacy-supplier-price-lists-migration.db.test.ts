// @vitest-environment node
/**
 * DEV-681 — run the supplier price-list migration itself against PostgreSQL.
 *
 * The migration is applied twice (it must be idempotent) into an isolated
 * schema that holds only the tables it references, as the NOSUPERUSER /
 * NOBYPASSRLS owner of a disposable database. The storage rules are then
 * exercised with real rows: forced tenant RLS, drafts never above MRP, every
 * decision tied to a person and every approval to a written price.
 *
 * Needs OWNER_DATABASE_URL (the QA gate owner); without it the suite is skipped.
 * The schema is dropped afterwards.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.OWNER_DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261116130200_pharmacy_supplier_price_lists/migration.sql',
  'utf8'
);
const schema = `price_lists_${randomUUID().replaceAll('-', '')}`;
const ORG = 'org_dev681_a';
const OTHER = 'org_dev681_b';

describe.skipIf(!url)('DEV-681 supplier price-list migration on PostgreSQL', () => {
  const client = new Client({ connectionString: url });

  const asOrg = async <T>(organizationId: string, work: () => Promise<T>) => {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
      organizationId,
    ]);
    try {
      const result = await work();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  };

  const line = (overrides: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      organizationId: ORG,
      priceListId: 'list-a',
      rowNumber: Math.floor(Math.random() * 1_000_000) + 2,
      productText: 'Example Tablets 500mg',
      matchStatus: 'MATCHED',
      medicineId: 'med-a',
      packLevelId: 'pack-a',
      listMrpMinor: 110_000,
      currentPackPriceId: 'price-a',
      currentMrpMinor: 100_000,
      draftStatus: 'DRAFT',
      draftMrpMinor: 110_000,
      draftSellingPriceMinor: 95_000,
      ...overrides,
    };
    const keys = Object.keys(row);
    return asOrg(String(row.organizationId), () =>
      client.query(
        `INSERT INTO pharmacy_supplier_price_list_lines (${keys.map((key) => `"${key}"`).join(', ')})
         VALUES (${keys.map((_, index) => `$${index + 1}`).join(', ')})`,
        Object.values(row)
      )
    );
  };

  beforeAll(async () => {
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    // RLS must actually apply to this connection, or the isolation checks prove nothing.
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
      CREATE TABLE pharmacy_suppliers (id text, "organizationId" text, UNIQUE ("organizationId", id));
      CREATE TABLE pharmacy_medicines (id text, "organizationId" text, UNIQUE ("organizationId", id));
      CREATE TABLE pharmacy_pack_levels (id text, "organizationId" text, UNIQUE ("organizationId", id));
      CREATE TABLE pharmacy_pack_prices (id text, "organizationId" text, source text NOT NULL,
        CONSTRAINT "pharmacy_pack_prices_source_check" CHECK (source IN ('drap', 'manual')),
        UNIQUE ("organizationId", id));
      INSERT INTO pharmacy_suppliers VALUES ('sup-a', '${ORG}'), ('sup-b', '${OTHER}');
      INSERT INTO pharmacy_medicines VALUES ('med-a', '${ORG}');
      INSERT INTO pharmacy_pack_levels VALUES ('pack-a', '${ORG}');
      INSERT INTO pharmacy_pack_prices VALUES ('price-a', '${ORG}', 'manual'), ('price-new', '${ORG}', 'manual');`);
    // Twice: a re-run must neither fail nor duplicate anything.
    await client.query(migration);
    await client.query(migration);
    await asOrg(ORG, () =>
      client.query(`INSERT INTO pharmacy_supplier_price_lists
        (id, "supplierId", "fileName", "sourceHash", "rowCount", "importedById")
        VALUES ('list-a', 'sup-a', 'prices.xlsx', repeat('a', 64), 1, 'user-a')`)
    );
  }, 30_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await client.end();
  });

  beforeEach(async () => {
    await asOrg(ORG, () => client.query('DELETE FROM pharmacy_supplier_price_list_lines'));
  });

  it('creates both tables once, with forced RLS and one tenant policy each', async () => {
    const tables = await client.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT COUNT(*)::int FROM pg_policies p
                WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname LIKE 'pharmacy_supplier_price_list%' AND c.relkind = 'r'
        ORDER BY c.relname`,
      [schema]
    );
    expect(tables.rows).toEqual([
      {
        relname: 'pharmacy_supplier_price_list_lines',
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: 1,
      },
      {
        relname: 'pharmacy_supplier_price_lists',
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: 1,
      },
    ]);
  });

  it('stores an open draft for a matched pack', async () => {
    await line();
    const rows = await asOrg(ORG, () =>
      client.query(`SELECT "draftStatus", "draftMrpMinor" FROM pharmacy_supplier_price_list_lines`)
    );
    expect(rows.rows).toEqual([{ draftStatus: 'DRAFT', draftMrpMinor: 110_000 }]);
  });

  it('refuses a draft that sells above its new MRP', async () => {
    await expect(line({ draftSellingPriceMinor: 110_001 })).rejects.toThrow(/draft_check/);
  });

  it('refuses a draft for a row that matched no pack', async () => {
    await expect(
      line({ matchStatus: 'NO_MATCH', medicineId: null, packLevelId: null })
    ).rejects.toThrow(/draft_check/);
  });

  it('refuses a decision that names no person', async () => {
    await expect(line({ draftStatus: 'REJECTED' })).rejects.toThrow(/decision_check/);
  });

  it('refuses an approval that wrote no price, and accepts one that did', async () => {
    const decided = { draftStatus: 'APPROVED', decidedById: 'owner-a', decidedAt: new Date() };
    await expect(line(decided)).rejects.toThrow(/decision_check/);
    await line({ ...decided, packPriceId: 'price-new' });
  });

  it('refuses negative prices', async () => {
    await expect(line({ listTradePriceMinor: -1 })).rejects.toThrow(/prices_check/);
  });

  it('admits "supplier" as a price-policy source and nothing else new', async () => {
    await client.query(
      `INSERT INTO pharmacy_pack_prices VALUES ('price-supplier', '${ORG}', 'supplier')`
    );
    await expect(
      client.query(`INSERT INTO pharmacy_pack_prices VALUES ('price-ai', '${ORG}', 'ai')`)
    ).rejects.toThrow(/source_check/);
  });

  it('keeps each organization to its own price lists', async () => {
    await expect(
      asOrg(OTHER, () =>
        client.query(`INSERT INTO pharmacy_supplier_price_lists
          (id, "organizationId", "supplierId", "fileName", "sourceHash", "rowCount", "importedById")
          VALUES ('list-forged', '${ORG}', 'sup-a', 'x.csv', repeat('b', 64), 1, 'user-b')`)
      )
    ).rejects.toMatchObject({ code: '42501' });
    const seen = await asOrg(OTHER, () =>
      client.query('SELECT id FROM pharmacy_supplier_price_lists')
    );
    expect(seen.rows).toEqual([]);
    const own = await asOrg(ORG, () =>
      client.query('SELECT id FROM pharmacy_supplier_price_lists')
    );
    expect(own.rows).toEqual([{ id: 'list-a' }]);
  });
});
