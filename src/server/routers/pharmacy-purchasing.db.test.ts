/**
 * PUR-02 decision concurrency against PostgreSQL.
 *
 * This suite deliberately synchronizes two independent transactions after
 * both have read SUBMITTED. A mock cannot reproduce PostgreSQL waiting on the
 * competing UPDATE and re-evaluating its status predicate after that wait.
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const describeIfDatabase = databaseUrl ? describe : describe.skip;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let pharmacyPurchasingRouter: typeof import('./pharmacy-purchasing').pharmacyPurchasingRouter;

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const organizationId = `pur472_org_${suffix}`;
const supplierId = `pur472_supplier_${suffix}`;
const purchaseOrderId = `pur472_po_${suffix}`;
const owner = new pg.Client({ connectionString: databaseUrl });

function caller(db: ScopedDb, userId: string) {
  return pharmacyPurchasingRouter.createCaller({
    db,
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-procurement'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 2,
    },
    session: {
      expires: 'later',
      user: { id: userId, role: 'ADMIN', status: 'ACTIVE', organizationId },
    },
    organization: { id: organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

/** Pause each transaction only after its real SELECT has observed SUBMITTED. */
function synchronizePurchaseOrderReads(databases: ScopedDb[]): ScopedDb[] {
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    release = resolve;
  });

  return databases.map(
    (database) =>
      new Proxy(database, {
        get(target, key, receiver) {
          if (key !== 'pharmacyPurchaseOrder') return Reflect.get(target, key, receiver);
          return new Proxy(target.pharmacyPurchaseOrder, {
            get(delegate, operation, delegateReceiver) {
              if (operation !== 'findFirst')
                return Reflect.get(delegate, operation, delegateReceiver);
              return async (args: Parameters<typeof delegate.findFirst>[0]) => {
                const order = await delegate.findFirst(args);
                reads += 1;
                if (reads === databases.length) release();
                await bothRead;
                return order;
              };
            },
          });
        },
      })
  );
}

describeIfDatabase('purchase-order decision concurrency against PostgreSQL', () => {
  beforeAll(async () => {
    ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    ({ pharmacyPurchasingRouter } = await import('./pharmacy-purchasing'));
    await owner.connect();
    await owner.query(`SET app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO organizations
         (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ONBOARDING', 'SHARED', now(), now())`,
      [organizationId]
    );
    await owner.query(
      `INSERT INTO pharmacy_suppliers
         (id, "organizationId", name, authorized, "updatedAt")
       VALUES ($1, $2, $1, true, now())`,
      [supplierId, organizationId]
    );
    await owner.query(
      `INSERT INTO pharmacy_supplier_licences
         (id, "organizationId", "supplierId", "licenceType", "licenceNumber",
          "issuingAuthority", "issuedAt", "expiresAt", "verifiedAt")
       VALUES ($1, $2, $3, 'WHOLESALE', $1, 'Test authority', now(), '2099-01-01', now())`,
      [`pur472_licence_${suffix}`, organizationId, supplierId]
    );
    await owner.query(
      `INSERT INTO pharmacy_purchase_orders
         (id, "organizationId", reference, status, "supplierId", "createdByUserId", "submittedAt", "updatedAt")
       VALUES ($1, $2, $1, 'SUBMITTED', $3, 'pur472_creator', now(), now())`,
      [purchaseOrderId, organizationId, supplierId]
    );
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    try {
      // These two regulated tables are append-only in normal operation. The
      // disposable fixture is removed as database owner after its assertions.
      await owner.query(
        'ALTER TABLE pharmacy_purchase_order_approvals DISABLE TRIGGER pharmacy_purchase_order_approval_append_only'
      );
      await owner.query(
        'ALTER TABLE pharmacy_supplier_licences DISABLE TRIGGER pharmacy_supplier_licence_append_only'
      );
      await owner.query(
        'DELETE FROM pharmacy_purchase_order_approvals WHERE "organizationId" = $1',
        [organizationId]
      );
      await owner.query('DELETE FROM pharmacy_purchase_orders WHERE "organizationId" = $1', [
        organizationId,
      ]);
      await owner.query('DELETE FROM pharmacy_supplier_licences WHERE "organizationId" = $1', [
        organizationId,
      ]);
      await owner.query('DELETE FROM pharmacy_suppliers WHERE "organizationId" = $1', [
        organizationId,
      ]);
      await owner.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
    } finally {
      await owner
        .query(
          'ALTER TABLE pharmacy_purchase_order_approvals ENABLE TRIGGER pharmacy_purchase_order_approval_append_only'
        )
        .catch(() => undefined);
      await owner
        .query(
          'ALTER TABLE pharmacy_supplier_licences ENABLE TRIGGER pharmacy_supplier_licence_append_only'
        )
        .catch(() => undefined);
      await owner.end();
    }
  });

  it('commits exactly one competing decision and one matching approval event', async () => {
    const transactionDbs: ScopedDb[] = [];
    let synchronizedDbs: ScopedDb[] | undefined;
    let releaseTransactions!: () => void;
    const transactionsReady = new Promise<void>((resolve) => (releaseTransactions = resolve));
    const decide = (userId: string, decision: 'APPROVED' | 'REJECTED') =>
      withTenantDb(organizationId, async (db) => {
        const index = transactionDbs.push(db) - 1;
        if (transactionDbs.length === 2) releaseTransactions();
        await transactionsReady;
        synchronizedDbs ??= synchronizePurchaseOrderReads(transactionDbs);
        return caller(synchronizedDbs[index]!, userId).approvePurchaseOrder({
          purchaseOrderId,
          decision,
        });
      });

    const first = decide('pur472_approver', 'APPROVED');
    const second = decide('pur472_rejector', 'REJECTED');

    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'CONFLICT' },
    });

    const persisted = await owner.query<{ status: string; decision: string }>(
      `SELECT po.status, approval.decision
         FROM pharmacy_purchase_orders po
         JOIN pharmacy_purchase_order_approvals approval
           ON approval."organizationId" = po."organizationId"
          AND approval."purchaseOrderId" = po.id
        WHERE po."organizationId" = $1 AND po.id = $2`,
      [organizationId, purchaseOrderId]
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toEqual(
      results[0]?.status === 'fulfilled'
        ? { status: 'APPROVED', decision: 'APPROVED' }
        : { status: 'DRAFT', decision: 'REJECTED' }
    );
  });
});
