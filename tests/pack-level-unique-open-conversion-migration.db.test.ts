// @vitest-environment node
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const sql = readFileSync(
  'prisma/migrations/20261117100000_pack_level_unique_open_conversion/migration.sql',
  'utf8'
);

(databaseUrl ? describe : describe.skip)('open pack uniqueness migration on PostgreSQL', () => {
  // A session-scoped temp table needs no schema-creation privilege (CI connects
  // as a restricted runtime role) and shadows any real table of the same name.
  async function withSchema(run: (c: Client) => Promise<void>) {
    const c = new Client({ connectionString: databaseUrl });
    await c.connect();
    try {
      await c.query(`CREATE TEMP TABLE pharmacy_pack_levels (
        id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "presentationId" TEXT NOT NULL,
        "parentPackLevelId" TEXT, level TEXT NOT NULL, "unitsPerParent" INTEGER NOT NULL,
        "effectiveTo" TIMESTAMP(3))`);
      // Mirror production: forced tenant RLS that only platform-admin scope can see past.
      await c.query(`ALTER TABLE pharmacy_pack_levels ENABLE ROW LEVEL SECURITY;
        ALTER TABLE pharmacy_pack_levels FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON pharmacy_pack_levels
          USING (current_setting('app.is_platform_admin', true) = 'true'
            OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
          WITH CHECK (current_setting('app.is_platform_admin', true) = 'true'
            OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))`);
      await run(c);
    } finally {
      await c.end();
    }
  }
  const admin = `SELECT set_config('app.is_platform_admin', 'true', false)`;
  const row = (id: string, org = 'o1', units = 10, to: string | null = null) =>
    `INSERT INTO pharmacy_pack_levels VALUES ('${id}','${org}','p1',NULL,'STRIP',${units},${to ? `'${to}'` : 'NULL'})`;

  it('rejects duplicate open null-parent packs, allows other tenants, units and retired rows', async () => {
    await withSchema(async (c) => {
      await c.query(admin);
      await c.query(sql);
      await c.query(sql); // rerun-safe
      await c.query(row('a'));
      await expect(c.query(row('b'))).rejects.toThrow(/open_conversion_key/);
      await c.query(row('c', 'o2'));
      await c.query(row('d', 'o1', 20));
      await c.query(row('e', 'o1', 10, '2026-01-01'));
    });
  });

  it('never alters existing duplicates and skips the index instead', async () => {
    await withSchema(async (c) => {
      await c.query(admin);
      await c.query(row('a'));
      await c.query(row('b'));
      await c.query(`RESET app.is_platform_admin`); // migration must set its own scope
      await c.query(sql);
      await c.query(admin);
      const rows = await c.query('SELECT id FROM pharmacy_pack_levels WHERE "effectiveTo" IS NULL');
      expect(rows.rowCount).toBe(2);
      const idx = await c.query(
        `SELECT 1 FROM pg_indexes WHERE tablename = 'pharmacy_pack_levels' AND indexname = 'pharmacy_pack_levels_open_conversion_key' AND schemaname LIKE 'pg_temp%'`
      );
      expect(idx.rowCount).toBe(0);
    });
  });
});
