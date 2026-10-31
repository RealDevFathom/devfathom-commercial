/**
 * PLAT-04 — cross-branch and cross-tenant id substitution, against migrated
 * PostgreSQL with FORCED row-level security.
 *
 * The two boundaries are not the same and fail in different places, which is
 * the point of testing both on the same read:
 *
 *  - *cross-tenant* is the database's job. RLS filters the row out, and the
 *    composite `(organizationId, branchId)` foreign key added by PLAT-04 stops
 *    another tenant's branch id from ever being written.
 *  - *cross-branch inside one tenant* is the query's job. Two branches of one
 *    organization are the same tenant, so no policy separates them; the read
 *    has to carry the branch predicate itself. A read that forgot it would
 *    return the sibling's row and this suite would fail.
 *
 * One ledger read (`onHand`) and one purchasing read (`getBranchPurchaseOrder`)
 * are exercised, per PLAT-04. Skipped (never silently passed) when the database
 * URL is absent.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1174_scope_a_${suffix}`;
const ORG_B = `org_wha1174_scope_b_${suffix}`;
/** Two branches of the SAME tenant: RLS cannot tell them apart. */
const BRANCH_ONE = `branch_one_${suffix}`;
const BRANCH_TWO = `branch_two_${suffix}`;
/** A branch of a DIFFERENT tenant. */
const BRANCH_FOREIGN = `branch_foreign_${suffix}`;
const ACTOR = 'user_pharmacist';

const RECEIVED_AT = new Date('2026-02-01T00:00:00.000Z');
const EXPIRES_AT = new Date('2027-10-01T00:00:00.000Z');
const NOW = new Date('2026-09-02T09:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  ledger: typeof import('./stock-ledger');
  branchScope: typeof import('./branch-scope');
  substituteFinder: typeof import('./substitute-finder');
};
let deps: Deps;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

type BranchFixture = {
  organizationId: string;
  branchId: string;
  medicineId: string;
  presentationId: string;
  locationId: string;
  purchaseOrderId: string;
};

let one: BranchFixture;
let two: BranchFixture;
let foreign: BranchFixture;

/**
 * One branch holding stock of its own medicine and one purchase order of its
 * own. Created as the tenant, so RLS and every CHECK apply to the fixture too.
 */
async function branchFixture(
  organizationId: string,
  branchId: string,
  label: string
): Promise<BranchFixture> {
  return inOrg(organizationId, async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId,
        code: `CODE-${label}`,
        name: `Branch ${label}`,
        addressLine: '1 Mall Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });

    const ingredient = await db.ingredient.upsert({
      where: { organizationId_name: { organizationId, name: `Paracetamol ${suffix}` } },
      create: { organizationId, name: `Paracetamol ${suffix}` },
      update: {},
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Paracetamol 500mg ${label}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        strengths: {
          create: { organizationId, ingredientId: ingredient.id, value: 500, unit: 'mg' },
        },
        presentations: {
          create: {
            organizationId,
            presentation: 'Tablet, 10 per strip',
            dosageForm: 'Tablet',
            route: 'Oral',
          },
        },
      },
      include: { presentations: true },
    });
    const packLevel = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${label}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: { organizationId, branchId, code: `MAIN-${label}`, name: 'Main store', kind: 'STORE' },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId,
        medicineId: medicine.id,
        batchNumber: `B-${label}`,
        expiresAt: EXPIRES_AT,
        expiryPrecision: 'DAY',
      },
    });
    await deps.ledger.receiveLot(
      db,
      { organizationId, branchId, actorId: ACTOR },
      {
        manufacturingBatchId: batch.id,
        packLevelId: packLevel.id,
        stockLocationId: location.id,
        unitsPerPack: 10,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: `INV-${label}`,
        unitCostMinor: 1200,
        printedMrpMinor: 2000,
        receivedExpiresAt: EXPIRES_AT,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 40,
        idempotencyKey: `receipt-${label}`,
        receivedAt: RECEIVED_AT,
      }
    );

    const supplier = await db.pharmacySupplier.create({
      data: { organizationId, name: `Distributor ${label}`, authorized: true, active: true },
    });
    // PUR-01: an order may only name a supplier with a verified, unexpired
    // licence on file. Enforced by trigger, so the fixture has to satisfy it.
    await db.pharmacySupplierLicence.create({
      data: {
        organizationId,
        supplierId: supplier.id,
        licenceType: 'DRUG_SALE',
        licenceNumber: `LIC-${label}`,
        issuingAuthority: 'Punjab Drug Control',
        issuedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        verifiedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    });
    const purchaseOrder = await db.pharmacyPurchaseOrder.create({
      data: {
        organizationId,
        branchId,
        reference: `PO-${label}`,
        supplierId: supplier.id,
        createdByUserId: ACTOR,
      },
    });

    return {
      organizationId,
      branchId,
      medicineId: medicine.id,
      presentationId: medicine.presentations[0]!.id,
      locationId: location.id,
      purchaseOrderId: purchaseOrder.id,
    };
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  deps = {
    withTenantDb: (await import('@/lib/tenancy/scoped-db')).withTenantDb,
    ledger: await import('./stock-ledger'),
    branchScope: await import('./branch-scope'),
    substituteFinder: await import('./substitute-finder'),
  };
  one = await branchFixture(ORG_A, BRANCH_ONE, `one-${suffix}`);
  two = await branchFixture(ORG_A, BRANCH_TWO, `two-${suffix}`);
  foreign = await branchFixture(ORG_B, BRANCH_FOREIGN, `foreign-${suffix}`);
});

describeIfDatabase('PLAT-04 ledger read — cross-branch id substitution', () => {
  it("returns the branch's own stock when read in its own scope", async () => {
    const rows = await inOrg(ORG_A, (db) =>
      deps.ledger.onHand(db, { organizationId: ORG_A, branchId: BRANCH_ONE }, one.medicineId, NOW)
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.onHandUnits).toBe(40);
  });

  it("returns nothing for a sibling branch's medicine id, inside one tenant", async () => {
    // Branch two really does hold 40 units of `two.medicineId`. Read in branch
    // one's scope, that stock must be invisible — same tenant, so RLS is not
    // what separates them.
    const rows = await inOrg(ORG_A, (db) =>
      deps.ledger.onHand(db, { organizationId: ORG_A, branchId: BRANCH_ONE }, two.medicineId, NOW)
    );
    expect(rows).toEqual([]);
  });

  it("returns nothing when the branch id itself is substituted for a sibling's", async () => {
    // The mirror of the case above: the caller keeps their own medicine and
    // swaps the branch. Branch two holds no stock of branch one's medicine.
    const rows = await inOrg(ORG_A, (db) =>
      deps.ledger.onHand(db, { organizationId: ORG_A, branchId: BRANCH_TWO }, one.medicineId, NOW)
    );
    expect(rows).toEqual([]);
  });

  it("returns nothing for another tenant's branch id", async () => {
    const rows = await inOrg(ORG_A, (db) =>
      deps.ledger.onHand(
        db,
        { organizationId: ORG_A, branchId: BRANCH_FOREIGN },
        foreign.medicineId,
        NOW
      )
    );
    expect(rows).toEqual([]);
  });
});

describeIfDatabase('margin optimizer cost isolation under restricted PostgreSQL', () => {
  it('returns only costs from the requested tenant and branch', async () => {
    const rows = await inOrg(ORG_A, (db) =>
      deps.substituteFinder.findMarginOptimizedBrandProposals(
        db,
        { organizationId: ORG_A, branchId: BRANCH_ONE },
        {
          medicineId: one.medicineId,
          presentationId: one.presentationId,
          quantityCanonicalUnits: 10,
          at: NOW,
        }
      )
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ medicineId: one.medicineId, costMinor: 12_000 });
    expect(rows.map((row) => row.medicineId)).not.toContain(two.medicineId);
    expect(rows.map((row) => row.medicineId)).not.toContain(foreign.medicineId);
  });

  it.each([
    { label: 'supplier', supplierUnits: 35, restockUnits: 0 },
    { label: 'restock', supplierUnits: 0, restockUnits: 35 },
    { label: 'combined', supplierUnits: 15, restockUnits: 20 },
  ])(
    'excludes $label reservations from available units',
    async ({ label, supplierUnits, restockUnits }) => {
      const fixture = await branchFixture(
        ORG_A,
        `branch_margin_${label}_${suffix}`,
        `margin-${label}-${suffix}`
      );
      await inOrg(ORG_A, async (db) => {
        await db.$queryRaw`SELECT set_config('app.current_branch_id', ${fixture.branchId}, true)`;
        const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
          where: { organizationId: ORG_A, branchId: fixture.branchId },
        });
        if (supplierUnits > 0) {
          await db.pharmacySupplierClaim.create({
            data: {
              organizationId: ORG_A,
              branchId: fixture.branchId,
              inventoryLotId: lot.id,
              reservedUnits: supplierUnits,
              returnBy: EXPIRES_AT,
              createdById: ACTOR,
            },
          });
        }
        if (restockUnits > 0) {
          const demand = await db.unfulfilledDemandEvent.create({
            data: {
              organizationId: ORG_A,
              branchId: fixture.branchId,
              requestedMedicineId: fixture.medicineId,
              saleUnit: 'UNIT',
              quantity: restockUnits,
              reason: 'STOCKOUT',
              inventoryRuleSnapshot: {},
              capturedByUserId: ACTOR,
            },
          });
          const interest = await db.pharmacyRestockInterest.create({
            data: {
              organizationId: ORG_A,
              branchId: fixture.branchId,
              demandEventId: demand.id,
              reserveOnArrival: true,
              quantityUnits: restockUnits,
              createdByUserId: ACTOR,
            },
          });
          await db.pharmacyRestockReservation.create({
            data: {
              organizationId: ORG_A,
              branchId: fixture.branchId,
              interestId: interest.id,
              inventoryLotId: lot.id,
              stockLocationId: fixture.locationId,
              reservedUnits: restockUnits,
            },
          });
        }
      });
      // A fresh tenant-only connection has no branch GUC. The optimizer must
      // bind it itself or branch-RLS would silently hide the restock hold.
      const compare = (db: ScopedDb, quantityCanonicalUnits: number) =>
        deps.substituteFinder.findMarginOptimizedBrandProposals(
          db,
          { organizationId: ORG_A, branchId: fixture.branchId },
          {
            medicineId: fixture.medicineId,
            presentationId: fixture.presentationId,
            quantityCanonicalUnits,
            at: NOW,
          }
        );
      const read = (quantityCanonicalUnits: number) =>
        inOrg(ORG_A, (db) => compare(db, quantityCanonicalUnits));
      await expect(read(10)).resolves.toEqual([]);
      const rows = await read(5);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.availableCanonicalUnits).toBe(5);

      // HTTP batches share one outer transaction; nested callbacks reuse it.
      await inOrg(ORG_A, async (db) => {
        const [reserved, sibling] = await Promise.all([
          compare(db, 5),
          deps.substituteFinder.findMarginOptimizedBrandProposals(
            db,
            { organizationId: ORG_A, branchId: BRANCH_ONE },
            {
              medicineId: one.medicineId,
              presentationId: one.presentationId,
              quantityCanonicalUnits: 10,
              at: NOW,
            }
          ),
        ]);
        expect(reserved).toHaveLength(1);
        expect(reserved[0]!.availableCanonicalUnits).toBe(5);
        expect(sibling).toHaveLength(1);
        expect(sibling[0]!.availableCanonicalUnits).toBe(40);
        const [restored] = await db.$queryRaw<{ branch: string | null }[]>`
          SELECT current_setting('app.current_branch_id', true) AS branch`;
        expect(restored?.branch ?? '').toBe('');
      });
    }
  );
});

describeIfDatabase('PLAT-04 purchasing read — cross-branch id substitution', () => {
  it("returns the branch's own purchase order when read in its own scope", async () => {
    const order = await inOrg(ORG_A, (db) =>
      deps.branchScope.getBranchPurchaseOrder(
        db,
        { organizationId: ORG_A, branchId: BRANCH_ONE },
        one.purchaseOrderId
      )
    );
    expect(order?.id).toBe(one.purchaseOrderId);
    expect(order?.branchId).toBe(BRANCH_ONE);
  });

  it("returns null for a sibling branch's purchase order id, inside one tenant", async () => {
    const order = await inOrg(ORG_A, (db) =>
      deps.branchScope.getBranchPurchaseOrder(
        db,
        { organizationId: ORG_A, branchId: BRANCH_ONE },
        two.purchaseOrderId
      )
    );
    expect(order).toBeNull();
  });

  it("returns null for another tenant's purchase order id", async () => {
    const order = await inOrg(ORG_A, (db) =>
      deps.branchScope.getBranchPurchaseOrder(
        db,
        { organizationId: ORG_A, branchId: BRANCH_ONE },
        foreign.purchaseOrderId
      )
    );
    expect(order).toBeNull();
  });

  it('lists only the orders of the branch asked for', async () => {
    const orders = await inOrg(ORG_A, (db) =>
      deps.branchScope.listBranchPurchaseOrders(db, {
        organizationId: ORG_A,
        branchId: BRANCH_ONE,
      })
    );
    expect(orders.map((order) => order.id)).toEqual([one.purchaseOrderId]);
  });
});

describeIfDatabase('PLAT-04 branch aggregate — the foreign keys the migration added', () => {
  it("resolves a branch of this tenant and hides another tenant's", async () => {
    await expect(
      inOrg(ORG_A, (db) =>
        deps.branchScope.findBranch(db, { organizationId: ORG_A, branchId: BRANCH_ONE })
      )
    ).resolves.toMatchObject({ id: BRANCH_ONE });
    await expect(
      inOrg(ORG_A, (db) =>
        deps.branchScope.findBranch(db, { organizationId: ORG_A, branchId: BRANCH_FOREIGN })
      )
    ).resolves.toBeNull();
  });

  it('refuses a stock location naming a branch that does not exist in this tenant', async () => {
    // Before PLAT-04 this was accepted: `branchId` was a bare string. It is now
    // a composite foreign key, so the database refuses it.
    await expect(
      inOrg(ORG_A, (db) =>
        db.pharmacyStockLocation.create({
          data: {
            organizationId: ORG_A,
            branchId: BRANCH_FOREIGN,
            code: `STEAL-${suffix}`,
            name: 'Borrowed branch',
            kind: 'STORE',
          },
        })
      )
    ).rejects.toThrow(/[Ff]oreign key/);
  });

  it("refuses a purchase order naming another tenant's branch", async () => {
    // Fully licensed, so the PUR-01 supplier trigger passes and the branch
    // foreign key is what actually refuses the order.
    const supplierId = await inOrg(ORG_A, async (db) => {
      const supplier = await db.pharmacySupplier.create({
        data: { organizationId: ORG_A, name: `Steal ${suffix}`, authorized: true, active: true },
      });
      await db.pharmacySupplierLicence.create({
        data: {
          organizationId: ORG_A,
          supplierId: supplier.id,
          licenceType: 'DRUG_SALE',
          licenceNumber: `LIC-STEAL-${suffix}`,
          issuingAuthority: 'Punjab Drug Control',
          issuedAt: new Date('2026-01-01T00:00:00.000Z'),
          expiresAt: new Date('2030-01-01T00:00:00.000Z'),
          verifiedAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      });
      return supplier.id;
    });
    await expect(
      inOrg(ORG_A, (db) =>
        db.pharmacyPurchaseOrder.create({
          data: {
            organizationId: ORG_A,
            branchId: BRANCH_FOREIGN,
            reference: `PO-STEAL-${suffix}`,
            supplierId,
            createdByUserId: ACTOR,
          },
        })
      )
    ).rejects.toThrow(/[Ff]oreign key/);
  });

  it('refuses to delete a branch that still owns records', async () => {
    await expect(
      inOrg(ORG_A, (db) => db.pharmacyBranch.delete({ where: { id: BRANCH_ONE } }))
    ).rejects.toThrow();
  });
});
