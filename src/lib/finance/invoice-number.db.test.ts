/**
 * @vitest-environment node
 *
 * DEV-258: invoice numbering against a real, migrated PostgreSQL database.
 *
 * Every router call runs inside `withTenantDb`, as the tRPC route runs it, and as
 * a NOSUPERUSER NOBYPASSRLS role, so RLS limits each tenant to its own invoices
 * exactly as in production. Requires TEST_DATABASE_URL (a disposable, migrated
 * database). An admin URL may prepare fixtures; the suite then creates a
 * restricted role for the router calls.
 */
import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { db } from '@/lib/db';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { clientsRouter } from '@/server/routers/clients';
import { financeRouter } from '@/server/routers/finance';
import { allocateInvoiceNumber } from './invoice-number';

// Only an explicitly configured disposable database may receive test fixtures.
const databaseUrl = process.env.TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const year = new Date().getFullYear();
const tenantIds: string[] = [];
let setup: Client | undefined;
let runtimeRole: string | undefined;

type Tenant = { id: string; adminId: string; clientId: string; contractId: string };

async function createTenant(label: string): Promise<Tenant> {
  const id = `inv_num_${label}_${randomUUID().replaceAll('-', '')}`;
  const tenant = {
    id,
    adminId: `${id}_admin`,
    clientId: `${id}_client`,
    contractId: `${id}_contract`,
  };
  tenantIds.push(id);
  await setup!.query(
    `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
     VALUES ($1, $1, 'Invoice numbering test', 'Invoice numbering test', now())`,
    [id]
  );
  await setup!.query(
    `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
     VALUES ($1, $2, 'LEADERSHIP', 'Leadership', now())`,
    [`${id}_department`, id]
  );
  await setup!.query(
    `INSERT INTO users (id, "organizationId", name, email, role, department, title, "updatedAt")
     VALUES ($1, $2, 'Finance admin', $3, 'ADMIN', 'LEADERSHIP', 'Owner', now())`,
    [tenant.adminId, id, `${tenant.adminId}@example.test`]
  );
  await setup!.query(
    `INSERT INTO clients (id, "organizationId", name, "updatedAt") VALUES ($1, $2, 'Acme', now())`,
    [tenant.clientId, id]
  );
  await setup!.query(
    `INSERT INTO contracts (id, "organizationId", "clientId", title, value, "updatedAt")
     VALUES ($1, $2, $3, 'Retainer', 500, now())`,
    [tenant.contractId, id, tenant.clientId]
  );
  return tenant;
}

function context(tenant: Tenant, scoped: ScopedDb) {
  return {
    db: scoped,
    session: {
      expires: 'later',
      user: {
        id: tenant.adminId,
        name: 'Finance admin',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: tenant.id,
      },
    },
    organization: { id: tenant.id },
    entitlements: { organizationId: tenant.id, enabledModules: [], modules: [], limits: {} },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never;
}

/** finance.createInvoice in its own request transaction, as the tRPC route runs it. */
function createInvoice(tenant: Tenant) {
  return withTenantDb(
    tenant.id,
    (tx) =>
      financeRouter.createCaller(context(tenant, tx)).createInvoice({
        clientId: tenant.clientId,
        items: [{ description: 'Design sprint', quantity: 1, rate: 100, amount: 100 }],
        subtotal: 100,
        tax: 0,
        total: 100,
        currency: 'USD',
        dueDate: new Date(`${year}-12-31T00:00:00.000Z`),
      }),
    { userId: tenant.adminId, timeout: 15_000 }
  );
}

function generateFromContract(tenant: Tenant) {
  return withTenantDb(
    tenant.id,
    (tx) =>
      clientsRouter
        .createCaller(context(tenant, tx))
        .generateInvoiceFromContract({ contractId: tenant.contractId }),
    { userId: tenant.adminId, timeout: 15_000 }
  );
}

async function invoiceNumbers(organizationId: string) {
  const { rows } = await setup!.query<{ invoiceNumber: string }>(
    `SELECT "invoiceNumber" FROM invoices WHERE "organizationId" = $1 ORDER BY "invoiceNumber"`,
    [organizationId]
  );
  return rows.map((row) => row.invoiceNumber);
}

async function advisoryLockWaiters() {
  const { rows } = await setup!.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock' AND wait_event = 'advisory'
        AND query LIKE '%pg_advisory_xact_lock%'`
  );
  return rows[0]!.count;
}

async function waitForAdvisoryLockWaiters(count: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await advisoryLockWaiters()) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${count} sessions to queue on the invoice-number lock`);
}

suite('invoice numbering on PostgreSQL (DEV-258)', () => {
  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    const { rows } = await setup.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    const runtimeUrl = new URL(databaseUrl!);
    if (rows[0]!.rolsuper || rows[0]!.rolbypassrls) {
      // An admin URL may prepare fixtures, but router calls must still exercise RLS.
      runtimeRole = `invoice_number_test_${randomUUID().replaceAll('-', '')}`;
      await setup.query(`CREATE ROLE "${runtimeRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await setup.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
      await setup.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${runtimeRole}"`
      );
      await setup.query(
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${runtimeRole}"`
      );
      runtimeUrl.searchParams.set(
        'options',
        `${runtimeUrl.searchParams.get('options') ?? ''} -c role=${runtimeRole}`.trim()
      );
    }
    process.env.DATABASE_URL = runtimeUrl.toString();
    await withTenantDb('invoice_number_probe', async (tx) => {
      expect(
        await tx.$queryRaw`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    });
    // Fixtures are written across tenants, which the RLS policies allow only on
    // the platform path.
    await setup.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
  });

  afterAll(async () => {
    await db.$disconnect();
    if (setup && tenantIds.length > 0) {
      for (const table of ['activities', 'invoices', 'contracts', 'clients', 'users']) {
        await setup.query(`DELETE FROM ${table} WHERE "organizationId" = ANY($1)`, [tenantIds]);
      }
      await setup.query(`DELETE FROM organization_departments WHERE "organizationId" = ANY($1)`, [
        tenantIds,
      ]);
      await setup.query(`DELETE FROM organizations WHERE id = ANY($1)`, [tenantIds]);
    }
    if (runtimeRole) {
      await setup?.query(`DROP OWNED BY "${runtimeRole}"`);
      await setup?.query(`DROP ROLE "${runtimeRole}"`);
    }
    await setup?.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('lets two organizations each issue the first number of the year', async () => {
    const agencyA = await createTenant('a');
    const agencyB = await createTenant('b');

    const first = await createInvoice(agencyA);
    const second = await createInvoice(agencyB);

    expect(first.invoiceNumber).toBe(`INV-${year}-001`);
    expect(second.invoiceNumber).toBe(`INV-${year}-001`);
    expect(await invoiceNumbers(agencyA.id)).toEqual([`INV-${year}-001`]);
    expect(await invoiceNumbers(agencyB.id)).toEqual([`INV-${year}-001`]);

    // The number is still unique inside one organization.
    await expect(
      withTenantDb(agencyA.id, (tx) =>
        tx.invoice.create({
          data: {
            invoiceNumber: `INV-${year}-001`,
            clientId: agencyA.clientId,
            items: [],
            subtotal: 0,
            total: 0,
            dueDate: new Date(),
          },
        })
      )
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('gives two concurrent creates in one organization distinct numbers', async () => {
    const agency = await createTenant('race');
    const bystander = await createTenant('bystander');
    const baseline = await advisoryLockWaiters();
    let releaseHolder!: () => void;
    const holding = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      holderLocked = resolve;
    });
    const pending: Promise<unknown>[] = [];

    try {
      // Hold the organization's numbering lock so both creates are in flight
      // together before either can read the sequence.
      const holder = withTenantDb(
        agency.id,
        async (tx) => {
          await allocateInvoiceNumber(tx);
          holderLocked();
          await holding;
        },
        { timeout: 15_000 }
      );
      pending.push(holder);
      await locked;

      const creates = [createInvoice(agency), createInvoice(agency)];
      pending.push(...creates);
      await waitForAdvisoryLockWaiters(baseline + 2);

      // The lock is per organization: another tenant is not held up.
      expect((await createInvoice(bystander)).invoiceNumber).toBe(`INV-${year}-001`);

      releaseHolder();
      await holder;
      const created = await Promise.all(creates);

      expect(created.map((invoice) => invoice.invoiceNumber).sort()).toEqual([
        `INV-${year}-001`,
        `INV-${year}-002`,
      ]);
      expect(await invoiceNumbers(agency.id)).toEqual([`INV-${year}-001`, `INV-${year}-002`]);
    } finally {
      releaseHolder();
      await Promise.allSettled(pending);
    }
  }, 20_000);

  it('keeps a burst of creates from every router on one gapless sequence', async () => {
    const agency = await createTenant('burst');

    const results = await Promise.allSettled([
      createInvoice(agency),
      generateFromContract(agency),
      createInvoice(agency),
      generateFromContract(agency),
      createInvoice(agency),
      generateFromContract(agency),
    ]);

    expect(results.map((result) => result.status)).toEqual(Array(6).fill('fulfilled'));
    expect(await invoiceNumbers(agency.id)).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => `INV-${year}-00${n}`)
    );
  }, 20_000);
});
