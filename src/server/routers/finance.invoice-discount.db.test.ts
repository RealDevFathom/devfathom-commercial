// @vitest-environment node
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '../trpc';
import { assertDisposableRlsDatabase } from '../../../tests/disposable-rls-database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const tag = `invoice_discount_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const role = `${tag}_runtime`;
const orgId = `${tag}_org`;
let owner: pg.Client;
let tenancy: typeof import('@/lib/tenancy/scoped-db');
let finance: typeof import('./finance').financeRouter;
let audit: typeof import('../audit');
let previousDatabaseUrl: string | undefined;
let sequence = 0;
const lines = [{ description: 'Consulting', quantity: 1, rate: 100 }];

function caller(tx: ScopedDb) {
  return finance.createCaller({
    db: tx,
    entitlements: { organizationId: orgId, enabledModules: ['finance'], modules: [] },
    session: {
      expires: '2099-01-01',
      user: { id: `${orgId}_user`, organizationId: orgId, role: 'ADMIN', status: 'ACTIVE' },
    },
    organization: { id: orgId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}
function inOrg<T>(fn: (tx: ScopedDb) => Promise<T>) {
  return tenancy.withTenantDb(orgId, fn);
}
function seedInvoice(tx: ScopedDb, extra: Partial<Prisma.InvoiceUncheckedCreateInput> = {}) {
  return tx.invoice.create({
    data: {
      invoiceNumber: `${tag}_${++sequence}`,
      clientId: `${orgId}_client`,
      items: lines.map((line) => ({ ...line, amount: 100 })),
      subtotal: 100,
      tax: 0,
      total: 100,
      status: 'SENT',
      dueDate: new Date('2026-12-01'),
      ...extra,
    },
  });
}

// A unique non-bypassing role makes the invoice locks, RLS and rollbacks real.
// No schema changes or migrations are performed by this suite.
describe.skipIf(!databaseUrl)('invoice discounts against PostgreSQL', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(databaseUrl!);
    previousDatabaseUrl = process.env.DATABASE_URL;
    owner = new pg.Client({ connectionString: databaseUrl });
    await owner.connect();
    await owner.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await owner.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO "${role}"`);
    await owner.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    await owner.query(
      'INSERT INTO organizations(id,slug,"legalName","displayName",status,"updatedAt") VALUES($1,$1,$1,$1,\'ACTIVE\',now())',
      [orgId]
    );
    await owner.query(
      'INSERT INTO organization_departments(id,"organizationId",key,name,"updatedAt") VALUES($1,$2,\'QA\',\'QA\',now())',
      [`${orgId}_dept`, orgId]
    );
    await owner.query(
      "INSERT INTO users(id,\"organizationId\",name,email,role,department,title,\"updatedAt\") VALUES($1,$2,'Test Admin',$3,'ADMIN','QA','QA',now())",
      [`${orgId}_user`, orgId, `${orgId}@example.test`]
    );
    await owner.query(
      'INSERT INTO clients(id,"organizationId",name,"updatedAt") VALUES($1,$2,\'Test Client\',now())',
      [`${orgId}_client`, orgId]
    );
    const runtime = new URL(databaseUrl!);
    runtime.searchParams.set('options', `-c role=${role}`);
    runtime.searchParams.set('application_name', tag);
    process.env.DATABASE_URL = runtime.toString();
    tenancy = await import('@/lib/tenancy/scoped-db');
    finance = (await import('./finance')).financeRouter;
    audit = await import('../audit');
  }, 30_000);

  afterAll(async () => {
    if (audit) await audit.flushAuditWritesForTest();
    if (tenancy) {
      const { db } = await import('@/lib/db');
      await db.$disconnect();
    }
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (!owner) return;
    for (const table of [
      'audit_logs',
      'activities',
      'payments',
      'invoices',
      'clients',
      'users',
      'organization_departments',
    ]) {
      await owner.query(`DELETE FROM "${table}" WHERE "organizationId"=$1`, [orgId]);
    }
    await owner.query('DELETE FROM organizations WHERE id=$1', [orgId]);
    await owner.query(`DROP OWNED BY "${role}"`);
    await owner.query(`DROP ROLE "${role}"`);
    await owner.end();
  }, 30_000);

  it('runs with enforced invoice RLS and a non-bypassing role', async () => {
    const rows = await inOrg(
      (tx) => tx.$queryRaw<
        Array<{
          rolsuper: boolean;
          rolbypassrls: boolean;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }>
      >`
      SELECT rolsuper, rolbypassrls, relrowsecurity, relforcerowsecurity
      FROM pg_roles CROSS JOIN pg_class
      WHERE rolname=current_user AND pg_class.oid='invoices'::regclass`
    );
    expect(rows).toEqual([
      { rolsuper: false, rolbypassrls: false, relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('rejects a discount below recorded payments without changing the invoice', async () => {
    const invoice = await inOrg((tx) => seedInvoice(tx));
    await inOrg((tx) => caller(tx).addPayment({ invoiceId: invoice.id, amount: 80 }));
    await expect(
      inOrg((tx) => caller(tx).updateInvoice({ id: invoice.id, items: lines, discount: 50 }))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const saved = await inOrg((tx) => caller(tx).getInvoiceById({ id: invoice.id }));
    expect(saved).toMatchObject({ status: 'SENT', amountPaid: 80, balance: 20 });
    expect(Number(saved?.discount)).toBe(0);
  });

  it.each([0, 80])(
    'settles an issued invoice when discount clears the balance with %s paid',
    async (amount) => {
      const invoice = await inOrg((tx) => seedInvoice(tx));
      if (amount) await inOrg((tx) => caller(tx).addPayment({ invoiceId: invoice.id, amount }));
      const saved = await inOrg((tx) =>
        caller(tx).updateInvoice({ id: invoice.id, items: lines, discount: 100 - amount })
      );
      expect(saved).toMatchObject({ status: 'PAID', amountPaid: amount, balance: 0 });
      expect(saved.paidAt).toBeInstanceOf(Date);
      expect(saved.payments).toHaveLength(amount ? 1 : 0);
    }
  );

  it('keeps a fully discounted draft editable, then settles it when issued', async () => {
    const invoice = await inOrg((tx) =>
      caller(tx).createInvoice({
        clientId: `${orgId}_client`,
        items: lines.map((line) => ({ ...line, amount: 0 })),
        subtotal: 0,
        total: 0,
        discount: 100,
        dueDate: new Date('2026-12-01'),
      })
    );
    expect(invoice.status).toBe('DRAFT');
    const issued = await inOrg((tx) =>
      caller(tx).updateInvoiceStatus({ id: invoice.id, status: 'SENT' })
    );
    expect(issued.status).toBe('PAID');
    expect(issued.sentAt).toBeInstanceOf(Date);
    expect(issued.paidAt).toBeInstanceOf(Date);
    expect(await inOrg((tx) => tx.payment.count({ where: { invoiceId: invoice.id } }))).toBe(0);
  });

  it('rolls back discount settlement with its owning transaction', async () => {
    const invoice = await inOrg((tx) => seedInvoice(tx));
    await expect(
      inOrg(async (tx) => {
        await caller(tx).updateInvoice({ id: invoice.id, items: lines, discount: 100 });
        throw new Error('rollback discount settlement');
      })
    ).rejects.toThrow('rollback discount settlement');
    const saved = await inOrg((tx) => caller(tx).getInvoiceById({ id: invoice.id }));
    expect(saved).toMatchObject({ status: 'SENT', paidAt: null, balance: 100 });
    expect(Number(saved?.discount)).toBe(0);
  });

  it('serializes a racing payment after the discount and rejects its overpayment', async () => {
    const invoice = await inOrg((tx) => seedInvoice(tx));
    let signalLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const edit = inOrg((tx) =>
      caller(
        new Proxy(tx, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            if (key === '$transaction') {
              return async (work: (inner: ScopedDb) => Promise<unknown>) => work(receiver);
            }
            if (key !== '$queryRaw') return value;
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(value, target, args);
              signalLocked();
              await release;
              return result;
            };
          },
        })
      ).updateInvoice({ id: invoice.id, items: lines, discount: 50 })
    );
    await locked;
    const payment = inOrg((tx) => caller(tx).addPayment({ invoiceId: invoice.id, amount: 80 }));
    // Attach rejection handling immediately so a failed assertion cannot leak it.
    const paymentResult = payment.then(
      () => 'accepted',
      (error) => error.code as string
    );
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const result = await owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
          [tag]
        );
        blocked = result.rowCount !== 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
    } finally {
      releaseLock();
    }
    await edit;
    expect(await paymentResult).toBe('BAD_REQUEST');
    const saved = await inOrg((tx) => caller(tx).getInvoiceById({ id: invoice.id }));
    expect(saved).toMatchObject({ status: 'SENT', amountPaid: 0, balance: 50 });
    expect(Number(saved?.total)).toBe(50);
  }, 10_000);
});
