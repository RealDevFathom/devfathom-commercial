/**
 * PUR-07 — the stock action centre against migrated PostgreSQL with FORCED row
 * level security.
 *
 * The evaluator itself is exhaustively covered in `stock-signals.test.ts`. What
 * can only be proven here is everything about it that is a *database* fact:
 *
 *   - the facts really are read off the ledger projection, the INV-09
 *     reservations, the approved safety stock and the open PO/transfer
 *     quantities, rather than from anything the caller passed in;
 *   - deduplication is a partial unique index, not a convention;
 *   - a signal closes when on-hand plus approved inbound covers the need;
 *   - STALE is applied from the freshness policy stored on the row;
 *   - §8A INVARIANT 29: a one-click action creates a DRAFT document and NOTHING
 *     ELSE. The negative half of that test counts `pharmacy_stock_movements`,
 *     `pharmacy_purchase_orders` and `pharmacy_supplier_claims` before and
 *     after, so a future change that quietly makes a signal post stock or raise
 *     an order fails here rather than in production.
 *
 * Skipped (never silently passed) when the database URL is absent. The runtime
 * role is asserted NOSUPERUSER/NOBYPASSRLS first.
 */
import { randomBytes } from 'node:crypto';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { DEFAULT_SIGNAL_POLICY } from './stock-signals';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1176_sig_a_${suffix}`;
const ORG_B = `org_wha1176_sig_b_${suffix}`;
const BRANCH_A = 'branch_a';
const BRANCH_B = 'branch_b';
const ACTOR = `user_inventory_lead_${suffix}`;

const NOW = new Date('2026-09-02T09:00:00.000Z');
const DAY = 86_400_000;
const FAR = new Date(NOW.getTime() + 400 * DAY);

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  ledger: typeof import('./stock-ledger');
  signals: typeof import('./stock-signals-operations');
};
let deps: Deps;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

let unique = 0;
function tag(label: string) {
  unique += 1;
  return `${suffix}-${label}-${unique}`;
}

async function ensureBranch(db: ScopedDb, organizationId: string, branchId: string) {
  await db.pharmacyBranch.createMany({
    data: [
      {
        id: branchId,
        organizationId,
        code: branchId,
        name: `Branch ${branchId}`,
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    ],
    skipDuplicates: true,
  });
}

type Scenario = {
  organizationId: string;
  branchId: string;
  medicineId: string;
  packLevelId: string;
  locationId: string;
  fridgeId: string;
  supplierId: string;
};

/**
 * A private catalog, two locations and a supplier for one test — AND ITS OWN
 * BRANCH. Unlike the INV-01..04 suite, a private medicine is not enough here:
 * `refreshStockSignals`, `roleDashboard` and `ownerDigest` are branch-wide by
 * design, so tests sharing a branch would count, close and refresh each other's
 * signals and a dedup or digest case could pass or fail for a neighbour's
 * reasons. `branchId` carries no foreign key until PLAT-03, so a per-test branch
 * costs nothing.
 */
async function scenario(
  organizationId: string,
  label: string,
  options: { coldChain?: boolean } = {}
): Promise<Scenario> {
  const branchId = `${BRANCH_A}_${tag(label)}`;
  return inOrg(organizationId, async (db) => {
    await ensureBranch(db, organizationId, branchId);
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Insulin ${tag(label)}`,
        productFamily: 'PHARMACEUTICAL',
        coldChain: options.coldChain ?? false,
        presentations: { create: { organizationId, presentation: 'Vial, 10 per pack' } },
      },
      include: { presentations: true },
    });
    const packLevel = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `pack-${tag(label)}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const [location, fridge, supplier] = await Promise.all([
      db.pharmacyStockLocation.create({
        data: {
          organizationId,
          branchId,
          code: `MAIN-${tag(label)}`,
          name: 'Main store',
          kind: 'STORE',
        },
      }),
      db.pharmacyStockLocation.create({
        data: {
          organizationId,
          branchId,
          code: `FRIDGE-${tag(label)}`,
          name: 'Validated fridge',
          kind: 'FRIDGE',
          coldChain: true,
          minimumTemperatureC: 2,
          maximumTemperatureC: 8,
        },
      }),
      // PUR-01 puts a trigger behind purchase-order creation: an authorized
      // supplier still needs unexpired verified licence evidence on file.
      db.pharmacySupplier.create({
        data: {
          organizationId,
          name: `Distributor ${tag(label)}`,
          authorized: true,
          licences: {
            // The licence's foreign key is composite, so Prisma supplies
            // `organizationId` from the parent and rejects it in the payload.
            create: {
              licenceType: 'DRUG_SALE',
              licenceNumber: `LIC-${tag(label)}`,
              issuingAuthority: 'Provincial Drug Control',
              issuedAt: new Date('2026-01-01T00:00:00.000Z'),
              expiresAt: new Date('2027-12-31T00:00:00.000Z'),
              verifiedAt: new Date('2026-01-05T00:00:00.000Z'),
              verifiedByUserId: 'user_compliance',
            },
          },
        },
      }),
    ]);
    return {
      organizationId,
      branchId,
      medicineId: medicine.id,
      packLevelId: packLevel.id,
      locationId: location.id,
      fridgeId: fridge.id,
      supplierId: supplier.id,
    };
  });
}

function scopeOf(fixture: Scenario) {
  return { organizationId: fixture.organizationId, branchId: fixture.branchId, actorId: ACTOR };
}

async function stockLot(
  db: ScopedDb,
  fixture: Scenario,
  options: {
    units: number;
    label: string;
    expiresAt?: Date;
    locationId?: string;
    branchId?: string;
  }
) {
  const expiresAt = options.expiresAt ?? FAR;
  const batch = await db.pharmacyManufacturingBatch.create({
    data: {
      organizationId: fixture.organizationId,
      medicineId: fixture.medicineId,
      batchNumber: `B-${tag(options.label)}`,
      expiresAt,
      expiryPrecision: 'DAY',
    },
  });
  const { lot } = await deps.ledger.receiveLot(
    db,
    { ...scopeOf(fixture), branchId: options.branchId ?? fixture.branchId },
    {
      manufacturingBatchId: batch.id,
      packLevelId: fixture.packLevelId,
      stockLocationId: options.locationId ?? fixture.locationId,
      unitsPerPack: 10,
      supplierName: 'Distributor Ltd',
      supplierInvoiceRef: `INV-${tag(options.label)}`,
      unitCostMinor: 1200,
      printedMrpMinor: 2000,
      receivedExpiresAt: expiresAt,
      receivedExpiryPrecision: 'DAY',
      quantityUnits: options.units,
      idempotencyKey: `receipt-${tag(options.label)}`,
      receivedAt: new Date('2026-02-01T00:00:00.000Z'),
    }
  );
  return { lot, batch };
}

async function approveSafetyStock(db: ScopedDb, fixture: Scenario, safetyStockUnits: number) {
  return db.pharmacySafetyStock.create({
    data: {
      organizationId: fixture.organizationId,
      branchId: fixture.branchId,
      medicineId: fixture.medicineId,
      safetyStockUnits,
      coverageDays: 30,
      approvedByUserId: 'user_pharmacist_in_charge',
      approvedAt: new Date('2026-08-01T00:00:00.000Z'),
    },
  });
}

/**
 * A purchase order at a chosen status. APPROVED is the only kind PUR-07 counts
 * as inbound, and the status is set at creation because PUR-02 puts a lifecycle
 * trigger on the table that refuses to walk an order backwards.
 */
async function purchaseOrder(
  db: ScopedDb,
  fixture: Scenario,
  units: number,
  label: string,
  status: 'DRAFT' | 'APPROVED' = 'APPROVED'
) {
  const approved = status === 'APPROVED';
  const order = await db.pharmacyPurchaseOrder.create({
    data: {
      organizationId: fixture.organizationId,
      branchId: fixture.branchId,
      reference: `PO-${tag(label)}`,
      status,
      supplierId: fixture.supplierId,
      createdByUserId: 'user_buyer',
      approvedAt: approved ? NOW : null,
      approvedByUserId: approved ? 'user_manager' : null,
    },
  });
  await db.pharmacyPurchaseOrderLine.create({
    data: {
      organizationId: fixture.organizationId,
      purchaseOrderId: order.id,
      lineNumber: 1,
      medicineId: fixture.medicineId,
      packLevelId: fixture.packLevelId,
      orderedPacks: units / 10,
      canonicalUnitsPerPack: 10,
      orderedCanonicalUnits: units,
      listPricePerPackMinor: 12_000,
    },
  });
  return order;
}

function kindsOf(rows: ReadonlyArray<{ kind: string }>): string[] {
  return rows.map((row) => row.kind).sort();
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, ledger, signals, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./stock-ledger'),
    import('./stock-signals-operations'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scopedDb.withTenantDb, ledger, signals };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
  // C1 (createDraftAction) authorizes a real, active PHARMACY actor holding the
  // native pharmacy:procurement / pharmacy:inventory grants.
  await scopedDb.withPlatformDb(async (db) => {
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id`,
      [ORG_A, ORG_B]
    );
    await db.$executeRawUnsafe(
      `INSERT INTO organization_departments (id, "organizationId", key, name, active, "sortOrder", "createdAt", "updatedAt")
       VALUES ($1, $2, 'inventory', 'Inventory', true, 0, now(), now())`,
      `dept_${suffix}`,
      ORG_A
    );
    await db.$executeRawUnsafe(
      `INSERT INTO organization_roles (id, "organizationId", key, name, "isSystem", "createdAt", "updatedAt")
       VALUES ($1, $2, 'inventory-lead', 'Inventory lead', false, now(), now())`,
      `role_${suffix}`,
      ORG_A
    );
    await db.$executeRawUnsafe(
      `INSERT INTO organization_role_permissions (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
       SELECT 'perm_' || c || '_' || $1, $2, $3, c, 'ALLOW', now()
       FROM unnest(ARRAY['pharmacy:procurement', 'pharmacy:inventory']) AS c`,
      suffix,
      ORG_A,
      `role_${suffix}`
    );
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, "organizationId", "organizationRoleId", name, email, role, department, title, "startDate", status, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'Inventory lead', $4, 'EMPLOYEE', 'inventory', 'Inventory lead', now(), 'ACTIVE', now(), now())`,
      ACTOR,
      ORG_A,
      `role_${suffix}`,
      `${ACTOR}@example.test`
    );
  });
}, 120_000);

// ── The evaluator reads real ledger facts ──────────────────────────────────

describeIfDatabase('PUR-07 — facts come off the ledger, not off the caller', () => {
  it('raises LOW_STOCK from on-hand, reservations and the approved safety stock', async () => {
    const fixture = await scenario(ORG_A, 'low-stock');
    const result = await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixture, { units: 100, label: 'low-stock' });
      await approveSafetyStock(db, fixture, 120);
      return deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
    });
    expect(result.raised).toBe(1);
    const signal = await inOrg(ORG_A, (db) =>
      db.pharmacyStockSignal.findFirstOrThrow({ where: { id: result.signals[0]!.id } })
    );
    expect(signal).toMatchObject({
      kind: 'LOW_STOCK',
      status: 'OPEN',
      onHandUnits: 100,
      neededUnits: 120,
      inboundUnits: 0,
      confidence: 'EXACT',
      ownerUserId: 'role:purchasing',
      freshnessSeconds: DEFAULT_SIGNAL_POLICY.freshnessSeconds,
    });
    expect(signal.explanation).toContain('100 units are on hand');
  });

  it('counts an INV-09 supplier-claim reservation as unavailable', async () => {
    const fixture = await scenario(ORG_A, 'reserved');
    const signals = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, { units: 100, label: 'reserved' });
      await approveSafetyStock(db, fixture, 120);
      await db.pharmacySupplierClaim.create({
        data: {
          organizationId: fixture.organizationId,
          branchId: fixture.branchId,
          inventoryLotId: lot.id,
          reservedUnits: 100,
          returnBy: new Date(NOW.getTime() + 10 * DAY),
          createdById: ACTOR,
        },
      });
      await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      return db.pharmacyStockSignal.findMany({ where: { branchId: fixture.branchId } });
    });
    // Nothing is saleable, so it is a stockout rather than a shortfall — and the
    // closing return window on that same claim raises its own signal.
    const stockout = signals.find((signal) => signal.kind === 'STOCKOUT');
    expect(stockout).toBeDefined();
    expect(stockout!.onHandUnits).toBe(0);
    expect(kindsOf(signals)).toContain('RETURN_WINDOW');
  });

  it('drops confidence to PARTIAL while an unapproved count disputes the on-hand number', async () => {
    const fixture = await scenario(ORG_A, 'partial-confidence');
    const signal = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, { units: 100, label: 'partial-confidence' });
      await approveSafetyStock(db, fixture, 120);
      // A count snapshots the organization's threshold; the inserted value is ignored.
      await db.organization.update({
        where: { id: fixture.organizationId },
        data: { pharmacyCountVarianceThresholdUnits: 5 },
      });
      const count = await db.pharmacyInventoryCount.create({
        data: {
          organizationId: fixture.organizationId,
          branchId: fixture.branchId,
          varianceThreshold: 5,
          createdById: ACTOR,
        },
      });
      await db.pharmacyInventoryCountLine.create({
        data: {
          organizationId: fixture.organizationId,
          countId: count.id,
          branchId: fixture.branchId,
          inventoryLotId: lot.id,
          stockLocationId: fixture.locationId,
          expectedUnits: 100,
          expectedSealedPacks: 10,
          expectedLooseUnits: 0,
        },
      });
      await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      return db.pharmacyStockSignal.findFirstOrThrow({
        where: { branchId: fixture.branchId, kind: 'LOW_STOCK' },
      });
    });
    expect(signal.confidence).toBe('PARTIAL');
  });

  it('raises COLD_CHAIN for a cold-chain medicine outside a validated zone, and not inside one', async () => {
    const fixture = await scenario(ORG_A, 'cold-chain', { coldChain: true });
    const breach = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        units: 20,
        label: 'cold-breach',
        locationId: fixture.fridgeId,
      });
      await deps.ledger.transferStock(db, scopeOf(fixture), {
        inventoryLotId: lot.id,
        fromStockLocationId: fixture.fridgeId,
        toStockLocationId: fixture.locationId,
        units: 20,
        at: NOW,
        idempotencyKeyPrefix: tag('cold-breach-transfer'),
      });
      await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      return db.pharmacyStockSignal.findMany({ where: { branchId: fixture.branchId } });
    });
    expect(kindsOf(breach)).toEqual(['COLD_CHAIN']);

    const compliant = await scenario(ORG_A, 'cold-ok', { coldChain: true });
    const clean = await inOrg(ORG_A, async (db) => {
      await stockLot(db, compliant, {
        units: 20,
        label: 'cold-ok',
        locationId: compliant.fridgeId,
      });
      await deps.signals.refreshStockSignals(db, scopeOf(compliant), NOW);
      return db.pharmacyStockSignal.findMany({
        where: { branchId: compliant.branchId, medicineId: compliant.medicineId },
      });
    });
    expect(kindsOf(clean)).toEqual([]);
  });
});

// ── Dedup and closing ──────────────────────────────────────────────────────

describeIfDatabase('PUR-07 — deduplication and closing', () => {
  it('refreshes the same signal instead of raising a duplicate', async () => {
    const fixture = await scenario(ORG_A, 'dedup');
    const outcome = await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixture, { units: 100, label: 'dedup' });
      await approveSafetyStock(db, fixture, 120);
      const first = await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      const second = await deps.signals.refreshStockSignals(
        db,
        scopeOf(fixture),
        new Date(NOW.getTime() + 60_000)
      );
      const rows = await db.pharmacyStockSignal.findMany({ where: { branchId: fixture.branchId } });
      return { first, second, rows };
    });
    expect(outcome.first).toMatchObject({ raised: 1, refreshed: 0 });
    expect(outcome.second).toMatchObject({ raised: 0, refreshed: 1, closed: 0 });
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0]!.computedAt).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it('refuses a second live signal on the same dedup key at the database level', async () => {
    const fixture = await scenario(ORG_A, 'dedup-index');
    const existing = await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixture, { units: 100, label: 'dedup-index' });
      await approveSafetyStock(db, fixture, 120);
      await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      return db.pharmacyStockSignal.findFirstOrThrow({ where: { branchId: fixture.branchId } });
    });
    const rejected = await inOrg(ORG_A, (db) =>
      db.pharmacyStockSignal
        .create({
          data: {
            organizationId: fixture.organizationId,
            branchId: fixture.branchId,
            kind: existing.kind,
            dedupKey: existing.dedupKey,
            medicineId: existing.medicineId,
            cause: existing.cause,
            ownerUserId: existing.ownerUserId,
            dueAt: existing.dueAt,
            explanation: 'A duplicate of a live signal',
            dataWindowStart: existing.dataWindowStart,
            dataWindowEnd: existing.dataWindowEnd,
            sourceObservedAt: existing.sourceObservedAt,
            freshnessSeconds: existing.freshnessSeconds,
            confidence: existing.confidence,
            neededUnits: existing.neededUnits,
            onHandUnits: existing.onHandUnits,
            inboundUnits: existing.inboundUnits,
            computedAt: existing.computedAt,
          },
        })
        .then(() => 'ACCEPTED — the duplicate was expected to fail')
        .catch((error: Error) => error.message)
    );
    expect(rejected).not.toContain('ACCEPTED');
  });

  it('closes the shortfall once on-hand plus APPROVED inbound covers the need', async () => {
    const fixture = await scenario(ORG_A, 'inbound-covers');
    const outcome = await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixture, { units: 40, label: 'inbound-covers' });
      await approveSafetyStock(db, fixture, 120);
      const before = await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      const shortfall = await db.pharmacyStockSignal.findFirstOrThrow({
        where: { branchId: fixture.branchId, kind: 'LOW_STOCK' },
      });

      await purchaseOrder(db, fixture, 80, 'inbound-covers');
      const after = await deps.signals.refreshStockSignals(
        db,
        scopeOf(fixture),
        new Date(NOW.getTime() + 60_000)
      );
      const closed = await db.pharmacyStockSignal.findFirstOrThrow({
        where: { id: shortfall.id },
      });
      const coverage = await db.pharmacyStockSignal.findFirst({
        where: { branchId: fixture.branchId, kind: 'INBOUND_COVERAGE' },
      });
      return { before, after, closed, coverage };
    });

    expect(outcome.before.raised).toBe(1);
    expect(outcome.closed.status).toBe('CLOSED');
    expect(outcome.closed.closedAt).toEqual(new Date(NOW.getTime() + 60_000));
    expect(outcome.coverage).toMatchObject({
      status: 'OPEN',
      onHandUnits: 40,
      inboundUnits: 80,
      neededUnits: 120,
    });
    expect(outcome.after.closed).toBe(1);
  });

  it('ignores a DRAFT purchase order as inbound, because it is not approved', async () => {
    const fixture = await scenario(ORG_A, 'draft-po');
    const kinds = await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixture, { units: 40, label: 'draft-po' });
      await approveSafetyStock(db, fixture, 120);
      await purchaseOrder(db, fixture, 80, 'draft-po', 'DRAFT');
      await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      return db.pharmacyStockSignal.findMany({ where: { branchId: fixture.branchId } });
    });
    expect(kindsOf(kinds)).toEqual(['LOW_STOCK']);
  });

  it('leaves a dismissed signal dismissed and does not re-raise it', async () => {
    const fixture = await scenario(ORG_A, 'dismissed');
    const rows = await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixture, { units: 40, label: 'dismissed' });
      await approveSafetyStock(db, fixture, 120);
      const first = await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      await deps.signals.dismissSignal(db, scopeOf(fixture), {
        signalId: first.signals[0]!.id,
        reason: 'Line is being discontinued this quarter',
        at: NOW,
      });
      await deps.signals.refreshStockSignals(
        db,
        scopeOf(fixture),
        new Date(NOW.getTime() + 60_000)
      );
      return db.pharmacyStockSignal.findMany({
        where: { branchId: fixture.branchId },
        orderBy: { createdAt: 'asc' },
      });
    });
    // The dismissal stays on the record; the same condition may legitimately be
    // raised again as a NEW signal, which is why the dedup index is partial.
    expect(rows[0]!.status).toBe('DISMISSED');
    expect(rows[0]!.dismissReason).toBe('Line is being discontinued this quarter');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.status).toBe('OPEN');
  });
});

// ── Freshness ──────────────────────────────────────────────────────────────

describeIfDatabase('PUR-07 — stale source data marks the signal unusable', () => {
  it('marks a signal STALE once its own freshness policy has elapsed, and recovers it on recompute', async () => {
    const fixture = await scenario(ORG_A, 'stale');
    const outcome = await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixture, { units: 40, label: 'stale' });
      await approveSafetyStock(db, fixture, 120);
      const first = await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      const signalId = first.signals[0]!.id;

      // One second inside the 6-hour policy: still usable.
      const notYet = await deps.signals.markStaleSignals(
        db,
        scopeOf(fixture),
        new Date(NOW.getTime() + DEFAULT_SIGNAL_POLICY.freshnessSeconds * 1000)
      );
      const fresh = await db.pharmacyStockSignal.findFirstOrThrow({ where: { id: signalId } });

      const marked = await deps.signals.markStaleSignals(
        db,
        scopeOf(fixture),
        new Date(NOW.getTime() + DEFAULT_SIGNAL_POLICY.freshnessSeconds * 1000 + 1)
      );
      const stale = await db.pharmacyStockSignal.findFirstOrThrow({ where: { id: signalId } });

      await deps.signals.refreshStockSignals(
        db,
        scopeOf(fixture),
        new Date(NOW.getTime() + 7 * 3_600_000)
      );
      const recovered = await db.pharmacyStockSignal.findFirstOrThrow({ where: { id: signalId } });
      return { notYet, fresh, marked, stale, recovered };
    });

    expect(outcome.notYet).toBe(0);
    expect(outcome.fresh.status).toBe('OPEN');
    expect(outcome.marked).toBe(1);
    expect(outcome.stale.status).toBe('STALE');
    expect(outcome.stale.markedStaleAt).not.toBeNull();
    expect(outcome.recovered.status).toBe('OPEN');
    expect(outcome.recovered.markedStaleAt).toBeNull();
  });
});

// ── §8A invariant 29 ───────────────────────────────────────────────────────

describeIfDatabase(
  'PUR-07 — §8A invariant 29: a draft action creates a draft and nothing else',
  () => {
    // createDraftAction re-checks freshness and eligibility on the wall clock.
    beforeEach(() => vi.setSystemTime(NOW));
    afterEach(() => vi.useRealTimers());
    /** Everything a signal must never be able to create. */
    async function ledgerCensus(db: ScopedDb, organizationId: string) {
      const [movements, purchaseOrders, claims, submittedReturns, liveTransfers] =
        await Promise.all([
          db.pharmacyStockMovement.count({ where: { organizationId } }),
          db.pharmacyPurchaseOrder.count({ where: { organizationId } }),
          db.pharmacySupplierClaim.count({ where: { organizationId } }),
          db.pharmacyPurchaseReturn.count({ where: { organizationId, status: { not: 'DRAFT' } } }),
          db.pharmacyInterbranchTransfer.count({
            where: { organizationId, status: { not: 'DRAFT' } },
          }),
        ]);
      return { movements, purchaseOrders, claims, submittedReturns, liveTransfers };
    }

    it('creates a DRAFT requisition and moves no stock and raises no order', async () => {
      const fixture = await scenario(ORG_A, 'draft-requisition');
      const outcome = await inOrg(ORG_A, async (db) => {
        await stockLot(db, fixture, { units: 40, label: 'draft-requisition' });
        await approveSafetyStock(db, fixture, 120);
        const refreshed = await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
        const before = await ledgerCensus(db, fixture.organizationId);

        const action = await deps.signals.createDraftAction(db, scopeOf(fixture), {
          kind: 'DRAFT_REQUISITION',
          signalId: refreshed.signals[0]!.id,
          reference: `REQ-${tag('draft-requisition')}`,
          medicineId: fixture.medicineId,
          packLevelId: fixture.packLevelId,
          canonicalUnitsPerPack: 10,
          quantityPacks: 8,
        });
        const after = await ledgerCensus(db, fixture.organizationId);
        const requisition = await db.pharmacyRequisition.findFirstOrThrow({
          where: { id: action.requisitionId! },
          include: { lines: true },
        });
        return { action, before, after, requisition };
      });

      expect(outcome.after).toEqual(outcome.before);
      expect(outcome.requisition.status).toBe('DRAFT');
      expect(outcome.requisition.lines[0]).toMatchObject({
        quantityPacks: 8,
        canonicalUnits: 80,
        medicineId: fixture.medicineId,
      });
      expect(outcome.action.kind).toBe('DRAFT_REQUISITION');
    });

    it('creates a DRAFT transfer that cannot be approved and therefore cannot dispatch stock', async () => {
      const fixture = await scenario(ORG_A, 'draft-transfer');
      const donorBranchId = `${BRANCH_B}_${tag('draft-transfer')}`;
      const outcome = await inOrg(ORG_A, async (db) => {
        await stockLot(db, fixture, { units: 40, label: 'draft-transfer' });
        await approveSafetyStock(db, fixture, 120);
        // The stock a pull draws on has to exist in the branch it is pulled FROM:
        // the transfer-line foreign key resolves the source lot through
        // (organization, source branch), so a draft cannot name a lot the donor
        // branch does not hold.
        await ensureBranch(db, fixture.organizationId, donorBranchId);
        const donorLocation = await db.pharmacyStockLocation.create({
          data: {
            organizationId: fixture.organizationId,
            branchId: donorBranchId,
            code: `DONOR-${tag('draft-transfer')}`,
            name: 'Donor branch store',
            kind: 'STORE',
          },
        });
        const { lot: donorLot } = await stockLot(db, fixture, {
          units: 60,
          label: 'draft-transfer-donor',
          branchId: donorBranchId,
          locationId: donorLocation.id,
        });
        const refreshed = await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
        const before = await ledgerCensus(db, fixture.organizationId);
        const action = await deps.signals.createDraftAction(db, scopeOf(fixture), {
          kind: 'DRAFT_TRANSFER',
          idempotencyKey: tag('draft-transfer-intent'),
          signalId: refreshed.signals[0]!.id,
          fromBranchId: donorBranchId,
          lines: [
            {
              sourceLotId: donorLot.id,
              sourceStockLocationId: donorLocation.id,
              destinationStockLocationId: fixture.locationId,
              quantityUnits: 40,
            },
          ],
        });
        const after = await ledgerCensus(db, fixture.organizationId);
        const transfer = await db.pharmacyInterbranchTransfer.findFirstOrThrow({
          where: { id: action.transferId! },
        });
        return { before, after, transfer };
      });

      expect(outcome.after).toEqual(outcome.before);
      expect(outcome.transfer.status).toBe('DRAFT');

      // The DRAFT status is not decorative: the approval path only accepts
      // ALLOCATED, so there is no route from this document to a movement without
      // a separate, deliberate human step.
      const operations = await import('./inventory-operations');
      await expect(
        inOrg(ORG_A, (db) =>
          operations.approveTransfer(
            db,
            { ...scopeOf(fixture), branchId: donorBranchId, actorId: 'user_other' },
            outcome.transfer.id
          )
        )
      ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    });

    it('creates a DRAFT expiry claim that reserves nothing', async () => {
      const fixture = await scenario(ORG_A, 'draft-claim');
      const receiving = await import('./goods-receipt');
      const outcome = await inOrg(ORG_A, async (db) => {
        // C1 proves claim supplier ownership through a POSTED native receipt line.
        const receivedAt = new Date('2026-02-01T00:00:00.000Z');
        const receipt = await db.pharmacyGoodsReceipt.create({
          data: {
            organizationId: fixture.organizationId,
            branchId: fixture.branchId,
            reference: `GRN-${tag('draft-claim')}`,
            supplierId: fixture.supplierId,
            supplierInvoiceRef: `INV-${tag('draft-claim')}`,
            supplierInvoiceDate: receivedAt,
            warrantyEvidenceRef: `WARRANTY-${tag('draft-claim')}`,
            receivedByUserId: ACTOR,
            receivedAt,
            directPurchase: true,
            bypassReason: 'Emergency cash-and-carry purchase.',
            bypassApprovedByUserId: 'user_manager',
            bypassApprovedAt: receivedAt,
            lines: {
              create: {
                lineNumber: 1,
                medicineId: fixture.medicineId,
                packLevelId: fixture.packLevelId,
                batchNumber: `B-${tag('draft-claim')}`,
                printedExpiry: new Date(NOW.getTime() + 20 * DAY),
                expiryPrecision: 'DAY',
                printedMrpMinor: 2000,
                canonicalUnitsPerPack: 10,
                receivedPacks: 4,
                bonusPacks: 0,
                receivedCanonicalUnits: 40,
                bonusCanonicalUnits: 0,
                acceptedCanonicalUnits: 40,
                rejectedCanonicalUnits: 0,
                invoicedPricePerPackMinor: 12_000,
                unitCostMinor: 1200,
                stockLocationId: fixture.locationId,
              },
            },
          },
        });
        const posted = await receiving.postGoodsReceipt(db, scopeOf(fixture), {
          goodsReceiptId: receipt.id,
          at: receivedAt,
        });
        const lot = { id: posted.lines[0]!.inventoryLotId };
        const refreshed = await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
        const nearExpiry = refreshed.signals.find((signal) => signal.kind === 'NEAR_EXPIRY')!;
        const before = await ledgerCensus(db, fixture.organizationId);
        const action = await deps.signals.createDraftAction(db, scopeOf(fixture), {
          kind: 'DRAFT_CLAIM',
          signalId: nearExpiry.id,
          reference: `RET-${tag('draft-claim')}`,
          supplierId: fixture.supplierId,
          lines: [
            {
              inventoryLotId: lot.id,
              stockLocationId: fixture.locationId,
              quantityUnits: 40,
              reason: 'Short-dated stock inside the supplier window',
              returnWindowEndsAt: new Date(NOW.getTime() + 10 * DAY),
              expectedCreditMinor: 48_000,
            },
          ],
        });
        const after = await ledgerCensus(db, fixture.organizationId);
        const purchaseReturn = await db.pharmacyPurchaseReturn.findFirstOrThrow({
          where: { id: action.purchaseReturnId! },
          include: { lines: true },
        });
        return { before, after, purchaseReturn, lotId: lot.id };
      });

      expect(outcome.after).toEqual(outcome.before);
      expect(outcome.purchaseReturn.status).toBe('DRAFT');
      // No reservation: the claimed stock is still sellable until a human submits.
      expect(outcome.purchaseReturn.lines[0]!.supplierClaimId).toBeNull();
      const sold = await inOrg(ORG_A, (db) =>
        deps.ledger.allocateForSale(db, scopeOf(fixture), {
          medicineId: fixture.medicineId,
          requiredUnits: 40,
          at: NOW,
          idempotencyKeyPrefix: tag('draft-claim-sale'),
        })
      );
      expect(sold.allocations.reduce((n, a) => n + a.units, 0)).toBe(40);
    });

    it('records the draft action and its explanation as append-only evidence', async () => {
      const fixture = await scenario(ORG_A, 'action-audit');
      const evidence = await inOrg(ORG_A, async (db) => {
        await stockLot(db, fixture, { units: 40, label: 'action-audit' });
        await approveSafetyStock(db, fixture, 120);
        const refreshed = await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
        const action = await deps.signals.createDraftAction(db, scopeOf(fixture), {
          kind: 'DRAFT_REQUISITION',
          signalId: refreshed.signals[0]!.id,
          reference: `REQ-${tag('action-audit')}`,
          medicineId: fixture.medicineId,
          packLevelId: fixture.packLevelId,
          canonicalUnitsPerPack: 10,
          quantityPacks: 8,
        });
        const events = await db.pharmacyStockSignalEvent.findMany({
          where: { signalId: refreshed.signals[0]!.id },
          orderBy: { createdAt: 'asc' },
        });
        return { actionId: action.id, events };
      });
      expect(evidence.events.map((event) => event.kind)).toEqual(['RAISED', 'DRAFT_ACTION']);

      const rejected = await inOrg(ORG_A, (db) =>
        db.pharmacyStockSignalAction
          .update({ where: { id: evidence.actionId }, data: { kind: 'DRAFT_CLAIM' } })
          .then(() => 'ACCEPTED — the rewrite was expected to fail')
          .catch((error: Error) => error.message)
      );
      expect(rejected).toContain('append-only');
    });

    it('refuses a draft action on a dismissed signal', async () => {
      const fixture = await scenario(ORG_A, 'action-dismissed');
      const signalId = await inOrg(ORG_A, async (db) => {
        await stockLot(db, fixture, { units: 40, label: 'action-dismissed' });
        await approveSafetyStock(db, fixture, 120);
        const refreshed = await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
        await deps.signals.dismissSignal(db, scopeOf(fixture), {
          signalId: refreshed.signals[0]!.id,
          reason: 'Superseded by a central purchase',
          at: NOW,
        });
        return refreshed.signals[0]!.id;
      });
      await expect(
        inOrg(ORG_A, (db) =>
          deps.signals.createDraftAction(db, scopeOf(fixture), {
            kind: 'DRAFT_REQUISITION',
            signalId,
            reference: `REQ-${tag('action-dismissed')}`,
            medicineId: fixture.medicineId,
            packLevelId: fixture.packLevelId,
            canonicalUnitsPerPack: 10,
            quantityPacks: 8,
          })
        )
      ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    });
  }
);

// ── Human decisions, dashboards and the digest ─────────────────────────────

describeIfDatabase('PUR-07 — decisions, role dashboard and owner digest', () => {
  it('records acknowledgement, snooze and dismissal with their reasons', async () => {
    const fixture = await scenario(ORG_A, 'decisions');
    const outcome = await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixture, { units: 40, label: 'decisions' });
      await approveSafetyStock(db, fixture, 120);
      const refreshed = await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      const signalId = refreshed.signals[0]!.id;
      const acknowledged = await deps.signals.acknowledgeSignal(db, scopeOf(fixture), {
        signalId,
        at: NOW,
      });
      const snoozed = await deps.signals.snoozeSignal(db, scopeOf(fixture), {
        signalId,
        until: new Date(NOW.getTime() + 2 * DAY),
        reason: 'Supplier confirmed a delivery on Thursday',
        at: NOW,
      });
      const events = await db.pharmacyStockSignalEvent.findMany({
        where: { signalId },
        orderBy: { createdAt: 'asc' },
      });
      return { acknowledged, snoozed, events };
    });
    expect(outcome.acknowledged).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledgedByUserId: ACTOR,
    });
    expect(outcome.snoozed).toMatchObject({
      status: 'SNOOZED',
      snoozeReason: 'Supplier confirmed a delivery on Thursday',
    });
    expect(outcome.events.map((event) => event.kind)).toEqual([
      'RAISED',
      'ACKNOWLEDGED',
      'SNOOZED',
    ]);
  });

  it('refuses a snooze or a dismissal with no reason (§8A invariant 29)', async () => {
    const fixture = await scenario(ORG_A, 'reasonless');
    const signalId = await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixture, { units: 40, label: 'reasonless' });
      await approveSafetyStock(db, fixture, 120);
      const refreshed = await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      return refreshed.signals[0]!.id;
    });
    for (const call of [
      (db: ScopedDb) =>
        deps.signals.snoozeSignal(db, scopeOf(fixture), {
          signalId,
          until: new Date(NOW.getTime() + DAY),
          reason: '   ',
          at: NOW,
        }),
      (db: ScopedDb) =>
        deps.signals.dismissSignal(db, scopeOf(fixture), { signalId, reason: '', at: NOW }),
    ]) {
      await expect(inOrg(ORG_A, call)).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    }
  });

  it('groups the role dashboard by kind and owner, and counts what is overdue', async () => {
    const fixture = await scenario(ORG_A, 'dashboard');
    const rows = await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixture, {
        units: 40,
        label: 'dashboard',
        expiresAt: new Date(NOW.getTime() + 20 * DAY),
      });
      await approveSafetyStock(db, fixture, 120);
      await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      // Eight days later every SLA above has lapsed — NEAR_EXPIRY carries the
      // longest at 168 hours, and `overdue` is strictly past the due instant.
      return deps.signals.roleDashboard(db, fixture, new Date(NOW.getTime() + 8 * DAY));
    });
    const purchasing = rows.find((row) => row.kind === 'LOW_STOCK')!;
    const inventory = rows.find((row) => row.kind === 'NEAR_EXPIRY')!;
    expect(purchasing).toMatchObject({ ownerUserId: 'role:purchasing', open: 1, overdue: 1 });
    expect(inventory).toMatchObject({ ownerUserId: 'role:inventory', open: 1, overdue: 1 });
  });

  it('builds an owner digest with disjoint overdue, due-soon, stale and resuming buckets', async () => {
    const fixture = await scenario(ORG_A, 'digest');
    const digest = await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixture, { units: 40, label: 'digest' });
      await approveSafetyStock(db, fixture, 120);
      await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      // LOW_STOCK carries a 48-hour SLA, so at +72h it is overdue.
      return deps.signals.ownerDigest(
        db,
        fixture,
        'role:purchasing',
        new Date(NOW.getTime() + 3 * DAY)
      );
    });
    expect(digest).toMatchObject({
      ownerUserId: 'role:purchasing',
      branchId: fixture.branchId,
      counts: { overdue: 1, dueSoon: 0, stale: 0, snoozed: 0 },
    });
    expect(digest.overdue[0]!.explanation).toContain('40 units are on hand');
    expect(digest.stale).toEqual([]);
  });

  it('lists a stale signal separately from an overdue one', async () => {
    const fixture = await scenario(ORG_A, 'digest-stale');
    const digest = await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixture, { units: 40, label: 'digest-stale' });
      await approveSafetyStock(db, fixture, 120);
      await deps.signals.refreshStockSignals(db, scopeOf(fixture), NOW);
      const at = new Date(NOW.getTime() + 3 * DAY);
      await deps.signals.markStaleSignals(db, scopeOf(fixture), at);
      return deps.signals.ownerDigest(db, fixture, 'role:purchasing', at);
    });
    // Stale needs recomputation, not action, so it must not be mixed into
    // `overdue` where an owner would be asked to act on numbers nobody vouches
    // for any more.
    expect(digest.counts).toMatchObject({ overdue: 0, stale: 1 });
    expect(digest.stale[0]!.status).toBe('STALE');
  });
});

// ── Tenant isolation, forced ───────────────────────────────────────────────

describeIfDatabase('PUR-07 — tenant isolation', () => {
  it('never shows one tenant another tenant’s signals', async () => {
    const fixtureA = await scenario(ORG_A, 'isolation-a');
    await scenario(ORG_B, 'isolation-b');
    await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixtureA, { units: 40, label: 'isolation' });
      await approveSafetyStock(db, fixtureA, 120);
      await deps.signals.refreshStockSignals(db, scopeOf(fixtureA), NOW);
    });
    const seenByOwner = await inOrg(ORG_A, (db) =>
      db.pharmacyStockSignal.count({ where: { medicineId: fixtureA.medicineId } })
    );
    const seenByStranger = await inOrg(ORG_B, (db) =>
      db.pharmacyStockSignal.count({ where: { medicineId: fixtureA.medicineId } })
    );
    expect(seenByOwner).toBeGreaterThan(0);
    expect(seenByStranger).toBe(0);
  });
});
