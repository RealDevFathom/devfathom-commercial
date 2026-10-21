import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runtimeUrl = process.env.WHA1316_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.WHA1316_OWNER_DATABASE_URL;
const describeIfDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
const tables = [
  'pharmacy_supplier_relationships',
  'pharmacy_supplier_action_links',
  'pharmacy_supplier_submissions',
  'pharmacy_supplier_documents',
  'pharmacy_supplier_submission_approvals',
] as const;
let runtime: Client;

describeIfDatabase('supplier action links PostgreSQL RLS', () => {
  beforeAll(async () => {
    runtime = new Client({ connectionString: runtimeUrl });
    await runtime.connect();
  });

  afterAll(async () => runtime?.end());

  it('runs as a restricted role, never SUPERUSER or BYPASSRLS', async () => {
    expect(ownerUrl).not.toBe(runtimeUrl);
    const result = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
    );
    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('enables and forces RLS with a tenant/branch policy on every new table', async () => {
    const result = await runtime.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[]) ORDER BY relname`,
      [tables]
    );
    expect(result.rows).toHaveLength(tables.length);
    for (const row of result.rows)
      expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await runtime.query<{ tablename: string; qual: string }>(
      `SELECT tablename,qual FROM pg_policies WHERE tablename=ANY($1::text[])`,
      [tables]
    );
    expect(policies.rows).toHaveLength(tables.length);
    for (const policy of policies.rows) {
      expect(policy.qual).toContain('app.current_organization_id');
      expect(policy.qual).toContain('app.current_branch_id');
    }
  });

  it('rejects explicit cross-tenant relationship insertion before any parent lookup', async () => {
    await runtime.query('BEGIN');
    try {
      await runtime.query(`SET LOCAL app.current_organization_id='tenant_a'`);
      await runtime.query(`SET LOCAL app.current_branch_id='branch_a'`);
      await expect(
        runtime.query(
          `INSERT INTO pharmacy_supplier_relationships (id,"organizationId","branchId","supplierId") VALUES ('cross','tenant_b','branch_b','supplier_b')`
        )
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await runtime.query('ROLLBACK');
    }
  });
});
