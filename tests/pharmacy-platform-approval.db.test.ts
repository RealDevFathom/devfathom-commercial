// @vitest-environment node
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * DEV-905: a tenant transaction cannot approve its own pharmacy or withdraw an approval.
 * Row-level security lets a tenant update its own organization row, so the trigger is
 * what stops it; the platform control plane ("app.is_platform_admin" = 'true') may.
 */
const url = process.env.CONTROLLED_TEST_DATABASE_URL ?? process.env.OWNER_DATABASE_URL;
const schema = `platform_approval_${randomUUID().replaceAll('-', '')}`;
const migration = readFileSync(
  'prisma/migrations/20261118120000_pharmacy_platform_approval/migration.sql',
  'utf8'
);

(url ? describe : describe.skip)('pharmacy platform approval guard', () => {
  const client = new Client({ connectionString: url });

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
      CREATE TABLE organizations (id text PRIMARY KEY, status text NOT NULL, timezone text);`);
    await client.query(migration);
    // Idempotent: a second run changes nothing and does not fail.
    await client.query(migration);
    await client.query(`INSERT INTO organizations (id, status) VALUES ('org_a', 'ONBOARDING')`);
  });
  afterAll(async () => {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });

  async function as(platform: boolean, statement: string) {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.is_platform_admin', $1, true)`, [
        platform ? 'true' : 'false',
      ]);
      await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  it('refuses a tenant transaction that approves its own pharmacy', async () => {
    await expect(
      as(false, `UPDATE organizations SET "platformApprovedAt" = now() WHERE id = 'org_a'`)
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      as(
        false,
        `INSERT INTO organizations (id, status, "platformApprovedAt") VALUES ('org_b', 'ACTIVE', now())`
      )
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('lets the platform approve, and refuses a tenant that withdraws or rewrites it', async () => {
    await as(
      true,
      `UPDATE organizations SET "platformApprovedAt" = now(), "platformApprovedById" = 'op_1' WHERE id = 'org_a'`
    );
    for (const change of [
      `"platformApprovedAt" = NULL`,
      `"platformApprovedById" = 'tenant_user'`,
      `"platformApprovalNote" = 'self approved'`,
      `"platformApprovalUnmetChecks" = '[]'::jsonb`,
    ]) {
      await expect(
        as(false, `UPDATE organizations SET ${change} WHERE id = 'org_a'`)
      ).rejects.toMatchObject({ code: '42501' });
    }
    // Other columns stay writable as before.
    await expect(
      as(false, `UPDATE organizations SET timezone = 'Asia/Karachi' WHERE id = 'org_a'`)
    ).resolves.toBeUndefined();
    await as(true, `UPDATE organizations SET "platformApprovedAt" = NULL WHERE id = 'org_a'`);
    const row = await client.query(
      `SELECT "platformApprovedAt" FROM organizations WHERE id = 'org_a'`
    );
    expect(row.rows[0].platformApprovedAt).toBeNull();
  });
});
