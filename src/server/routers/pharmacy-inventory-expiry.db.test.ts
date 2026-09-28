/**
 * WHA-1602 (PH-A5) — the expiry board actions against migrated PostgreSQL with
 * FORCED row-level security, through the router exactly as the page calls it.
 *
 * What only a real database can prove: that the lot row lock actually
 * serializes two operators acting on the same lot, so a double-submitted
 * quarantine moves stock once, two clerks drafting a return produce one claim,
 * and an identical mark-down is recorded once; and that another organization's
 * lot is unreachable. Skipped (never silently passed) without a database URL.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return {
    ...actual,
    annotateAudit: vi.fn(),
    ipFromHeaders: vi.fn(() => null),
    isAuditExcludedPath: vi.fn(() => true),
    recordTrpcAudit: vi.fn(),
  };
});

const DAY = 86_400_000;
const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1602_a_${suffix}`;
const ORG_B = `org_wha1602_b_${suffix}`;
const CLERK = `user_wha1602_clerk_${suffix}`;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  ledger: typeof import('@/lib/pharmacy/stock-ledger');
  router: (typeof import('./pharmacy-inventory'))['pharmacyInventoryRouter'];
};
let deps: Deps;

let unique = 0;
const tag = (label: string) => `${suffix}-${label}-${(unique += 1)}`;

function caller(organizationId: string) {
  return deps.router.createCaller({
    db: deps.createTenantDb(organizationId, CLERK),
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-inventory'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: { id: CLERK, role: 'ADMIN', status: 'ACTIVE', organizationId },
    },
    organization: { id: organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

type Position = {
  organizationId: string;
  branchId: string;
  inventoryLotId: string;
  stockLocationId: string;
  supplierId: string;
};

/** A branch, a shelf, a supplier and one lot of 60 units expiring in 45 days. */
async function nearExpiryLot(organizationId: string, label: string): Promise<Position> {
  const branchId = `branch_${tag(label)}`;
  return deps.withTenantDb(organizationId, async (db: ScopedDb) => {
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId,
        code: branchId,
        name: `Branch ${label}`,
        addressLine: '1 Test Road',
        city: 'Karachi',
        provinceCode: 'SD',
      },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Amoxicillin 500mg ${tag(label)}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId, presentation: 'Capsule, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const packLevel = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${tag(label)}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date(Date.now() - 90 * DAY),
      },
    });
    const [location, supplier] = await Promise.all([
      db.pharmacyStockLocation.create({
        data: {
          organizationId,
          branchId,
          code: `SHELF-${tag(label)}`,
          name: 'Shelf',
          kind: 'STORE',
        },
      }),
      db.pharmacySupplier.create({
        data: { organizationId, name: `Distributor ${tag(label)}`, authorized: true },
      }),
    ]);
    const expiresAt = new Date(Date.now() + 45 * DAY);
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId,
        medicineId: medicine.id,
        batchNumber: `B-${tag(label)}`,
        expiresAt,
        expiryPrecision: 'DAY',
      },
    });
    const { lot } = await deps.ledger.receiveLot(
      db,
      { organizationId, branchId, actorId: CLERK },
      {
        manufacturingBatchId: batch.id,
        packLevelId: packLevel.id,
        stockLocationId: location.id,
        unitsPerPack: 10,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: `INV-${tag(label)}`,
        unitCostMinor: 2_500,
        printedMrpMinor: 32_000,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 60,
        idempotencyKey: `receipt-${tag(label)}`,
        receivedAt: new Date(Date.now() - 30 * DAY),
      }
    );
    return {
      organizationId,
      branchId,
      inventoryLotId: lot.id,
      stockLocationId: location.id,
      supplierId: supplier.id,
    };
  });
}

const where = (position: Position) => ({
  branchId: position.branchId,
  inventoryLotId: position.inventoryLotId,
  stockLocationId: position.stockLocationId,
});

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, ledger, router, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/pharmacy/stock-ledger'),
    import('./pharmacy-inventory'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    createTenantDb: scopedDb.createTenantDb,
    ledger,
    router: router.pharmacyInventoryRouter,
  };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
}, 120_000);

describeIfDatabase('PH-A5 — expiry board actions under concurrency', () => {
  it('a double-submitted quarantine moves the stock exactly once', async () => {
    const position = await nearExpiryLot(ORG_A, 'quarantine');
    const input = {
      ...where(position),
      units: 60,
      reason: 'Near expiry: pulled from sale',
      requestKey: `request-${tag('quarantine')}`,
    };
    const results = await Promise.all([
      caller(ORG_A).quarantineExpiring(input),
      caller(ORG_A).quarantineExpiring(input),
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    const balances = await deps.withTenantDb(ORG_A, (db) =>
      db.pharmacyStockBalance.findMany({
        where: { inventoryLotId: position.inventoryLotId },
        select: { disposition: true, onHandUnits: true },
      })
    );
    expect(Object.fromEntries(balances.map((row) => [row.disposition, row.onHandUnits]))).toEqual({
      AVAILABLE: 0,
      QUARANTINE: 60,
    });
  });

  it('two clerks drafting a return for the same lot produce one DRAFT claim', async () => {
    const position = await nearExpiryLot(ORG_A, 'return');
    const input = {
      ...where(position),
      supplierId: position.supplierId,
      units: 30,
      reason: 'Near expiry',
    };
    const results = await Promise.all([
      caller(ORG_A).draftExpiryReturn(input),
      caller(ORG_A).draftExpiryReturn(input),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0].purchaseReturn.id).toBe(results[1].purchaseReturn.id);
    const [returns, claims] = await deps.withTenantDb(ORG_A, (db) =>
      Promise.all([
        db.pharmacyPurchaseReturn.findMany({
          where: { lines: { some: { inventoryLotId: position.inventoryLotId } } },
          select: { kind: true, status: true },
        }),
        db.pharmacySupplierClaim.count({ where: { inventoryLotId: position.inventoryLotId } }),
      ])
    );
    expect(returns).toEqual([{ kind: 'EXPIRY_CLAIM', status: 'DRAFT' }]);
    // A draft reserves nothing.
    expect(claims).toBe(0);
  });

  it('an identical mark-down submitted twice is recorded once and shown on the board', async () => {
    const position = await nearExpiryLot(ORG_A, 'markdown');
    const input = { ...where(position), markdownPercent: 25, reason: 'Clear before expiry' };
    const results = await Promise.all([
      caller(ORG_A).draftExpiryMarkdown(input),
      caller(ORG_A).draftExpiryMarkdown(input),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0].eventId).toBe(results[1].eventId);
    const board = await caller(ORG_A).expiryBoardLots({
      branchId: position.branchId,
      withinDays: 60,
    });
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]).toMatchObject({
      inventoryLotId: position.inventoryLotId,
      onHandUnits: 60,
      valueAtRiskMinor: 60 * 2_500,
      markdown: { markdownPercent: 25, proposedPackPriceMinor: 24_000 },
    });
    // The printed MRP the counter sells at is untouched.
    const lot = await deps.withTenantDb(ORG_A, (db) =>
      db.pharmacyInventoryLot.findFirstOrThrow({
        where: { id: position.inventoryLotId },
        select: { printedMrpMinor: true },
      })
    );
    expect(lot.printedMrpMinor).toBe(32_000);
  });

  it("refuses another organization's branch and lot", async () => {
    const position = await nearExpiryLot(ORG_A, 'foreign');
    await expect(
      caller(ORG_B).quarantineExpiring({
        ...where(position),
        units: 10,
        reason: 'Probe',
        requestKey: `request-${tag('foreign')}`,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller(ORG_B).expiryBoardLots({ branchId: position.branchId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const moved = await deps.withTenantDb(ORG_A, (db) =>
      db.pharmacyStockMovement.count({ where: { inventoryLotId: position.inventoryLotId } })
    );
    expect(moved).toBe(1);
  });
});
