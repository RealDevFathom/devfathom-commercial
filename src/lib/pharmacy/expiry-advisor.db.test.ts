/**
 * AI-02 expiry advisor (#1042 / DEV-579, DEV-580, DEV-581) against migrated
 * PostgreSQL with FORCED row level security.
 *
 * The advisor is one raw SQL statement, so a mocked client proves nothing about
 * it: the statement once joined a `medicines` table and a `name` column that do
 * not exist, and every caller (the owner's expiry return proposal, the Reports
 * expiry panel and the daily work pack behind Ask Fathom) failed in production
 * while its unit tests passed. Only a real database can say whether the SQL
 * names the real schema.
 *
 * Two tenants with two branches each hold expiring stock received through a
 * POSTED goods receipt from a supplier with a recorded return window, plus
 * trailing completed-sales history. The scoping case runs through the platform
 * context, where `app.is_platform_admin` makes row level security admit every
 * tenant's lots, so only the query's own tenant and branch predicates can
 * exclude the neighbours' rows.
 *
 * Skipped (never silently passed) when the database URL is absent. The runtime
 * role is asserted NOSUPERUSER/NOBYPASSRLS first.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_dev579_exp_a_${suffix}`;
const ORG_B = `org_dev579_exp_b_${suffix}`;
const ACTOR = `user_owner_${suffix}`;

/** Fixed instants, so no case depends on the wall clock. */
const DAY = 86_400_000;
const AT = new Date('2026-09-02T09:00:00.000Z');
const READ_AT = new Date(AT.getTime() + 60 * 60_000);
const RECEIVED_AT = new Date('2026-02-01T00:00:00.000Z');
const SOLD_AT = new Date(AT.getTime() - 10 * DAY);
/** Printed day; the ledger stores the exclusive end of that day in PKT. */
const PRINTED_EXPIRY = new Date('2026-09-21T00:00:00.000Z');
const RETURN_WINDOW_DAYS = 30;
const RECEIVED_UNITS = 40;
const SOLD_UNITS = 2;
const UNIT_COST_MINOR = 1200;
/**
 * 2 units over 11 history days, 19.4 days to expiry: ceil(40 - 2/11 * 19.4)
 * = 37 units projected unsold, inside the 30-day supplier window.
 */
const PROJECTED_UNSOLD = 37;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  receiving: typeof import('./goods-receipt');
  advisor: typeof import('./expiry-advisor-operations');
  workPack: typeof import('./daily-work-pack');
};
let deps: Deps;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

type BranchFixture = {
  organizationId: string;
  branchId: string;
  medicineName: string;
  batchNumber: string;
  supplierId: string;
  supplierName: string;
  locationId: string;
  lotId: string;
  expiresAt: Date;
};

/**
 * One branch with one expiring lot: its own medicine, location and licensed
 * supplier with a recorded expiry-return window, the lot received through a
 * POSTED direct-purchase goods receipt, and one completed sale of the lot
 * inside the trailing 30-day window.
 */
async function seedBranch(
  organizationId: string,
  label: string,
  completedAt = SOLD_AT,
  businessDate = SOLD_AT
): Promise<BranchFixture> {
  const branchId = `branch_${label}_${suffix}`;
  const medicineName = `Amoxicillin 250mg ${label} ${suffix}`;
  const batchNumber = `B-${label}-${suffix}`;
  const supplierName = `Distributor ${label} ${suffix}`;
  const scope = { organizationId, branchId, actorId: ACTOR };
  return inOrg(organizationId, async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId,
        code: branchId,
        name: `Branch ${label}`,
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: medicineName,
        productFamily: 'PHARMACEUTICAL',
        presentations: { create: { organizationId, presentation: 'Capsule, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const packLevel = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${label}-${suffix}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId,
        code: `MAIN-${label}-${suffix}`,
        name: 'Main store',
        kind: 'STORE',
      },
    });
    const supplier = await db.pharmacySupplier.create({
      data: {
        organizationId,
        name: supplierName,
        authorized: true,
        licences: {
          create: {
            licenceType: 'DRUG_SALE',
            licenceNumber: `LIC-${label}-${suffix}`,
            issuingAuthority: 'Provincial Drug Control',
            issuedAt: new Date('2026-01-01T00:00:00.000Z'),
            expiresAt: new Date('2027-12-31T00:00:00.000Z'),
            verifiedAt: new Date('2026-01-05T00:00:00.000Z'),
            verifiedByUserId: 'user_compliance',
          },
        },
      },
    });
    await db.pharmacySupplierRelationship.create({
      data: {
        organizationId,
        branchId,
        supplierId: supplier.id,
        expiryReturnWindowDays: RETURN_WINDOW_DAYS,
      },
    });
    const receipt = await db.pharmacyGoodsReceipt.create({
      data: {
        organizationId,
        branchId,
        reference: `GRN-${label}-${suffix}`,
        supplierId: supplier.id,
        supplierInvoiceRef: `INV-${label}-${suffix}`,
        supplierInvoiceDate: RECEIVED_AT,
        warrantyEvidenceRef: `WARRANTY-${label}-${suffix}`,
        receivedByUserId: ACTOR,
        receivedAt: RECEIVED_AT,
        directPurchase: true,
        bypassReason: 'Emergency cash-and-carry purchase.',
        bypassApprovedByUserId: 'user_manager',
        bypassApprovedAt: RECEIVED_AT,
        lines: {
          create: {
            lineNumber: 1,
            medicineId: medicine.id,
            packLevelId: packLevel.id,
            batchNumber,
            printedExpiry: PRINTED_EXPIRY,
            expiryPrecision: 'DAY',
            printedMrpMinor: 2000,
            canonicalUnitsPerPack: 10,
            receivedPacks: RECEIVED_UNITS / 10,
            receivedCanonicalUnits: RECEIVED_UNITS,
            acceptedCanonicalUnits: RECEIVED_UNITS,
            invoicedPricePerPackMinor: UNIT_COST_MINOR * 10,
            unitCostMinor: UNIT_COST_MINOR,
            stockLocationId: location.id,
          },
        },
      },
    });
    const posted = await deps.receiving.postGoodsReceipt(db, scope, {
      goodsReceiptId: receipt.id,
      at: RECEIVED_AT,
    });
    const lotId = posted.lines[0]!.inventoryLotId;
    const lot = await db.pharmacyInventoryLot.findUniqueOrThrow({
      where: { id: lotId },
      include: { batch: true },
    });

    const sale = await db.pharmacySale.create({
      data: {
        organizationId,
        branchId,
        status: 'COMPLETED',
        createdByUserId: ACTOR,
        completedAt,
        businessDate,
      },
    });
    const saleLine = await db.pharmacySaleLine.create({
      data: {
        organizationId,
        branchId,
        saleId: sale.id,
        medicineId: medicine.id,
        presentationId: medicine.presentations[0]!.id,
        packLevelId: packLevel.id,
        saleUnit: 'UNIT',
        quantity: SOLD_UNITS,
        canonicalUnitsPerSaleUnit: 1,
        canonicalUnits: SOLD_UNITS,
        unitPriceMinor: 200,
        grossMinor: 200 * SOLD_UNITS,
        proRataCeilingMinor: 200,
        unitCostMinor: UNIT_COST_MINOR,
        idempotencyKey: `sale-line-${label}-${suffix}`,
      },
    });
    await db.pharmacySaleLineAllocation.create({
      data: {
        organizationId,
        branchId,
        saleLineId: saleLine.id,
        inventoryLotId: lotId,
        stockLocationId: location.id,
        canonicalUnits: SOLD_UNITS,
        stockMovementId: `movement-${label}-${suffix}`,
      },
    });

    return {
      organizationId,
      branchId,
      medicineName,
      batchNumber,
      supplierId: supplier.id,
      supplierName,
      locationId: location.id,
      lotId,
      expiresAt: lot.batch.expiresAt as Date,
    };
  });
}

let A1: BranchFixture;
let A2: BranchFixture;
let B1: BranchFixture;
let B2: BranchFixture;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, receiving, advisor, workPack, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./goods-receipt'),
    import('./expiry-advisor-operations'),
    import('./daily-work-pack'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    receiving,
    advisor,
    workPack,
  };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
  // Tenant rows (finance postings on goods receipt) anchor to the organization.
  await scopedDb.withPlatformDb(async (db) => {
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B]
    );
  });
  A1 = await seedBranch(ORG_A, 'a1');
  A2 = await seedBranch(ORG_A, 'a2');
  B1 = await seedBranch(ORG_B, 'b1');
  B2 = await seedBranch(ORG_B, 'b2');
}, 120_000);

describeIfDatabase('#1042 — the expiry advisor reads the real schema', () => {
  it('includes a 00:30 Karachi sale booked on its local date in the observation window', async () => {
    const lot = await seedBranch(
      ORG_A,
      'boundary',
      new Date('2026-09-02T00:30:00+05:00'),
      new Date('2026-09-02')
    );
    const rows = await inOrg(ORG_A, (db) =>
      deps.advisor.readExpiryAdvice(
        db,
        { organizationId: ORG_A, branchIds: [lot.branchId], timeZone: 'Asia/Karachi' },
        new Date('2026-09-02T00:31:00+05:00')
      )
    );
    expect(rows[0]).toMatchObject({ soldUnits: SOLD_UNITS, historyDays: 1 });
  });
  it('returns the branch lot with its medicine, sales history and supplier window', async () => {
    const advice = await inOrg(ORG_A, (db) =>
      deps.advisor.readExpiryAdvice(db, { organizationId: ORG_A, branchIds: [A1.branchId] }, AT)
    );
    expect(advice).toHaveLength(1);
    expect(advice[0]).toMatchObject({
      lotId: A1.lotId,
      branchId: A1.branchId,
      medicineName: A1.medicineName,
      batchNumber: A1.batchNumber,
      supplierId: A1.supplierId,
      supplierName: A1.supplierName,
      stockLocationId: A1.locationId,
      onHandUnits: RECEIVED_UNITS,
      unitCostMinor: UNIT_COST_MINOR,
      expiresAt: A1.expiresAt,
      soldUnits: SOLD_UNITS,
      historyDays: 11,
      returnWindowDays: RETURN_WINDOW_DAYS,
      coldChain: false,
      classification: 'RETURNABLE',
      projectedUnsoldUnits: PROJECTED_UNSOLD,
      valueAtRiskMinor: PROJECTED_UNSOLD * UNIT_COST_MINOR,
      proposalAllowed: true,
    });
  });

  it('reads several of the tenant branches at once, each with its own facts', async () => {
    const advice = await inOrg(ORG_A, (db) =>
      deps.advisor.readExpiryAdvice(
        db,
        { organizationId: ORG_A, branchIds: [A1.branchId, A2.branchId] },
        AT
      )
    );
    expect(
      advice.map((row) => [row.branchId, row.lotId, row.medicineName, row.supplierId]).sort()
    ).toEqual([A1, A2].map((f) => [f.branchId, f.lotId, f.medicineName, f.supplierId]).sort());
  });
});

describeIfDatabase('#1042 / DEV-581 — the advisor scopes itself, not only through RLS', () => {
  it('excludes other-branch and other-tenant lots even where RLS admits every row', async () => {
    const lotIds = [A1, A2, B1, B2].map((fixture) => fixture.lotId);
    const result = await deps.withPlatformDb(async (db) => ({
      // Precondition: this context's RLS hides none of the four tenants' lots
      // or balances, so anything excluded below was excluded by the query.
      visibleLots: await db.pharmacyInventoryLot.count({ where: { id: { in: lotIds } } }),
      visibleBalances: await db.pharmacyStockBalance.count({
        where: { inventoryLotId: { in: lotIds }, disposition: 'AVAILABLE' },
      }),
      ownBranch: await deps.advisor.readExpiryAdvice(
        db,
        { organizationId: ORG_A, branchIds: [A1.branchId] },
        AT
      ),
      // A branch id belonging to another tenant must not reach that tenant.
      smuggledBranch: await deps.advisor.readExpiryAdvice(
        db,
        { organizationId: ORG_A, branchIds: [A1.branchId, B1.branchId] },
        AT
      ),
      wrongTenant: await deps.advisor.readExpiryAdvice(
        db,
        { organizationId: ORG_B, branchIds: [A1.branchId, A2.branchId] },
        AT
      ),
      otherTenant: await deps.advisor.readExpiryAdvice(
        db,
        { organizationId: ORG_B, branchIds: [B1.branchId, B2.branchId] },
        AT
      ),
    }));
    expect(result.visibleLots).toBe(4);
    expect(result.visibleBalances).toBe(4);
    expect(result.ownBranch.map((row) => row.lotId)).toEqual([A1.lotId]);
    expect(result.smuggledBranch.map((row) => row.lotId)).toEqual([A1.lotId]);
    expect(result.wrongTenant).toEqual([]);
    expect(result.otherTenant.map((row) => row.lotId).sort()).toEqual([B1.lotId, B2.lotId].sort());
  });

  it('refuses to read without a server-resolved tenant', async () => {
    await expect(
      inOrg(ORG_A, (db) =>
        deps.advisor.readExpiryAdvice(db, { organizationId: '', branchIds: [A1.branchId] }, AT)
      )
    ).rejects.toThrow('EXPIRY_ADVISOR_SCOPE_REQUIRED');
  });
});

describeIfDatabase('#1042 / DEV-579 — the owner proposes an expiry return', () => {
  it('drafts the supplier expiry claim for the projected unsold units, once', async () => {
    const scope = { organizationId: ORG_A, branchId: A1.branchId, actorId: ACTOR };
    const { first, again, claims } = await inOrg(ORG_A, async (db) => {
      const first = await deps.advisor.proposeExpiryReturn(db, scope, A1.lotId, AT);
      const again = await deps.advisor.proposeExpiryReturn(db, scope, A1.lotId, AT);
      const claims = await db.pharmacySupplierClaim.count({ where: { inventoryLotId: A1.lotId } });
      return { first, again, claims };
    });
    expect(first).toMatchObject({
      organizationId: ORG_A,
      branchId: A1.branchId,
      supplierId: A1.supplierId,
      kind: 'EXPIRY_CLAIM',
      status: 'DRAFT',
      createdByUserId: ACTOR,
    });
    expect(first.lines).toEqual([
      expect.objectContaining({
        inventoryLotId: A1.lotId,
        stockLocationId: A1.locationId,
        quantityUnits: PROJECTED_UNSOLD,
        expectedCreditMinor: PROJECTED_UNSOLD * UNIT_COST_MINOR,
        returnWindowEndsAt: A1.expiresAt,
      }),
    ]);
    expect(again.id).toBe(first.id);
    // A draft is advice for a human: it reserves no stock.
    expect(claims).toBe(0);
  });

  it('refuses a lot that belongs to another branch of the same tenant', async () => {
    await expect(
      inOrg(ORG_A, (db) =>
        deps.advisor.proposeExpiryReturn(
          db,
          { organizationId: ORG_A, branchId: A1.branchId, actorId: ACTOR },
          A2.lotId,
          AT
        )
      )
    ).rejects.toThrow('EXPIRY_RETURN_NOT_ELIGIBLE');
  });
});

describeIfDatabase('#1042 / DEV-580 — the daily work pack carries expiry evidence', () => {
  it('lists the branch expiring batches with their values', async () => {
    const pack = await inOrg(ORG_A, (db) =>
      deps.workPack.readPharmacyDailyWorkPack(
        db,
        {
          organizationId: ORG_A,
          branchIds: [A1.branchId],
          actorId: ACTOR,
          financial: true,
          from: '2026-08-03',
          to: '2026-09-01',
          asOf: AT.toISOString(),
        },
        READ_AT
      )
    );
    const source = pack.sources.find((item) => item.kind === 'expiry');
    expect(source).toMatchObject({
      id: `${A1.branchId}:expiry`,
      scope: { organizationId: ORG_A, branchId: A1.branchId },
      status: 'available',
      returnedRows: 1,
    });
    const evidence = pack.groups
      .flatMap((group) => group.tasks.flatMap((task) => task.evidence))
      .filter((item) => item.sourceId === source!.id);
    expect(evidence).toEqual([
      expect.objectContaining({
        reference: { kind: 'lot', id: A1.lotId },
        state: 'RETURNABLE',
        counts: {
          onHandUnits: RECEIVED_UNITS,
          projectedUnsoldUnits: PROJECTED_UNSOLD,
          historyDays: 11,
        },
        dueAt: A1.expiresAt.toISOString(),
        amounts: [
          expect.objectContaining({
            key: 'valueAtRiskMinor',
            value: PROJECTED_UNSOLD * UNIT_COST_MINOR,
            unit: 'minor',
          }),
        ],
      }),
    ]);
  });
});
