/**
 * @vitest-environment node
 *
 * #458 / DEV-243 against a REAL migrated PostgreSQL, through the real finance
 * router: the invoice print view (also the emailed link's landing page) prints
 * the authenticated agency as the seller, and under forced row-level security
 * one agency can neither print another agency's invoice nor read its identity.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role (neither SUPERUSER nor BYPASSRLS — asserted first).
 * Without it the suite reports itself skipped rather than passing vacuously.
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
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), sendEmail: vi.fn(), templates: {} }));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const AGENCY = `iss458_a_${suffix}`;
const OTHER = `iss458_b_${suffix}`;
const BARE = `iss458_c_${suffix}`;
const adminOf = (org: string) => `${org}_admin`;

type Issuer = { name: string; address: string | null; taxId: string | null } | null;
type Finance = { getInvoiceById(input: { id: string }): Promise<{ issuer: Issuer } | null> };

let client: pg.Client;
let finance: (organizationId: string) => Finance;

describeIfDatabase('agency invoice seller identity, against PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", "invoiceAddress", "invoiceTaxId", "updatedAt")
       VALUES ($1, $1, 'Northwind Agency LLC', 'Northwind', E'42 Market Street\\nSeattle, WA 98101', 'US-12-3456789', now()),
              ($2, $2, 'Other Agency Ltd', 'Other', 'Elsewhere 1', 'GB-999', now()),
              ($3, $3, 'Bare Agency', 'Bare', NULL, '  ', now())`,
      [AGENCY, OTHER, BARE]
    );
    for (const org of [AGENCY, OTHER, BARE]) {
      await client.query(
        `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
         VALUES ($1, $2, 'LEADERSHIP', 'Leadership', now())`,
        [`${org}_dept`, org]
      );
      await client.query(
        `INSERT INTO users (id, "organizationId", name, email, role, department, title, "updatedAt")
         VALUES ($1, $2, 'Admin', $1 || '@test.invalid', 'ADMIN', 'LEADERSHIP', 'Admin', now())`,
        [adminOf(org), org]
      );
      await client.query(
        `INSERT INTO clients (id, "organizationId", name, "updatedAt") VALUES ($1, $2, 'Client', now())`,
        [`${org}_client`, org]
      );
      await client.query(
        `INSERT INTO invoices (id, "organizationId", "invoiceNumber", "clientId", items, subtotal, total, currency, status, "dueDate", "updatedAt")
         VALUES ($1, $2, $1, $3, '[]', 100, 100, 'USD', 'SENT', now(), now())`,
        [`${org}_invoice`, org, `${org}_client`]
      );
    }

    const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { router } = await import('../trpc');
    const { financeRouter } = await import('./finance');
    const app = router({ finance: financeRouter });
    finance = (organizationId) =>
      app.createCaller({
        db: createTenantDb(organizationId, adminOf(organizationId)),
        entitlements: {
          organizationId,
          enabledModules: ['finance'],
          modules: [{ key: 'finance', name: 'Finance', enabled: true }],
          activeSeats: 1,
          seatLimit: 5,
        },
        session: {
          expires: 'later',
          user: { id: adminOf(organizationId), role: 'ADMIN', status: 'ACTIVE', organizationId },
        },
        organization: { id: organizationId, isDemo: false },
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {} },
      } as never).finance as unknown as Finance;
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    const orgs = [AGENCY, OTHER, BARE];
    await client.query(`DELETE FROM invoices WHERE "organizationId" = ANY($1)`, [orgs]);
    await client.query(`DELETE FROM clients WHERE "organizationId" = ANY($1)`, [orgs]);
    await client.query(`DELETE FROM users WHERE "organizationId" = ANY($1)`, [orgs]);
    await client.query(`DELETE FROM organization_departments WHERE "organizationId" = ANY($1)`, [
      orgs,
    ]);
    await client.query(`DELETE FROM organizations WHERE id = ANY($1)`, [orgs]);
    await client.end();
  });

  it('prints the authenticated agency, with its address and tax ID, as the seller', async () => {
    const invoice = await finance(AGENCY).getInvoiceById({ id: `${AGENCY}_invoice` });

    expect(invoice?.issuer).toEqual({
      name: 'Northwind Agency LLC',
      address: '42 Market Street\nSeattle, WA 98101',
      taxId: 'US-12-3456789',
    });
  });

  it("does not open another agency's invoice, even by its exact id", async () => {
    await expect(finance(AGENCY).getInvoiceById({ id: `${OTHER}_invoice` })).resolves.toBeNull();
  });

  it("cannot read another agency's identity through the tenant client", async () => {
    const { readInvoiceIssuer } = await import('@/lib/finance/invoice-issuer');
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');

    await expect(withTenantDb(AGENCY, (db) => readInvoiceIssuer(db, OTHER))).resolves.toBeNull();
  });

  it('degrades to the legal name when the optional details are empty', async () => {
    const invoice = await finance(BARE).getInvoiceById({ id: `${BARE}_invoice` });

    expect(invoice?.issuer).toEqual({ name: 'Bare Agency', address: null, taxId: null });
  });
});
