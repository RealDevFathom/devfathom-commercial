/** PostgreSQL concurrency coverage for the agency invoice-number allocator. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const orgA = `invoice_seq_a_${suffix}`;
const orgB = `invoice_seq_b_${suffix}`;
const clientA = `invoice_client_a_${suffix}`;
const clientB = `invoice_client_b_${suffix}`;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  allocateInvoiceNumber: (typeof import('./invoice-numbers'))['allocateInvoiceNumber'];
};
let deps: Deps;

async function createInvoice(organizationId: string, clientId: string, year: number, id: string) {
  return deps.withTenantDb(organizationId, async (tx) => {
    const number = await deps.allocateInvoiceNumber(tx, organizationId, year);
    await tx.$executeRaw`
      INSERT INTO "invoices" (
        "id", "organizationId", "invoiceNumber", "clientId", "items",
        "subtotal", "total", "dueDate", "updatedAt"
      ) VALUES (
        ${id}, ${organizationId}, ${number}, ${clientId}, '[]'::jsonb,
        0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `;
    return number;
  });
}

describeIfDatabase('atomic agency invoice numbers', () => {
  beforeAll(async () => {
    const scoped = await import('@/lib/tenancy/scoped-db');
    deps = { ...scoped, ...(await import('./invoice-numbers')) };
    await deps.withPlatformDb(async (db) => {
      for (const [organizationId, clientId] of [[orgA, clientA], [orgB, clientB]]) {
        await db.organization.create({
          data: {
            id: organizationId,
            slug: organizationId,
            legalName: organizationId,
            displayName: organizationId,
            status: 'ACTIVE',
          },
        });
        await db.client.create({
          data: { id: clientId, organizationId, name: clientId },
        });
      }
    });
  });

  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb(async (db) => {
      await db.$executeRaw`DELETE FROM "invoices" WHERE "organizationId" IN (${orgA}, ${orgB})`;
      await db.$executeRaw`DELETE FROM "invoice_number_sequences" WHERE "organizationId" IN (${orgA}, ${orgB})`;
      await db.client.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } });
      await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    });
  });

  it('gives concurrent creates distinct numbers', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createInvoice(orgA, clientA, 2037, `invoice_concurrent_${suffix}_${index}`)
      )
    );
    expect(new Set(numbers).size).toBe(8);
    expect(numbers.slice().sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `INV-2037-${String(index + 1).padStart(3, '0')}`)
    );
  });

  it('isolates the yearly sequence per organization', async () => {
    await expect(createInvoice(orgB, clientB, 2037, `invoice_org_b_${suffix}`)).resolves.toBe(
      'INV-2037-001'
    );
  });

  it('continues after the value seeded by the migration backfill', async () => {
    const migration = await readFile(
      new URL(
        '../../../prisma/migrations/20261022130100_atomic_invoice_number_sequences/migration.sql',
        import.meta.url
      ),
      'utf8'
    );
    expect(migration).toContain('MAX(substring("invoiceNumber"');

    await deps.withTenantDb(orgA, (tx) => tx.$executeRaw`
      INSERT INTO "invoice_number_sequences" ("organizationId", "year", "lastNumber")
      VALUES (${orgA}, 2038, 41)
    `);
    await expect(
      createInvoice(orgA, clientA, 2038, `invoice_backfill_${suffix}`)
    ).resolves.toBe('INV-2038-042');
  });
});
