// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve('prisma/migrations/20261021110000_growth_foundation/migration.sql'),
  'utf8'
);
// A disposable database with CREATE SCHEMA permission, using a restricted role.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('growth foundation migration under FORCE RLS', () => {
  it('backfills both tenants before enforcing NOT NULL without granting consent', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const role = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      await client.query('BEGIN');
      const schema = `growth_migration_${randomUUID().replaceAll('-', '')}`;
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`
        SELECT set_config('app.is_platform_admin', 'false', true);
        SELECT set_config('app.current_organization_id', '', true);
        CREATE TABLE organizations (id TEXT PRIMARY KEY);
        CREATE TABLE pharmacy_patients (
          id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, phone TEXT
        );
        CREATE TABLE pharmacy_customers (
          id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL,
          "patientId" TEXT, "whatsappOptIn" BOOLEAN,
          UNIQUE ("organizationId", id)
        );
        CREATE TABLE pharmacy_sales (
          id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL,
          UNIQUE ("organizationId", id)
        );
        CREATE TABLE pharmacy_message_logs (
          id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, direction TEXT
        );
        INSERT INTO organizations VALUES ('a'), ('b');
        INSERT INTO pharmacy_patients VALUES
          ('pa', 'a', '0300-1234567'), ('pb', 'b', '0311 7654321');
        INSERT INTO pharmacy_customers VALUES
          ('ca', 'a', 'pa', NULL), ('cb', 'b', 'pb', NULL),
          ('consented', 'a', NULL, true), ('unlinked', 'b', NULL, false);
      `);
      for (const table of ['pharmacy_customers', 'pharmacy_patients']) {
        await client.query(`
          ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;
          ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;
          CREATE POLICY tenant_isolation ON "${table}"
          USING (
            current_setting('app.is_platform_admin', true) = 'true'
            OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
          );
        `);
      }
      // Confirm the owner cannot see the fixture before the migration elevates.
      expect((await client.query('SELECT * FROM pharmacy_customers')).rows).toEqual([]);
      await client.query(sql);
      const customers = await client.query(`
        SELECT id, "whatsappOptIn", "whatsappE164"
        FROM pharmacy_customers ORDER BY id
      `);
      expect(customers.rows).toEqual([
        { id: 'ca', whatsappOptIn: false, whatsappE164: '+923001234567' },
        { id: 'cb', whatsappOptIn: false, whatsappE164: '+923117654321' },
        { id: 'consented', whatsappOptIn: true, whatsappE164: null },
        { id: 'unlinked', whatsappOptIn: false, whatsappE164: null },
      ]);
      const column = await client.query(
        `
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'pharmacy_customers'
          AND column_name = 'whatsappOptIn'
      `,
        [schema]
      );
      expect(column.rows[0].is_nullable).toBe('NO');
      await client.query('ROLLBACK');
      const context = await client.query(
        "SELECT current_setting('app.is_platform_admin', true) AS admin"
      );
      expect(context.rows[0].admin).not.toBe('true');
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
