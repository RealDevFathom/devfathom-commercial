// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '@/generated/prisma/client';
import { advanceInvoiceNumberSequence, reserveInvoiceNumber } from './invoice-number';

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
  const schemaOwner = new pg.Client({ connectionString: ownerUrl });
  // Own the fixture tables with the restricted role so FORCE RLS applies to the
  // migration even when the supplied schema-setup URL belongs to a superuser.
  const owner = new pg.Client({ connectionString: runtimeUrl });
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: runtimeUrl }, { schema }),
  });

  const tenant = <T>(organizationId: string, run: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${quote(schema)}, public`);
      await tx.$queryRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true),
        set_config('app.is_platform_admin', 'false', true)`;
      return run(tx);
    });

  beforeAll(async () => {
    if (ownerUrl === runtimeUrl) throw new Error('Owner and restricted runtime URLs must differ');
    await schemaOwner.connect();
    await schemaOwner.query(`CREATE SCHEMA ${quote(schema)}`);
    await schemaOwner.query(
      `GRANT USAGE, CREATE ON SCHEMA ${quote(schema)} TO ${quote(runtimeRole)}`
    );
    await owner.connect();
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
      ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
      ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON invoices
        USING (current_setting('app.is_platform_admin', true) = 'true'
          OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
        WITH CHECK (current_setting('app.is_platform_admin', true) = 'true'
          OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
    `);
    await owner.query(`SET app.is_platform_admin = 'false'`);
    const role = await owner.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    expect((await owner.query('SELECT id FROM invoices')).rowCount).toBe(0);
    const migration = await readFile(
      path.join(
        process.cwd(),
        'prisma/migrations/20261029000295_atomic_tenant_invoice_numbers/migration.sql'
      ),
      'utf8'
    );
    await owner.query(migration);
    // Migration privilege must be local to its transaction.
    expect(
      (await owner.query(`SELECT current_setting('app.is_platform_admin') AS admin`)).rows
    ).toEqual([{ admin: 'false' }]);
    await owner.query(`SET app.is_platform_admin = 'true'`);
  });

  afterAll(async () => {
    if (!ownerUrl || !runtimeUrl) return;
    await db.$disconnect();
    await owner.end();
    await schemaOwner.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    await schemaOwner.end();
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

  it('reserves first numbers concurrently through the application Prisma allocator', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 12 }, () =>
        tenant('tenant-a', (tx) => reserveInvoiceNumber(tx, 'tenant-a', 2030))
      )
    );
    expect(numbers.toSorted()).toEqual(
      Array.from({ length: 12 }, (_, index) => `INV-2030-${String(index + 1).padStart(3, '0')}`)
    );
    expect(await tenant('tenant-b', (tx) => reserveInvoiceNumber(tx, 'tenant-b', 2030))).toBe(
      'INV-2030-001'
    );
  });

  it('advances seeded numbers without rewinding a live allocator', async () => {
    await tenant('tenant-a', async (tx) => {
      await advanceInvoiceNumberSequence(tx, 'tenant-a', 2031, 17);
      await tx.$executeRaw`INSERT INTO invoices (id, "organizationId", "invoiceNumber")
        VALUES ('demo-seeded', 'tenant-a', 'INV-2031-017')`;
    });
    expect(await tenant('tenant-a', (tx) => reserveInvoiceNumber(tx, 'tenant-a', 2031))).toBe(
      'INV-2031-018'
    );
    await tenant('tenant-a', (tx) => advanceInvoiceNumberSequence(tx, 'tenant-a', 2031, 5));
    expect(await tenant('tenant-a', (tx) => reserveInvoiceNumber(tx, 'tenant-a', 2031))).toBe(
      'INV-2031-019'
    );
  });

  it('rolls back application reservations and seed advances when invoice creation fails', async () => {
    for (const allocate of [
      (tx: Prisma.TransactionClient) => reserveInvoiceNumber(tx, 'tenant-a', 2032),
      (tx: Prisma.TransactionClient) => advanceInvoiceNumberSequence(tx, 'tenant-a', 2032, 99),
    ]) {
      await expect(
        tenant('tenant-a', async (tx) => {
          await allocate(tx);
          await tx.$executeRaw`INSERT INTO invoices (id, "organizationId", "invoiceNumber")
            VALUES ('legacy-a-1', 'tenant-a', 'INV-2032-001')`;
        })
      ).rejects.toThrow();
    }
    expect(await tenant('tenant-a', (tx) => reserveInvoiceNumber(tx, 'tenant-a', 2032))).toBe(
      'INV-2032-001'
    );
  });
});
