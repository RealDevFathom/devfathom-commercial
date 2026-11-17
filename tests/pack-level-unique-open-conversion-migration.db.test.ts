// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const sql = readFileSync(
  'prisma/migrations/20261117100000_pack_level_unique_open_conversion/migration.sql',
  'utf8'
);

(databaseUrl ? describe : describe.skip)('open pack uniqueness migration on PostgreSQL', () => {
  async function withSchema(run: (c: Client) => Promise<void>) {
    const c = new Client({ connectionString: databaseUrl });
    await c.connect();
    const schema = `packu_${randomUUID().replaceAll('-', '')}`;
    try {
      await c.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
      await c.query(`CREATE TABLE pharmacy_pack_levels (
        id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "presentationId" TEXT NOT NULL,
        "parentPackLevelId" TEXT, level TEXT NOT NULL, "unitsPerParent" INTEGER NOT NULL,
        "effectiveTo" TIMESTAMP(3))`);
      await run(c);
    } finally {
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    }
  }
  const row = (id: string, org = 'o1', units = 10, to: string | null = null) =>
    `INSERT INTO pharmacy_pack_levels VALUES ('${id}','${org}','p1',NULL,'STRIP',${units},${to ? `'${to}'` : 'NULL'})`;

  it('rejects duplicate open null-parent packs, allows other tenants, units and retired rows', async () => {
    await withSchema(async (c) => {
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
      await c.query(row('a'));
      await c.query(row('b'));
      await c.query(sql);
      const rows = await c.query('SELECT id FROM pharmacy_pack_levels WHERE "effectiveTo" IS NULL');
      expect(rows.rowCount).toBe(2);
      const idx = await c.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'pharmacy_pack_levels_open_conversion_key'`
      );
      expect(idx.rowCount).toBe(0);
    });
  });
});
