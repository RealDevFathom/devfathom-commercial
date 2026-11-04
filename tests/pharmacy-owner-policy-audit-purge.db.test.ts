// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const original = readFileSync(
  'prisma/migrations/20261023010518_pharmacy_owner_policy/migration.sql',
  'utf8'
);
const correction = readFileSync(
  'prisma/migrations/20261023020200_owner_policy_audit_purge/migration.sql',
  'utf8'
);

(databaseUrl ? describe : describe.skip)('owner-policy audit purge exception', () => {
  it.each([
    { admin: false, purge: '', operation: 'DELETE', allowed: false },
    { admin: false, purge: 'org-a', operation: 'DELETE', allowed: false },
    { admin: true, purge: '', operation: 'DELETE', allowed: false },
    { admin: true, purge: 'org-b', operation: 'DELETE', allowed: false },
    { admin: true, purge: 'org-a', operation: 'UPDATE', allowed: false },
    { admin: true, purge: 'org-a', operation: 'DELETE', allowed: true },
    { admin: true, purge: 'org-a', operation: 'CASCADE', allowed: true },
  ])(
    '$operation with admin=$admin and purge=$purge',
    async ({ admin, purge, operation, allowed }) => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      const schema = `owner_policy_${randomUUID().replaceAll('-', '')}`;
      try {
        await client.query('BEGIN');
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET LOCAL search_path TO "${schema}"`);
        await client.query(`
        CREATE TABLE organizations (id text PRIMARY KEY);
        CREATE FUNCTION pharmacy_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'append-only' USING ERRCODE = '55000'; END $$;
        INSERT INTO organizations VALUES ('org-a'), ('org-b');
      `);
        await client.query(original);
        // Start with the deployed guard and existing audit history, then apply the fix.
        await client.query(`SELECT set_config('app.current_organization_id', 'org-a', true)`);
        await client.query(
          `INSERT INTO pharmacy_owner_policies ("organizationId") VALUES ('org-a')`
        );
        await client.query(correction);
        await client.query(
          `SELECT set_config('app.is_platform_admin', $1, true),
        set_config('app.purging_organization_id', $2, true)`,
          [String(admin), purge]
        );

        const statement =
          operation === 'CASCADE'
            ? `DELETE FROM organizations WHERE id = 'org-a'`
            : operation === 'UPDATE'
              ? `UPDATE pharmacy_owner_policy_audit SET "newValue" = true WHERE "organizationId" = 'org-a'`
              : `DELETE FROM pharmacy_owner_policy_audit WHERE "organizationId" = 'org-a'`;
        await client.query('SAVEPOINT mutation');
        if (allowed) {
          await expect(client.query(statement)).resolves.toMatchObject({ rowCount: 1 });
        } else {
          await expect(client.query(statement)).rejects.toMatchObject({ code: '55000' });
          await client.query('ROLLBACK TO SAVEPOINT mutation');
        }
        const rows = await client.query('SELECT * FROM pharmacy_owner_policy_audit');
        expect(rows.rowCount).toBe(allowed ? 0 : 1);
      } finally {
        // The isolated schema and every fixture write are transactional.
        await client.query('ROLLBACK');
        await client.end();
      }
    }
  );
});
