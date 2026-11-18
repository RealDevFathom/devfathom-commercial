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
const suffix = randomUUID().replaceAll('-', '');
const schema = `platform_approval_${suffix}`;
/** A runtime role like the application's: no superuser, no row-level security bypass. */
const runtimeRole = `platform_approval_runtime_${suffix}`;
const migration = readFileSync(
  'prisma/migrations/20261118121000_pharmacy_platform_approval/migration.sql',
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
    // The organization row's real isolation policy (20260728092000_row_level_security).
    await client.query(`ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
      CREATE POLICY organization_isolation ON organizations
        USING (current_setting('app.is_platform_admin', true) = 'true' OR id = NULLIF(current_setting('app.current_organization_id', true), ''))
        WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR id = NULLIF(current_setting('app.current_organization_id', true), ''));
      CREATE ROLE ${runtimeRole} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole};
      GRANT SELECT, INSERT, UPDATE ON organizations TO ${runtimeRole};`);
  });
  afterAll(async () => {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await client.end();
  });

  /** A transaction as the runtime role, scoped to one tenant the way `withTenantDb` scopes it. */
  async function asTenantRuntime(organizationId: string, statement: string) {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL ROLE ${runtimeRole}`);
      await client.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
      await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
        organizationId,
      ]);
      const result = await client.query(statement);
      await client.query('COMMIT');
      return result.rowCount;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

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

  it('refuses the runtime role in its own tenant scope, though row-level security admits the row', async () => {
    const approvalColumns = `SELECT "platformApprovedAt", "platformApprovedById", "platformApprovalNote", "platformApprovalUnmetChecks" FROM organizations WHERE id = 'org_a'`;
    const before = (await client.query(approvalColumns)).rows[0];
    // Row-level security admits the tenant's own row: an ordinary column changes.
    await expect(
      asTenantRuntime('org_a', `UPDATE organizations SET timezone = 'UTC' WHERE id = 'org_a'`)
    ).resolves.toBe(1);
    // Another tenant's row is invisible, so nothing changes there.
    await expect(
      asTenantRuntime('org_other', `UPDATE organizations SET timezone = 'UTC' WHERE id = 'org_a'`)
    ).resolves.toBe(0);
    // The approval columns are refused even on the tenant's own row.
    for (const change of [
      `"platformApprovedAt" = now()`,
      `"platformApprovedById" = 'tenant_user'`,
      `"platformApprovalNote" = 'self approved'`,
      `"platformApprovalUnmetChecks" = '[]'::jsonb`,
    ]) {
      await expect(
        asTenantRuntime('org_a', `UPDATE organizations SET ${change} WHERE id = 'org_a'`)
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      asTenantRuntime(
        'org_c',
        `INSERT INTO organizations (id, status, "platformApprovedAt") VALUES ('org_c', 'ACTIVE', now())`
      )
    ).rejects.toMatchObject({ code: '42501' });
    expect((await client.query(approvalColumns)).rows[0]).toEqual(before);
  });
});
