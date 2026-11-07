// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261031000100_restaurant_job_role_floor_capability/migration.sql',
  'utf8'
);

(databaseUrl ? describe : describe.skip)('Restaurant job-role floor capability repair', () => {
  it('adds floor:manage to installed system manager/owner job roles across tenants under forced RLS and reruns safely', async () => {
    const client = new Client({ connectionString: databaseUrl });
    const schema = `jrfloor_${randomUUID().replaceAll('-', '')}`;
    await client.connect();
    try {
      const role = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE organizations (id text PRIMARY KEY, vertical text NOT NULL);
        CREATE TABLE restaurant_job_roles (id text PRIMARY KEY,
          "organizationId" text NOT NULL REFERENCES organizations,
          key text NOT NULL, "isSystem" boolean NOT NULL,
          UNIQUE ("organizationId", key), UNIQUE ("organizationId", id));
        CREATE TABLE restaurant_job_role_capabilities (id text PRIMARY KEY,
          "organizationId" text NOT NULL REFERENCES organizations,
          "jobRoleId" text NOT NULL, capability text NOT NULL,
          "createdAt" timestamp NOT NULL DEFAULT now(),
          UNIQUE ("jobRoleId", capability),
          FOREIGN KEY ("organizationId", "jobRoleId")
            REFERENCES restaurant_job_roles ("organizationId", id));
      `);
      for (const table of [
        'organizations',
        'restaurant_job_roles',
        'restaurant_job_role_capabilities',
      ]) {
        await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
        await client.query(`CREATE POLICY platform_access ON ${table}
          USING (current_setting('app.is_platform_admin', true) = 'true')
          WITH CHECK (current_setting('app.is_platform_admin', true) = 'true')`);
      }
      await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
      await client.query(`
        INSERT INTO organizations VALUES
          ('restaurant-a', 'RESTAURANT'), ('restaurant-b', 'RESTAURANT'),
          ('agency', 'AGENCY'), ('pharmacy', 'PHARMACY');
        INSERT INTO restaurant_job_roles VALUES
          ('mgr-a', 'restaurant-a', 'manager', true),
          ('own-a', 'restaurant-a', 'owner', true),
          ('cashier-a', 'restaurant-a', 'cashier', true),
          ('mgr-b', 'restaurant-b', 'manager', true),
          ('own-b', 'restaurant-b', 'owner', false),
          ('mgr-agency', 'agency', 'manager', true),
          ('mgr-pharmacy', 'pharmacy', 'manager', true);
        INSERT INTO restaurant_job_role_capabilities
          (id, "organizationId", "jobRoleId", capability) VALUES
          ('existing', 'restaurant-a', 'own-a', 'floor:manage'),
          ('unrelated', 'restaurant-a', 'cashier-a', 'orders:read');
      `);
      const snapshot = async () =>
        (await client.query('SELECT * FROM restaurant_job_role_capabilities ORDER BY id')).rows;
      const before = await snapshot();
      await client.query("SELECT set_config('app.is_platform_admin', 'false', false)");
      expect(await snapshot()).toEqual([]);

      await client.query(migration);
      // The migration's platform access must end with its transaction.
      expect(await snapshot()).toEqual([]);
      await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
      const after = await snapshot();
      expect(after).toHaveLength(before.length + 2);
      expect(after).toEqual(expect.arrayContaining(before));
      expect(
        after
          .filter((row) => !before.some((old) => old.id === row.id))
          .map((row) => ({
            organizationId: row.organizationId,
            jobRoleId: row.jobRoleId,
            capability: row.capability,
          }))
          .sort((a, b) => a.jobRoleId.localeCompare(b.jobRoleId))
      ).toEqual([
        { organizationId: 'restaurant-a', jobRoleId: 'mgr-a', capability: 'floor:manage' },
        { organizationId: 'restaurant-b', jobRoleId: 'mgr-b', capability: 'floor:manage' },
      ]);

      await client.query("SELECT set_config('app.is_platform_admin', 'false', false)");
      await client.query(migration);
      expect(await snapshot()).toEqual([]);
      await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
      expect(await snapshot()).toEqual(after);
    } finally {
      await client.query('ROLLBACK');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
});
