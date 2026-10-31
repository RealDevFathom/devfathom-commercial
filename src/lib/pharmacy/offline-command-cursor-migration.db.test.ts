// @vitest-environment node
import { readFileSync } from 'node:fs';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;
const migration = readFileSync(
  'prisma/migrations/20261025000000_pharmacy_offline_command_cursor/migration.sql',
  'utf8'
);

describeIfDatabase('offline command cursor migration under forced RLS', () => {
  it.each(['', 'tenant-a'])(
    'backfills every tenant and restores the initial tenant scope %j',
    async (tenantScope) => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        const role = await client.query(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
        );
        expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        await client.query('BEGIN');
        // Session-local tables shadow the real tables. Run the exact migration
        // as their owner, with FORCE RLS and the production policies intact.
        await client.query(`
          CREATE TEMP TABLE organizations (id TEXT PRIMARY KEY);
          CREATE TEMP TABLE pharmacy_registered_devices (
            id TEXT, "organizationId" TEXT, PRIMARY KEY ("organizationId", id)
          );
          CREATE TEMP TABLE pharmacy_offline_commands (
            "organizationId" TEXT, "deviceId" TEXT, sequence INTEGER
          );
          INSERT INTO organizations VALUES ('tenant-a'), ('tenant-b');
          INSERT INTO pharmacy_registered_devices VALUES
            ('shared', 'tenant-a'), ('shared', 'tenant-b'),
            ('empty', 'tenant-b'), ('first-gap', 'tenant-b'), ('large-gap', 'tenant-b');
          INSERT INTO pharmacy_offline_commands VALUES
            ('tenant-a', 'shared', 1), ('tenant-a', 'shared', 2),
            ('tenant-b', 'shared', 1), ('tenant-b', 'shared', 3),
            ('tenant-b', 'first-gap', 2), ('tenant-b', 'first-gap', 3),
            ('tenant-b', 'large-gap', 1), ('tenant-b', 'large-gap', 2147483647);
          ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
          ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
          CREATE POLICY organization_isolation ON organizations USING (
            current_setting('app.is_platform_admin', true) = 'true'
            OR id = NULLIF(current_setting('app.current_organization_id', true), '')
          );
          ALTER TABLE pharmacy_registered_devices ENABLE ROW LEVEL SECURITY;
          ALTER TABLE pharmacy_registered_devices FORCE ROW LEVEL SECURITY;
          CREATE POLICY tenant_isolation ON pharmacy_registered_devices USING (
            "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
          );
          ALTER TABLE pharmacy_offline_commands ENABLE ROW LEVEL SECURITY;
          ALTER TABLE pharmacy_offline_commands FORCE ROW LEVEL SECURITY;
          CREATE POLICY tenant_isolation ON pharmacy_offline_commands USING (
            "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
          );
          SELECT set_config('app.is_platform_admin', 'false', true);
        `);
        await client.query("SELECT set_config('app.current_organization_id', $1, true)", [
          tenantScope,
        ]);
        await client.query(migration);
        const settings = await client.query(`SELECT
          current_setting('app.is_platform_admin', true) AS admin,
          current_setting('app.current_organization_id', true) AS tenant`);
        expect(settings.rows).toEqual([{ admin: 'false', tenant: tenantScope }]);
        for (const [tenant, expected] of [
          ['tenant-a', [{ id: 'shared', nextOfflineCommandSequence: 3 }]],
          [
            'tenant-b',
            [
              { id: 'empty', nextOfflineCommandSequence: 1 },
              { id: 'first-gap', nextOfflineCommandSequence: 1 },
              { id: 'large-gap', nextOfflineCommandSequence: 2 },
              { id: 'shared', nextOfflineCommandSequence: 2 },
            ],
          ],
        ] as const) {
          await client.query("SELECT set_config('app.current_organization_id', $1, true)", [
            tenant,
          ]);
          const devices = await client.query(`SELECT id, "nextOfflineCommandSequence"
            FROM pharmacy_registered_devices ORDER BY id`);
          expect(devices.rows).toEqual(expected);
        }
        const policies = await client.query(`SELECT relrowsecurity, relforcerowsecurity
          FROM pg_class WHERE oid IN (
            'pg_temp.organizations'::regclass,
            'pg_temp.pharmacy_registered_devices'::regclass,
            'pg_temp.pharmacy_offline_commands'::regclass
          )`);
        expect(policies.rows).toHaveLength(3);
        expect(policies.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(
          true
        );
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    }
  );
});
