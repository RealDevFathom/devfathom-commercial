// Disposable PostgreSQL only: this suite creates its own schema and non-bypass role.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.FBR_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '');
const schema = `fbr_test_${suffix}`;
const role = `fbr_test_${suffix}`;
const client = new Client({ connectionString: url });
suite('FBR migration PostgreSQL tenant boundary', () => {
  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
      CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE TABLE pharmacy_sales (id TEXT, "organizationId" TEXT, "branchId" TEXT,
        UNIQUE ("organizationId", "branchId", id));
      INSERT INTO pharmacy_sales VALUES ('sale-a','org-a','branch-a'),('sale-b','org-b','branch-b');`);
    await client.query(
      readFileSync('prisma/migrations/20261021141548_fbr_pos_outbox/migration.sql', 'utf8')
    );
    // Make the app role the owner: FORCE RLS must protect even the table owner.
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};
      ALTER TABLE fiscal_invoice_outbox OWNER TO ${role}; SET ROLE ${role};`);
  });
  afterAll(async () => {
    if (!url) return;
    await client.query(`RESET ROLE; DROP SCHEMA ${schema} CASCADE; DROP ROLE ${role};`);
    await client.end();
  });
  async function tenant(org: string) {
    await client.query("SELECT set_config('app.current_organization_id', $1, false)", [org]);
  }
  const insert = `INSERT INTO fiscal_invoice_outbox
    (id,"organizationId","branchId","saleId",usin,payload) VALUES ($1,$2,$3,$4,$5,'{}')`;
  it('isolates reads and rejects cross-tenant writes even as table owner', async () => {
    await tenant('org-a');
    await client.query(insert, ['a', 'org-a', 'branch-a', 'sale-a', 'usin-a']);
    await tenant('org-b');
    expect((await client.query('SELECT id FROM fiscal_invoice_outbox')).rows).toEqual([]);
    await expect(
      client.query(insert, ['foreign', 'org-a', 'branch-a', 'sale-a', 'foreign'])
    ).rejects.toMatchObject({ code: '42501' });
    await client.query(insert, ['b', 'org-b', 'branch-b', 'sale-b', 'usin-b']);
    expect((await client.query('SELECT id FROM fiscal_invoice_outbox')).rows).toEqual([
      { id: 'b' },
    ]);
    await tenant('');
    expect((await client.query('SELECT id FROM fiscal_invoice_outbox')).rows).toEqual([]);
  });
  it('rejects foreign sale/branch associations and duplicate submissions', async () => {
    await tenant('org-a');
    await expect(
      client.query(insert, ['wrong-branch', 'org-a', 'branch-b', 'sale-b', 'wrong'])
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      client.query(insert, ['duplicate', 'org-a', 'branch-a', 'sale-a', 'other'])
    ).rejects.toMatchObject({ code: '23505' });
    const state = await client.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid='fiscal_invoice_outbox'::regclass`);
    expect(state.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });
});
