import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { getOutstandingInvoiceGroups } from './finance';

const ownerUrl = process.env.OWNER_DATABASE_URL;
const runtimeUrl = process.env.RUNTIME_DATABASE_URL;
const run = ownerUrl && runtimeUrl ? describe : describe.skip;
const suffix = `fin_summary_${process.pid}_${Date.now()}`;
const orgA = `${suffix}_a`;
const orgB = `${suffix}_b`;
const owner = ownerUrl ? new Pool({ connectionString: ownerUrl }) : null;

async function ownerSql(sql: string) {
  const client = await owner!.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.is_platform_admin', 'true', true),
              set_config('app.current_organization_id', '', true)`
    );
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

run('finance outstanding summary database isolation', () => {
  beforeAll(async () => {
    await ownerSql(`
      INSERT INTO organizations (id, slug, "legalName", "displayName", status, "deploymentMode", "updatedAt")
      VALUES ('${orgA}', '${orgA}', 'Finance A', 'Finance A', 'ACTIVE', 'SHARED', now()),
             ('${orgB}', '${orgB}', 'Finance B', 'Finance B', 'ACTIVE', 'SHARED', now());
      INSERT INTO clients (id, "organizationId", name, "updatedAt")
      VALUES ('${orgA}_client', '${orgA}', 'A', now()), ('${orgB}_client', '${orgB}', 'B', now());
      INSERT INTO invoices (id, "organizationId", "invoiceNumber", "clientId", items, subtotal, total, currency, status, "dueDate", "updatedAt")
      VALUES ('${orgA}_invoice', '${orgA}', '${orgA}', '${orgA}_client', '[]', 1000, 1000, 'USD', 'SENT', now(), now()),
             ('${orgB}_invoice', '${orgB}', '${orgB}', '${orgB}_client', '[]', 900, 900, 'USD', 'SENT', now(), now());
      INSERT INTO payments (id, "organizationId", "invoiceId", amount, currency)
      VALUES ('${orgA}_payment', '${orgA}', '${orgA}_invoice', 600, 'USD'),
             ('${orgB}_payment', '${orgB}', '${orgB}_invoice', 100, 'USD');
    `);
  });

  afterAll(async () => {
    if (owner) {
      await ownerSql(`
        DELETE FROM payments WHERE "organizationId" IN ('${orgA}', '${orgB}');
        DELETE FROM invoices WHERE "organizationId" IN ('${orgA}', '${orgB}');
        DELETE FROM clients WHERE "organizationId" IN ('${orgA}', '${orgB}');
        DELETE FROM organizations WHERE id IN ('${orgA}', '${orgB}');
      `);
      await owner.end();
    }
  });

  it('reports 400 outstanding for a 1000 invoice paid by 600 without including another tenant', async () => {
    const groups = await withTenantDb(orgA, (db) => getOutstandingInvoiceGroups(db));
    expect(groups.map((group) => ({ ...group, amount: Number(group.amount) }))).toEqual([
      { currency: 'USD', amount: 400, count: BigInt(1) },
    ]);
  });
});
