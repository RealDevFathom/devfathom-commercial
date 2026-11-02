/**
 * @vitest-environment node
 *
 * #448 / DEV-252 against a REAL migrated PostgreSQL: the figures the shared
 * invoice calculation produces survive Prisma's number → Decimal(12,2) write
 * cent-exact — the persisted line amounts add up to the persisted subtotal and
 * total = subtotal − discount + tax, summed by Postgres itself — and the
 * migration's CHECKs refuse a negative discount or one above the subtotal from
 * any writer.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role (neither SUPERUSER nor BYPASSRLS — asserted first).
 * Without it the suite reports itself skipped rather than passing vacuously.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeInvoiceAmounts } from '@/lib/finance/invoice-amounts';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// `@/lib/db` reads DATABASE_URL on first use; it is imported inside the suite.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

vi.mock('server-only', () => ({}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG = `iss448_${suffix}`;
const CLIENT = `${ORG}_client`;

let client: pg.Client;

describeIfDatabase('invoice discount money, against PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
       VALUES ($1, $1, $1, $1, now())`,
      [ORG]
    );
    await client.query(
      `INSERT INTO clients (id, "organizationId", name, "updatedAt") VALUES ($1, $2, 'Client', now())`,
      [CLIENT, ORG]
    );
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(`DELETE FROM invoices WHERE "organizationId" = $1`, [ORG]);
    await client.query(`DELETE FROM clients WHERE "organizationId" = $1`, [ORG]);
    await client.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await client.end();
  });

  async function persist(input: Parameters<typeof computeInvoiceAmounts>[0]) {
    const result = computeInvoiceAmounts(input);
    if (!result.ok) throw new Error(result.message);
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
    const id = `${ORG}_${randomBytes(4).toString('hex')}`;
    await withTenantDb(ORG, (db) =>
      db.invoice.create({
        data: {
          id,
          invoiceNumber: id,
          clientId: CLIENT,
          dueDate: new Date('2026-11-30T00:00:00.000Z'),
          ...result.amounts,
        },
      })
    );
    const { rows } = await client.query<{
      subtotal: string;
      discount: string;
      tax: string;
      total: string;
      lines: string;
      identity: boolean;
    }>(
      `SELECT subtotal::text, discount::text, tax::text, total::text,
              (SELECT sum((line->>'amount')::numeric) FROM jsonb_array_elements(items) AS line)::text AS lines,
              total = subtotal - discount + tax AS identity
         FROM invoices WHERE id = $1`,
      [id]
    );
    return { id, row: rows[0] };
  }

  it('persists awkward lines, discount and tax cent-exact (3 × 0.335, 1/3 rates)', async () => {
    const { row } = await persist({
      items: [
        { description: 'Pack', quantity: 3, rate: 0.335 },
        { description: 'Third', quantity: 1, rate: 1 / 3 },
        { description: 'Third', quantity: 2, rate: 1 / 3 },
        { description: 'Retainer', quantity: 7, rate: 19.995 },
      ],
      discount: 1 / 3,
      tax: 12.345,
    });

    // 1.01 + 0.33 + 0.67 + 139.97 (7 × 19.995 = 139.965 → 139.97)
    expect(row).toEqual({
      subtotal: '141.98',
      discount: '0.33',
      tax: '12.35',
      total: '154.00',
      lines: '141.98',
      identity: true,
    });
  });

  it('persists the largest discount the subtotal allows', async () => {
    const { row } = await persist({
      items: [{ description: 'Work', quantity: 1, rate: 100 }],
      discount: 100,
      tax: 5,
    });

    expect(row).toMatchObject({ subtotal: '100.00', discount: '100.00', total: '5.00' });
  });

  it.each([
    ['a negative discount', '-0.01', 'invoices_discount_nonnegative_ck'],
    ['a discount above the subtotal', '100.01', 'invoices_discount_within_subtotal_ck'],
  ])('refuses %s from any writer', async (_label, discount, constraint) => {
    const { id } = await persist({ items: [{ description: 'Work', quantity: 1, rate: 100 }] });

    await expect(
      client.query(`UPDATE invoices SET discount = $2::numeric WHERE id = $1`, [id, discount])
    ).rejects.toMatchObject({ code: '23514', constraint });
  });
});
