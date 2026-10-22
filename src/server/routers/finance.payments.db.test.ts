/**
 * @vitest-environment node
 *
 * #398 — invoice status and recorded payments must agree, against a REAL migrated
 * PostgreSQL under forced row-level security, through the real finance router.
 *
 * "Mark paid" used to set PAID without a payment, so the derived balance still
 * showed the whole total owed beside a "Paid" status. The mark-paid workflow now
 * records the outstanding balance as a payment in the same transaction; status-only
 * changes can't strand payments on a DRAFT/CANCELLED invoice; deleting a payment
 * reopens a PAID invoice (OVERDUE when past due); edits can't push the total below
 * what was paid; and every payment writer serialises on the invoice row lock.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role (neither SUPERUSER nor BYPASSRLS — asserted first).
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// `@/lib/db` reads DATABASE_URL on first use; everything that reaches it is
// imported inside the suite, after this line.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), sendEmail: vi.fn(), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG = `fin398_${suffix}`;
const ADMIN = `fin398_admin_${suffix}`;
const CLIENT = `fin398_client_${suffix}`;
let sequence = 0;
const newId = (kind: string) => `fin398_${kind}_${suffix}_${++sequence}`;

type Finance = {
  getInvoiceById: (input: { id: string }) => Promise<{
    status: string;
    amountPaid: number;
    balance: number;
    paidAt: Date | null;
  } | null>;
  markInvoicePaid: (input: { id: string; method?: string; paidAt?: Date }) => Promise<{
    status: string;
    amountPaid: number;
    balance: number;
    payment: { amount: unknown; method: string | null } | null;
  }>;
  addPayment: (input: {
    invoiceId: string;
    amount: number;
  }) => Promise<{ status: string; amountPaid: number; balance: number }>;
  deletePayment: (input: { id: string }) => Promise<{ status: string | null; balance: number }>;
  updateInvoiceStatus: (input: { id: string; status: string }) => Promise<{ status: string }>;
  updateInvoice: (input: {
    id: string;
    items: Array<{ description: string; quantity: number; rate: number }>;
    status?: 'DRAFT' | 'SENT';
  }) => Promise<{ status: string; balance: number }>;
};

let client: pg.Client;
let finance: () => Finance;

async function insertInvoice(opts: {
  status: string;
  total: number;
  dueInDays?: number;
  paidAt?: Date | null;
}) {
  const id = newId('inv');
  const due = new Date(Date.now() + (opts.dueInDays ?? 30) * 86_400_000);
  await client.query(
    `INSERT INTO invoices (id, "organizationId", "invoiceNumber", "clientId", items, subtotal, tax,
       total, currency, status, "dueDate", "paidAt", "sentAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 0, $6, 'USD', $7::"InvoiceStatus", $8, $9, now(), now())`,
    [
      id,
      ORG,
      `INV-${id}`,
      CLIENT,
      JSON.stringify([{ description: 'Work', quantity: 1, rate: opts.total, amount: opts.total }]),
      opts.total,
      opts.status,
      due,
      opts.paidAt ?? null,
    ]
  );
  return id;
}

async function insertPayment(invoiceId: string, amount: number) {
  const id = newId('pay');
  await client.query(
    `INSERT INTO payments (id, "organizationId", "invoiceId", amount, currency)
     VALUES ($1, $2, $3, $4, 'USD')`,
    [id, ORG, invoiceId, amount]
  );
  return id;
}

async function payments(invoiceId: string) {
  const { rows } = await client.query<{ id: string; amount: string; method: string | null }>(
    `SELECT id, amount, method FROM payments WHERE "invoiceId" = $1 ORDER BY "createdAt", id`,
    [invoiceId]
  );
  return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

async function invoiceRow(invoiceId: string) {
  const { rows } = await client.query<{ status: string; paidAt: Date | null }>(
    `SELECT status, "paidAt" FROM invoices WHERE id = $1`,
    [invoiceId]
  );
  return rows[0];
}

describeIfDatabase('invoice payments and status, against PostgreSQL (#398)', () => {
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
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'OPS', 'Operations', now())`,
      [`fin398_dept_${suffix}`, ORG]
    );
    await client.query(
      `INSERT INTO users (id, "organizationId", name, email, role, department, title, "updatedAt")
       VALUES ($1, $2, 'Admin', $1 || '@test.invalid', 'ADMIN', 'OPS', 'Owner', now())`,
      [ADMIN, ORG]
    );
    await client.query(
      `INSERT INTO clients (id, "organizationId", name, "updatedAt") VALUES ($1, $2, 'Acme', now())`,
      [CLIENT, ORG]
    );

    const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { router } = await import('../trpc');
    const { financeRouter } = await import('./finance');
    const app = router({ finance: financeRouter });
    finance = () =>
      app.createCaller({
        db: createTenantDb(ORG, ADMIN),
        entitlements: {
          organizationId: ORG,
          enabledModules: ['finance'],
          modules: [{ key: 'finance', name: 'Finance', enabled: true }],
          activeSeats: 1,
          seatLimit: 5,
        },
        session: {
          expires: 'later',
          user: { id: ADMIN, role: 'ADMIN', status: 'ACTIVE', organizationId: ORG },
        },
        organization: { id: ORG, isDemo: false },
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {} },
      } as never).finance as unknown as Finance;
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    // Let fire-and-forget activity writes land before the tenant is removed.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(`DELETE FROM activities WHERE "userId" = $1`, [ADMIN]);
    await client.query(`DELETE FROM invoices WHERE "organizationId" = $1`, [ORG]);
    await client.query(`DELETE FROM clients WHERE "organizationId" = $1`, [ORG]);
    await client.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await client.end();
  });

  it('marks paid by recording exactly the outstanding balance, so status and balance agree', async () => {
    const invoice = await insertInvoice({ status: 'SENT', total: 1000 });
    await insertPayment(invoice, 250);

    // A status-only PAID is still refused and writes nothing (#394).
    await expect(
      finance().updateInvoiceStatus({ id: invoice, status: 'PAID' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await invoiceRow(invoice)).status).toBe('SENT');

    const paidAt = new Date('2026-10-20T00:00:00.000Z');
    const result = await finance().markInvoicePaid({
      id: invoice,
      method: 'Bank transfer',
      paidAt,
    });
    expect(result).toMatchObject({ status: 'PAID', amountPaid: 1000, balance: 0 });
    expect(Number(result.payment?.amount)).toBe(750);

    expect((await payments(invoice)).map((p) => p.amount)).toEqual([250, 750]);
    const detail = await finance().getInvoiceById({ id: invoice });
    expect(detail).toMatchObject({ status: 'PAID', amountPaid: 1000, balance: 0 });
    expect(detail?.paidAt).toBeInstanceOf(Date);
  });

  it('is idempotent: marking an invoice already paid in full records nothing', async () => {
    const invoice = await insertInvoice({ status: 'OVERDUE', total: 400, dueInDays: -3 });
    await finance().markInvoicePaid({ id: invoice });
    const again = await finance().markInvoicePaid({ id: invoice });

    expect(again).toMatchObject({ status: 'PAID', balance: 0, payment: null });
    expect((await payments(invoice)).map((p) => p.amount)).toEqual([400]);
  });

  it('refuses to mark a draft or cancelled invoice paid', async () => {
    for (const status of ['DRAFT', 'CANCELLED']) {
      const invoice = await insertInvoice({ status, total: 100 });
      await expect(finance().markInvoicePaid({ id: invoice })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(await payments(invoice)).toEqual([]);
    }
  });

  it('refuses status-only moves that would strand payments on a DRAFT or CANCELLED invoice', async () => {
    const paid = await insertInvoice({ status: 'SENT', total: 300 });
    await finance().markInvoicePaid({ id: paid });
    await expect(
      finance().updateInvoiceStatus({ id: paid, status: 'CANCELLED' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This invoice has recorded payments. Delete them before cancelling it.',
    });

    const partial = await insertInvoice({ status: 'SENT', total: 300 });
    await insertPayment(partial, 100);
    for (const status of ['DRAFT', 'CANCELLED']) {
      await expect(finance().updateInvoiceStatus({ id: partial, status })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    expect((await invoiceRow(paid)).status).toBe('PAID');
    expect((await invoiceRow(partial)).status).toBe('SENT');
    expect(await payments(partial)).toHaveLength(1);

    // Without payments the same moves stay available.
    const unpaid = await insertInvoice({ status: 'SENT', total: 300 });
    await expect(
      finance().updateInvoiceStatus({ id: unpaid, status: 'CANCELLED' })
    ).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  it('reopens a PAID invoice when a payment is deleted: OVERDUE when past due, else SENT', async () => {
    const pastDue = await insertInvoice({ status: 'SENT', total: 500, dueInDays: -10 });
    await finance().markInvoicePaid({ id: pastDue });
    const [pastDuePayment] = await payments(pastDue);
    await expect(finance().deletePayment({ id: pastDuePayment.id })).resolves.toMatchObject({
      status: 'OVERDUE',
      balance: 500,
    });
    expect(await invoiceRow(pastDue)).toEqual({ status: 'OVERDUE', paidAt: null });

    const notDue = await insertInvoice({ status: 'SENT', total: 500, dueInDays: 10 });
    await finance().markInvoicePaid({ id: notDue });
    const [notDuePayment] = await payments(notDue);
    await finance().deletePayment({ id: notDuePayment.id });
    expect(await invoiceRow(notDue)).toEqual({ status: 'SENT', paidAt: null });

    // With its payments gone the invoice may be cancelled.
    await expect(
      finance().updateInvoiceStatus({ id: notDue, status: 'CANCELLED' })
    ).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  it('lets a legacy PAID invoice with an unrecorded balance take payments up to that balance', async () => {
    const legacy = await insertInvoice({ status: 'PAID', total: 1000, paidAt: new Date() });
    await expect(finance().getInvoiceById({ id: legacy })).resolves.toMatchObject({
      status: 'PAID',
      balance: 1000,
    });

    await expect(finance().addPayment({ invoiceId: legacy, amount: 1200 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Payment exceeds the outstanding balance of 1000.00.',
    });
    await expect(finance().addPayment({ invoiceId: legacy, amount: 400 })).resolves.toMatchObject({
      status: 'PAID',
      balance: 600,
    });
    await expect(finance().markInvoicePaid({ id: legacy })).resolves.toMatchObject({
      status: 'PAID',
      balance: 0,
    });
    await expect(finance().addPayment({ invoiceId: legacy, amount: 1 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This invoice is already paid in full.',
    });
    expect((await payments(legacy)).map((p) => p.amount)).toEqual([400, 600]);
  });

  it('keeps edits consistent with recorded payments', async () => {
    const invoice = await insertInvoice({ status: 'SENT', total: 1000 });
    await insertPayment(invoice, 600);

    await expect(
      finance().updateInvoice({
        id: invoice,
        items: [{ description: 'Work', quantity: 1, rate: 500 }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      finance().updateInvoice({
        id: invoice,
        items: [{ description: 'Work', quantity: 1, rate: 1000 }],
        status: 'DRAFT',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This invoice has recorded payments. Delete them before moving it back to draft.',
    });
    expect(await invoiceRow(invoice)).toEqual({ status: 'SENT', paidAt: null });

    // Lowering the total to exactly what was paid settles the invoice.
    await expect(
      finance().updateInvoice({
        id: invoice,
        items: [{ description: 'Work', quantity: 1, rate: 600 }],
      })
    ).resolves.toMatchObject({ status: 'PAID', balance: 0 });
  });

  it('serialises payment writers on the invoice row, so a concurrent payment cannot overpay', async () => {
    const invoice = await insertInvoice({ status: 'SENT', total: 1000 });
    const locker = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await locker.connect();
    try {
      // Another writer holds the row lock with an uncommitted 600 payment.
      await locker.query('BEGIN');
      await locker.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      await locker.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [invoice]);
      await locker.query(
        `INSERT INTO payments (id, "organizationId", "invoiceId", amount, currency)
         VALUES ($1, $2, $3, 600, 'USD')`,
        [newId('pay'), ORG, invoice]
      );

      const pending = finance()
        .addPayment({ invoiceId: invoice, amount: 600 })
        .then(
          () => 'recorded',
          (error: unknown) => error
        );
      await new Promise((resolve) => setTimeout(resolve, 400));
      await locker.query('COMMIT');

      // The router waited for the lock, then saw the committed 600.
      await expect(pending).resolves.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Payment exceeds the outstanding balance of 400.00.',
      });
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      await locker.end();
    }
    expect((await payments(invoice)).map((p) => p.amount)).toEqual([600]);
    expect((await invoiceRow(invoice)).status).toBe('SENT');
  });
});
