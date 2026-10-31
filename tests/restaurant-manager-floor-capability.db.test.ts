// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261031000000_restaurant_manager_floor_capability/migration.sql',
  'utf8'
);

(databaseUrl ? describe : describe.skip)('Restaurant manager floor permission repair', () => {
  it('repairs installed system managers across tenants under forced RLS, preserves existing permissions and reruns safely', async () => {
    const client = new Client({ connectionString: databaseUrl });
    const schema = `floor_${randomUUID().replaceAll('-', '')}`;
    await client.connect();
    try {
      const role = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      // Isolate the migration from all installed tenant data, with production
      // permission uniqueness and forced RLS on every table it touches.
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TYPE "PermissionEffect" AS ENUM ('ALLOW', 'DENY');
        CREATE TABLE organizations (id text PRIMARY KEY, vertical text NOT NULL);
        CREATE TABLE organization_roles (id text PRIMARY KEY,
          "organizationId" text NOT NULL REFERENCES organizations,
          key text NOT NULL, "isSystem" boolean NOT NULL,
          UNIQUE ("organizationId", key), UNIQUE ("organizationId", id));
        CREATE TABLE organization_role_permissions (id text PRIMARY KEY,
          "organizationId" text NOT NULL REFERENCES organizations,
          "organizationRoleId" text NOT NULL, capability text NOT NULL,
          effect "PermissionEffect" NOT NULL,
          "createdAt" timestamp NOT NULL DEFAULT now(),
          UNIQUE ("organizationRoleId", capability),
          FOREIGN KEY ("organizationId", "organizationRoleId")
            REFERENCES organization_roles ("organizationId", id));
      `);
      for (const table of [
        'organizations',
        'organization_roles',
        'organization_role_permissions',
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
          ('custom', 'RESTAURANT'), ('agency', 'AGENCY'),
          ('pharmacy', 'PHARMACY'), ('hotel', 'HOSPITALITY');
        INSERT INTO organization_roles VALUES
          ('gm-a', 'restaurant-a', 'general-manager', true),
          ('bm-a', 'restaurant-a', 'branch-manager', true),
          ('cashier', 'restaurant-a', 'cashier', true),
          ('gm-b', 'restaurant-b', 'general-manager', true),
          ('bm-b', 'restaurant-b', 'branch-manager', true);
        INSERT INTO organization_roles
        SELECT id || '-gm', id, 'general-manager', id <> 'custom'
          FROM organizations WHERE id IN ('custom', 'agency', 'pharmacy', 'hotel')
        UNION ALL
        SELECT id || '-bm', id, 'branch-manager', id <> 'custom'
          FROM organizations WHERE id IN ('custom', 'agency', 'pharmacy', 'hotel');
        INSERT INTO organization_role_permissions
          (id, "organizationId", "organizationRoleId", capability, effect) VALUES
          ('deny', 'restaurant-b', 'gm-b', 'floor:manage', 'DENY'),
          ('allow', 'restaurant-a', 'bm-a', 'floor:manage', 'ALLOW'),
          ('unrelated', 'restaurant-a', 'cashier', 'orders:read', 'ALLOW');
      `);
      const snapshot = async () =>
        (await client.query('SELECT * FROM organization_role_permissions ORDER BY id')).rows;
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
            roleId: row.organizationRoleId,
            capability: row.capability,
            effect: row.effect,
          }))
          .sort((a, b) => a.roleId.localeCompare(b.roleId))
      ).toEqual([
        {
          organizationId: 'restaurant-b',
          roleId: 'bm-b',
          capability: 'floor:manage',
          effect: 'ALLOW',
        },
        {
          organizationId: 'restaurant-a',
          roleId: 'gm-a',
          capability: 'floor:manage',
          effect: 'ALLOW',
        },
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
