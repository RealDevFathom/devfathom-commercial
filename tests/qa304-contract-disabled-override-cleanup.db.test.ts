// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerDatabaseUrl = process.env.OWNER_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
const describeIfDatabase = databaseUrl && ownerDatabaseUrl ? describe : describe.skip;
const sql = readFileSync(
  'prisma/migrations/20261021190000_qa304_contract_disabled_override_cleanup/migration.sql',
  'utf8'
);

describeIfDatabase('QA-304 contract entitlement override cleanup', () => {
  it('removes only contract-sync package denials and is safe to rerun', async () => {
    expect(ownerDatabaseUrl).not.toBe(databaseUrl);
    const client = new Client({ connectionString: ownerDatabaseUrl });
    const app = new Client({ connectionString: databaseUrl });
    await client.connect();
    await app.connect();
    const schema = `qa304_${randomUUID().replaceAll('-', '')}`;

    try {
      const appRole = (await app.query<{ current_user: string }>('SELECT current_user')).rows[0]
        .current_user.replaceAll('"', '""');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE organizations (id text PRIMARY KEY, "packageId" text);
        CREATE TABLE platform_package_modules
          ("packageId" text, "moduleId" text, enabled boolean NOT NULL);
        CREATE TABLE platform_contracts
          (id text PRIMARY KEY, "organizationId" text NOT NULL, number text NOT NULL);
        CREATE TABLE organization_modules (
          id text PRIMARY KEY, "organizationId" text NOT NULL, "moduleId" text NOT NULL,
          status text NOT NULL, "seatLimit" integer, "expiresAt" timestamp,
          overrides jsonb, reason text
        );
        INSERT INTO organizations VALUES ('org', 'package'), ('other-org', 'other-package');
        INSERT INTO platform_package_modules VALUES
          ('package', 'included', true), ('package', 'package-disabled', false);
        INSERT INTO platform_contracts VALUES ('contract', 'org', 'CON-304');
        INSERT INTO organization_modules VALUES
          ('stale', 'org', 'included', 'DISABLED', NULL, NULL, NULL, 'Contract CON-304'),
          ('admin-reason', 'org', 'included', 'DISABLED', NULL, NULL, NULL, 'Disabled by admin'),
          ('admin-fields', 'org', 'included', 'DISABLED', 3, NULL, NULL, 'Contract CON-304'),
          ('wrong-contract', 'org', 'included', 'DISABLED', NULL, NULL, NULL, 'Contract OTHER'),
          ('not-baseline', 'org', 'package-disabled', 'DISABLED', NULL, NULL, NULL, 'Contract CON-304'),
          ('enabled', 'org', 'included', 'ENABLED', NULL, NULL, NULL, 'Contract CON-304');
      `);
      await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${appRole}"`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${appRole}"`);
      await app.query(`SET search_path TO "${schema}"`);

      await client.query(sql);
      const afterFirstRun = (
        await app.query('SELECT id FROM organization_modules ORDER BY id')
      ).rows.map(({ id }) => id);
      expect(afterFirstRun).toEqual([
        'admin-fields',
        'admin-reason',
        'enabled',
        'not-baseline',
        'wrong-contract',
      ]);

      await client.query(sql);
      expect(
        (await app.query('SELECT id FROM organization_modules ORDER BY id')).rows.map(
          ({ id }) => id
        )
      ).toEqual(afterFirstRun);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await app.end();
      await client.end();
    }
  });

  it('does nothing when the catalog tables do not exist', async () => {
    const client = new Client({ connectionString: ownerDatabaseUrl });
    const app = new Client({ connectionString: databaseUrl });
    await client.connect();
    await app.connect();
    const schema = `qa304_guard_${randomUUID().replaceAll('-', '')}`;
    try {
      const appRole = (await app.query<{ current_user: string }>('SELECT current_user')).rows[0]
        .current_user.replaceAll('"', '""');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${appRole}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await expect(client.query(sql)).resolves.toBeDefined();
      await app.query(`SET search_path TO "${schema}"`);
      expect(
        (await app.query("SELECT to_regclass('organization_modules') AS table_name")).rows[0]
      ).toEqual({ table_name: null });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await app.end();
      await client.end();
    }
  });
});
