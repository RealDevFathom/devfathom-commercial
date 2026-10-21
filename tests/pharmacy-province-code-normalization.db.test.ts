// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { splitSqlStatements } from './split-sql-statements';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;
const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261021200000_normalize_pharmacy_branch_province_codes/migration.sql'
  ),
  'utf8'
);

describeIfDatabase('pharmacy province-code normalization with forced RLS', () => {
  it('normalizes legacy Punjab and Sindh rows and remains idempotent', async () => {
    const client = new Client({ connectionString: databaseUrl });
    const schema = `province_${randomUUID().replaceAll('-', '')}`;
    await client.connect();

    try {
      const {
        rows: [role],
      } = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE pharmacy_branches (
          id text PRIMARY KEY,
          "provinceCode" text NOT NULL
        );
        ALTER TABLE pharmacy_branches ENABLE ROW LEVEL SECURITY;
        ALTER TABLE pharmacy_branches FORCE ROW LEVEL SECURITY;
        CREATE POLICY platform_access ON pharmacy_branches
          USING (current_setting('app.is_platform_admin', true) = 'true')
          WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
      `);

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      await client.query(`
        INSERT INTO pharmacy_branches (id, "provinceCode") VALUES
          ('punjab', 'PB'),
          ('sindh', 'SD'),
          ('canonical', 'PK-SD');
      `);
      await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
      expect((await client.query('SELECT * FROM pharmacy_branches')).rows).toHaveLength(0);
      await client.query('COMMIT');

      const apply = async () => {
        const updates: number[] = [];
        for (const statement of splitSqlStatements(sql)) {
          const result = await client.query(statement);
          if (result.command === 'UPDATE') updates.push(result.rowCount ?? 0);
        }
        return updates;
      };

      expect(await apply()).toEqual([2]);
      // The migration elevation is transaction-local and is gone after COMMIT.
      expect((await client.query('SELECT * FROM pharmacy_branches')).rows).toHaveLength(0);

      await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
      expect(
        (await client.query('SELECT id, "provinceCode" FROM pharmacy_branches ORDER BY id')).rows
      ).toEqual([
        { id: 'canonical', provinceCode: 'PK-SD' },
        { id: 'punjab', provinceCode: 'PK-PB' },
        { id: 'sindh', provinceCode: 'PK-SD' },
      ]);

      expect(await apply()).toEqual([0]);
    } finally {
      await client.query('ROLLBACK');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
});
