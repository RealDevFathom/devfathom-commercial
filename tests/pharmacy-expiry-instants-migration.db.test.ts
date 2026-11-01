// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { splitSqlStatements } from './split-sql-statements';

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerDatabaseUrl = process.env.OWNER_DATABASE_URL;
const sql = readFileSync(
  'prisma/migrations/20261029000205_fix_pharmacy_expiry_instants/migration.sql',
  'utf8'
);

(databaseUrl ? describe : describe.skip)('pharmacy expiry backfill with forced RLS', () => {
  it('repairs batch and receipt instants across tenants atomically without shifting corrected rows', async () => {
    const client = new Client({ connectionString: databaseUrl });
    const owner = ownerDatabaseUrl ? new Client({ connectionString: ownerDatabaseUrl }) : client;
    const schema = `expiry_${randomUUID().replaceAll('-', '')}`;
    await client.connect();
    if (owner !== client) await owner.connect();
    try {
      const {
        rows: [role],
      } = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      await owner.query(`CREATE SCHEMA "${schema}"`);
      if (owner !== client) {
        const {
          rows: [runtime],
        } = await client.query('SELECT current_user AS name');
        await owner.query(
          `GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${runtime.name.replaceAll('"', '""')}"`
        );
      }
      await client.query(`SET search_path TO "${schema}"`);
      // Isolated tables expose the production timestamp types and forced RLS
      // policies. The restricted migrator owns them, so FORCE is essential.
      await client.query(`
        CREATE TABLE pharmacy_manufacturing_batches (
          id text PRIMARY KEY, "organizationId" text NOT NULL, "expiresAt" timestamp(3) NOT NULL);
        CREATE TABLE pharmacy_inventory_lots (
          id text PRIMARY KEY, "organizationId" text NOT NULL, "branchId" text NOT NULL,
          "manufacturingBatchId" text REFERENCES pharmacy_manufacturing_batches,
          "receivedExpiresAt" timestamp(3) NOT NULL);
        ALTER TABLE pharmacy_manufacturing_batches ENABLE ROW LEVEL SECURITY;
        ALTER TABLE pharmacy_manufacturing_batches FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON pharmacy_manufacturing_batches
          USING (current_setting('app.is_platform_admin', true) = 'true'
            OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
        ALTER TABLE pharmacy_inventory_lots ENABLE ROW LEVEL SECURITY;
        ALTER TABLE pharmacy_inventory_lots FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_branch_isolation ON pharmacy_inventory_lots
          USING (current_setting('app.is_platform_admin', true) = 'true'
            OR ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
              AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
                OR "branchId" = current_setting('app.current_branch_id', true))));
      `);
      await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
      await client.query(`
        INSERT INTO pharmacy_manufacturing_batches VALUES
          ('day', 'org_a', '2027-06-16 00:00:00'),
          ('month', 'org_b', '2027-07-01 00:00:00'),
          ('leap', 'org_b', '2028-03-01 00:00:00'),
          ('year', 'org_a', '2028-01-01 00:00:00'),
          ('repaired', 'org_b', '2027-06-30 19:00:00');
        INSERT INTO pharmacy_inventory_lots VALUES
          ('day', 'org_a', 'branch_a', 'day', '2027-06-16 00:00:00'),
          ('month', 'org_b', 'branch_b', 'month', '2027-07-01 00:00:00'),
          ('leap', 'org_b', 'branch_b', 'leap', '2028-03-01 00:00:00'),
          ('year', 'org_a', 'branch_a', 'year', '2028-01-01 00:00:00'),
          ('repaired', 'org_b', 'branch_b', 'repaired', '2027-07-01 00:00:00'),
          ('new', 'org_b', 'branch_b', 'repaired', '2027-06-30 19:00:00');
      `);
      await client.query(`SELECT set_config('app.is_platform_admin', 'false', false),
        set_config('app.current_organization_id', '', false),
        set_config('app.current_branch_id', '', false)`);

      const deploy = async () => {
        // No outer transaction: verify the migration establishes its own
        // transaction-local scope under migrate deploy statement semantics.
        for (const statement of splitSqlStatements(sql)) await client.query(statement);
        for (const table of ['pharmacy_manufacturing_batches', 'pharmacy_inventory_lots']) {
          expect((await client.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
        }
      };
      const snapshot = async () => {
        await client.query('BEGIN');
        try {
          await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
          return (
            await client.query(`
            SELECT lot.id, batch."expiresAt" AT TIME ZONE 'UTC' AS batch,
              lot."receivedExpiresAt" AT TIME ZONE 'UTC' AS receipt
            FROM pharmacy_inventory_lots lot
            JOIN pharmacy_manufacturing_batches batch ON batch.id = lot."manufacturingBatchId"
            ORDER BY lot.id
          `)
          ).rows;
        } finally {
          await client.query('ROLLBACK');
        }
      };

      await deploy();
      const expected = [
        ['day', '2027-06-15T19:00:00.000Z'],
        ['leap', '2028-02-29T19:00:00.000Z'],
        ['month', '2027-06-30T19:00:00.000Z'],
        ['new', '2027-06-30T19:00:00.000Z'],
        ['repaired', '2027-06-30T19:00:00.000Z'],
        ['year', '2027-12-31T19:00:00.000Z'],
      ].map(([id, instant]) => ({ id, batch: new Date(instant), receipt: new Date(instant) }));
      expect(await snapshot()).toEqual(expected);
      await deploy();
      expect(await snapshot()).toEqual(expected);
    } finally {
      await client.query('ROLLBACK');
      await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
      if (owner !== client) await owner.end();
    }
  });
});
