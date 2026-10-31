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

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const disposableDatabaseName = /(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i;

if (databaseUrl) {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!disposableDatabaseName.test(databaseName)) {
    throw new Error(
      'TEST_DATABASE_URL must name a dedicated disposable database (test, e2e, tmp, or disposable).'
    );
  }
}

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
const reviewerIds = [`pur472_first_reviewer_${suffix}`, `pur472_second_reviewer_${suffix}`];
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
function synchronizePurchaseOrderReads(databases: ScopedDb[]) {
  const observedStatuses: Array<string | undefined> = [];
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    release = resolve;
  });

  const wrap = (database: ScopedDb): ScopedDb =>
    new Proxy(database, {
      get(target, key, receiver) {
        if (key === '$transaction') {
          return (operation: (tx: ScopedDb) => Promise<unknown>) =>
            target.$transaction((tx) => operation(wrap(tx as ScopedDb)));
        }
        if (key !== 'pharmacyPurchaseOrder') return Reflect.get(target, key, receiver);
        return new Proxy(target.pharmacyPurchaseOrder, {
          get(delegate, operation, delegateReceiver) {
            if (operation !== 'findFirst')
              return Reflect.get(delegate, operation, delegateReceiver);
            return async (args: Parameters<typeof delegate.findFirst>[0]) => {
              const order = await delegate.findFirst(args);
              observedStatuses.push(order?.status);
              reads += 1;
              if (reads === databases.length) release();
              await bothRead;
              return order;
            };
          },
        });
      },
    });

  return { databases: databases.map(wrap), observedStatuses };
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
    // Procurement is checked against live tenant users, and a branchless order
    // is reviewed only by organization-wide purchasers.
    for (const reviewerId of reviewerIds) {
      await owner.query(
        `INSERT INTO users
           (id, "organizationId", name, email, role, department, title, "updatedAt")
         VALUES ($1, $2, $1, $1 || '@pur472.test', 'ADMIN', 'Pharmacy', 'Buyer', now())`,
        [reviewerId, organizationId]
      );
      await owner.query(
        `INSERT INTO pharmacy_central_purchasing_access
           (id, "organizationId", "userId", "branchId", "grantedById")
         VALUES ($1, $2, $3, NULL, $3)`,
        [`${reviewerId}_central`, organizationId, reviewerId]
      );
    }
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    // Append-only fixture rows intentionally remain in the throwaway database.
    // Cleanup must never weaken the regulated tables' triggers, even briefly.
    await owner.end();
  });

  it.each([
    ['APPROVED', 'REJECTED'],
    ['APPROVED', 'APPROVED'],
    ['REJECTED', 'REJECTED'],
  ] as const)(
    'commits exactly one competing %s/%s decision and one matching approval event',
    async (firstDecision, secondDecision) => {
      const purchaseOrderId = `pur472_po_${firstDecision}_${secondDecision}_${suffix}`;
      await owner.query(
        `INSERT INTO pharmacy_purchase_orders
           (id, "organizationId", reference, status, "supplierId", "createdByUserId", "submittedAt", "updatedAt")
         VALUES ($1, $2, $1, 'SUBMITTED', $3, 'pur472_creator', now(), now())`,
        [purchaseOrderId, organizationId, supplierId]
      );

      const transactionDbs: ScopedDb[] = [];
      let synchronized: ReturnType<typeof synchronizePurchaseOrderReads> | undefined;
      let releaseTransactions!: () => void;
      const transactionsReady = new Promise<void>((resolve) => (releaseTransactions = resolve));
      const decide = (userId: string, decision: 'APPROVED' | 'REJECTED') =>
        withTenantDb(organizationId, async (db) => {
          const index = transactionDbs.push(db) - 1;
          if (transactionDbs.length === 2) releaseTransactions();
          await transactionsReady;
          synchronized ??= synchronizePurchaseOrderReads(transactionDbs);
          return caller(synchronized.databases[index]!, userId).approvePurchaseOrder({
            purchaseOrderId,
            decision,
          });
        });

      const first = decide(reviewerIds[0]!, firstDecision);
      const second = decide(reviewerIds[1]!, secondDecision);

      const results = await Promise.allSettled([first, second]);
      expect(synchronized?.observedStatuses).toEqual(['SUBMITTED', 'SUBMITTED']);
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
      const committedDecision = results[0]?.status === 'fulfilled' ? firstDecision : secondDecision;
      expect(persisted.rows[0]).toEqual({
        status: committedDecision === 'APPROVED' ? 'APPROVED' : 'DRAFT',
        decision: committedDecision,
      });
    }
  );
});
