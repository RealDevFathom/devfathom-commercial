import { readFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ownerUrl = process.env.OWNER_URL ?? process.env.MIGRATION_DATABASE_URL ?? '';
const runtimeUrl = process.env.TEST_DATABASE_URL ?? '';
const describeDatabase = ownerUrl && runtimeUrl ? describe : describe.skip;
const schema = `invoice_number_${process.pid}_${Date.now()}`;
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const runtimeRole = runtimeUrl ? new URL(runtimeUrl).username : '';

async function runtimeClient(organizationId: string) {
  const client = new pg.Client({ connectionString: runtimeUrl });
  await client.connect();
  await client.query(`SET search_path TO ${quote(schema)}, public`);
  await client.query(`SET app.is_platform_admin = 'false'`);
  await client.query(`SET app.current_organization_id = '${organizationId}'`);
  return client;
}

async function reserve(client: pg.Client, organizationId: string, year: number) {
  const result = await client.query<{ lastNumber: number }>(
    `INSERT INTO invoice_number_sequences ("organizationId", year, "lastNumber")
     VALUES ($1, $2, 1)
     ON CONFLICT ("organizationId", year) DO UPDATE
       SET "lastNumber" = invoice_number_sequences."lastNumber" + 1,
           "updatedAt" = CURRENT_TIMESTAMP
     RETURNING "lastNumber"`,
    [organizationId, year]
  );
  return result.rows[0]!.lastNumber;
}

describeDatabase('atomic tenant invoice numbers on migrated PostgreSQL', () => {
  const owner = new pg.Client({ connectionString: ownerUrl });

  beforeAll(async () => {
    if (ownerUrl === runtimeUrl) throw new Error('Owner and restricted runtime URLs must differ');
    await owner.connect();
    await owner.query(`CREATE SCHEMA ${quote(schema)}`);
    await owner.query(`SET search_path TO ${quote(schema)}, public`);
    await owner.query(`SET app.is_platform_admin = 'true'`);
    await owner.query(`
      CREATE TABLE invoices (
        id TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        "invoiceNumber" TEXT NOT NULL
      );
      CREATE UNIQUE INDEX "invoices_invoiceNumber_key" ON invoices ("invoiceNumber");
      INSERT INTO invoices (id, "organizationId", "invoiceNumber") VALUES
        ('legacy-a-1', 'tenant-a', 'INV-2026-004'),
        ('legacy-a-2', 'tenant-a', 'INV-2026-019'),
        ('legacy-b-1', 'tenant-b', 'INV-2026-007'),
        ('legacy-custom', 'tenant-a', 'CUSTOM-42');
    `);
    const migration = await readFile(
      path.join(
        process.cwd(),
        'prisma/migrations/20261029000295_atomic_tenant_invoice_numbers/migration.sql'
      ),
      'utf8'
    );
    await owner.query(migration);
    await owner.query(`
      GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(runtimeRole)};
      GRANT SELECT, INSERT, UPDATE, DELETE ON invoices, invoice_number_sequences TO ${quote(runtimeRole)};
    `);
  });

  afterAll(async () => {
    if (!ownerUrl || !runtimeUrl) return;
    await owner.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    await owner.end();
  });

  it('backfills each tenant/year maximum without changing legacy invoice rows', async () => {
    const sequences = await owner.query(
      `SELECT "organizationId", year, "lastNumber" FROM invoice_number_sequences
       ORDER BY "organizationId", year`
    );
    expect(sequences.rows).toEqual([
      { organizationId: 'tenant-a', year: 2026, lastNumber: 19 },
      { organizationId: 'tenant-b', year: 2026, lastNumber: 7 },
    ]);
    const invoices = await owner.query(`SELECT count(*)::int AS count FROM invoices`);
    expect(invoices.rows[0]).toEqual({ count: 4 });
  });

  it('reserves unique monotonic values under restricted-role concurrency', async () => {
    const clients = await Promise.all(Array.from({ length: 12 }, () => runtimeClient('tenant-a')));
    try {
      const values = await Promise.all(clients.map((client) => reserve(client, 'tenant-a', 2026)));
      expect(values.toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: 12 }, (_, index) => 20 + index)
      );
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  it('rolls the reservation back with a failed invoice transaction', async () => {
    const client = await runtimeClient('tenant-a');
    try {
      await client.query('BEGIN');
      const reserved = await reserve(client, 'tenant-a', 2027);
      expect(reserved).toBe(1);
      await client.query(
        `INSERT INTO invoices (id, "organizationId", "invoiceNumber") VALUES ('rolled-back', 'tenant-a', 'INV-2027-001')`
      );
      await client.query('ROLLBACK');

      expect(await reserve(client, 'tenant-a', 2027)).toBe(1);
      const invoice = await client.query(`SELECT id FROM invoices WHERE id = 'rolled-back'`);
      expect(invoice.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('hides other tenants and rejects cross-tenant reservations through forced RLS', async () => {
    const client = await runtimeClient('tenant-a');
    try {
      const role = await client.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const visible = await client.query(
        `SELECT DISTINCT "organizationId" FROM invoice_number_sequences`
      );
      expect(visible.rows).toEqual([{ organizationId: 'tenant-a' }]);
      await expect(reserve(client, 'tenant-b', 2028)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
  });
});
