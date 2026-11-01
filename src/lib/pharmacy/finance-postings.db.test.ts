/**
 * PH-FIN / FIN-01 + FIN-03 against migrated PostgreSQL with FORCED row level
 * security.
 *
 * Every posting here is driven from a REAL operational row — a posted goods
 * receipt, a sale line the FEFO allocator actually allocated, an approved
 * count — never from hand-written fixtures shaped to suit the adapter. That is
 * the point of the suite: FIN-01 is a claim about the events the pharmacy
 * domain produces, and an adapter tested against invented input proves nothing
 * about them. The balance itself is a deferred constraint trigger, tenant
 * invisibility is an RLS predicate, and "reversal never edits" is an
 * append-only trigger; none of the three can be shown against a mock. Skipped —
 * never silently passed — when the database URL is absent.
 *
 * The runtime role is asserted NOSUPERUSER/NOBYPASSRLS first: with either
 * attribute the tenant case would read through every policy and pass for the
 * wrong reason.
 *
 * ONE FIXTURE PER TEST. Allocation candidates are looked up by medicine, so two
 * tests sharing one would allocate each other's leftover stock and a COGS
 * assertion could be satisfied by a neighbour's lot.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  retirePharmacyRegulatoryRules,
  seedPharmacyRegulatoryProfile,
} from '@/lib/test-support/pharmacy-regulatory';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1183_a_${suffix}`;
const ORG_B = `org_wha1183_b_${suffix}`;
// A branch id is a global primary key, not unique only within an organization.
// Suffix them per run or a second run conflicts with the first one's rows.
/**
 * EVERY TEST GETS ITS OWN BRANCH as well as its own medicine. The FIN-03 reads
 * are branch-scoped aggregates, so two tests sharing a branch would each see
 * the other's postings and a report assertion could pass — or fail — on rows it
 * never created.
 */
const branch = (label: string) => `branch_${label}_${suffix}`;
const BRANCH_B = branch('org_b');
const ACTOR = 'user_pharmacist';
const WITNESS = `user_manager_${suffix}`;

/** Fixed instants, so no case depends on the wall clock. */
const RECEIVED_AT = new Date('2026-09-02T09:00:00.000Z');
const SOLD_AT = new Date('2026-09-02T12:00:00.000Z');
const LATER = new Date('2026-09-03T09:00:00.000Z');
const WINDOW = {
  from: new Date('2026-09-01T00:00:00.000Z'),
  to: new Date('2026-09-10T00:00:00.000Z'),
};
const EXPIRY_SOON = new Date('2027-03-01T00:00:00.000Z');
const EXPIRY_LATER = new Date('2027-09-01T00:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  postings: typeof import('./finance-postings');
  reports: typeof import('./finance-reports');
  receipts: typeof import('./goods-receipt');
  ledger: typeof import('./stock-ledger');
  operations: typeof import('./inventory-operations');
  sales: typeof import('./sales');
};
let deps: Deps;
/** Branches whose sale-gate regulatory profile is seeded, mapped to the rule-set id. */
const regulatedBranches = new Map<string, string>();

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

let unique = 0;
function tag(label: string) {
  unique += 1;
  return `${suffix}-${label}-${unique}`;
}

type Fixture = {
  organizationId: string;
  branchId: string;
  medicineId: string;
  packLevelId: string;
  presentationId: string;
  storeId: string;
  quarantineId: string;
  supplierId: string;
};

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

/**
 * A private catalog, two locations and a licensed supplier for one test, built
 * as a tenant would build it so RLS and every trigger apply to the fixture too.
 */
async function fixture(organizationId: string, branchId: string, label: string): Promise<Fixture> {
  const created = await buildFixture(organizationId, branchId, label);
  // createSale runs the persisted regulatory gate, which needs the branch's profile.
  if (!regulatedBranches.has(branchId))
    regulatedBranches.set(
      branchId,
      await seedPharmacyRegulatoryProfile(
        deps.withPlatformDb,
        (work) => inOrg(organizationId, work),
        branchId
      )
    );
  return created;
}

async function buildFixture(organizationId: string, branchId: string, label: string) {
  return inOrg(organizationId, async (db) => {
    await ensureBranch(db, organizationId, branchId);
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Cefixime 400mg ${tag(label)}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId, presentation: 'Capsule, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const presentationId = medicine.presentations[0]!.id;
    const packLevel = await db.packLevel.create({
      data: {
        organizationId,
        presentationId,
        versionGroupId: `strip-${tag(label)}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const [store, quarantine] = await Promise.all([
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
          code: `QUAR-${tag(label)}`,
          name: 'Quarantine cage',
          kind: 'QUARANTINE',
        },
      }),
    ]);
    const supplier = await db.pharmacySupplier.create({
      data: {
        organizationId,
        name: `Distributor ${tag(label)}`,
        authorized: true,
        licences: {
          create: {
            licenceType: 'DRUG_SALE',
            licenceNumber: `DSL-${tag(label)}`,
            issuingAuthority: 'DRAP',
            issuedAt: new Date('2025-01-01T00:00:00.000Z'),
            expiresAt: new Date('2028-01-01T00:00:00.000Z'),
            verifiedAt: new Date('2025-01-02T00:00:00.000Z'),
          },
        },
      },
    });

    return {
      organizationId,
      branchId,
      medicineId: medicine.id,
      packLevelId: packLevel.id,
      presentationId,
      storeId: store.id,
      quarantineId: quarantine.id,
      supplierId: supplier.id,
    };
  });
}

async function assignWriteOffWitness(db: ScopedDb, f: Fixture) {
  await db.pharmacyBranchAssignment.create({
    data: {
      organizationId: f.organizationId,
      branchId: f.branchId,
      userId: WITNESS,
      active: true,
    },
  });
}

function scopeOf(f: Fixture, branchId?: string) {
  return { organizationId: f.organizationId, branchId: branchId ?? f.branchId, actorId: ACTOR };
}

/** A POSTED goods receipt: the real PUR-02 path, lot and movements included. */
async function postedReceipt(
  db: ScopedDb,
  f: Fixture,
  label: string,
  options: {
    receivedPacks?: number;
    bonusPacks?: number;
    invoicedPricePerPackMinor?: number;
    unitCostMinor?: number;
    rejectedCanonicalUnits?: number;
    expiresAt?: Date;
    /**
     * Canonical units in one sealed pack. A sale may not BREAK a pack (that is
     * its own INV-04 movement), so a scenario whose sale takes part of a pack
     * has to receive stock in units — `canonicalUnitsPerPack: 1`.
     */
    canonicalUnitsPerPack?: number;
  } = {}
) {
  const receivedPacks = options.receivedPacks ?? 10;
  const bonusPacks = options.bonusPacks ?? 0;
  const rejected = options.rejectedCanonicalUnits ?? 0;
  const unitsPerPack = options.canonicalUnitsPerPack ?? 10;
  const arrived = (receivedPacks + bonusPacks) * unitsPerPack;

  const draft = await db.pharmacyGoodsReceipt.create({
    data: {
      organizationId: f.organizationId,
      branchId: f.branchId,
      reference: `GRN-${tag(label)}`,
      supplierId: f.supplierId,
      supplierInvoiceRef: `INV-${tag(label)}`,
      supplierInvoiceDate: RECEIVED_AT,
      warrantyEvidenceRef: `WARRANTY-${tag(label)}`,
      receivedByUserId: ACTOR,
      receivedAt: RECEIVED_AT,
      directPurchase: true,
      bypassReason: 'Cash-and-carry purchase for this test.',
      bypassApprovedByUserId: WITNESS,
      bypassApprovedAt: RECEIVED_AT,
      lines: {
        create: {
          lineNumber: 1,
          purchaseOrderLineId: null,
          medicineId: f.medicineId,
          packLevelId: f.packLevelId,
          batchNumber: `B-${tag(label)}`,
          printedExpiry: options.expiresAt ?? EXPIRY_LATER,
          expiryPrecision: 'DAY',
          // 3_000 minor per canonical unit, whatever the pack size.
          printedMrpMinor: 3_000 * unitsPerPack,
          canonicalUnitsPerPack: unitsPerPack,
          receivedPacks,
          bonusPacks,
          receivedCanonicalUnits: receivedPacks * unitsPerPack,
          bonusCanonicalUnits: bonusPacks * unitsPerPack,
          acceptedCanonicalUnits: arrived - rejected,
          rejectedCanonicalUnits: rejected,
          rejectionReason: rejected > 0 ? 'Crushed blisters' : null,
          invoicedPricePerPackMinor: options.invoicedPricePerPackMinor ?? 10_000,
          // PUR-03: the invoice spread over received AND bonus units.
          unitCostMinor:
            options.unitCostMinor ??
            Math.floor(
              (receivedPacks * (options.invoicedPricePerPackMinor ?? 10_000)) / (arrived || 1)
            ),
          stockLocationId: f.storeId,
          quarantineLocationId: rejected > 0 ? f.quarantineId : null,
        },
      },
    },
    include: { lines: true },
  });

  const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
    goodsReceiptId: draft.id,
    at: RECEIVED_AT,
  });
  return { draft, posted, line: draft.lines[0]! };
}

/** A lot holding `units` at a chosen landed cost, straight off the ledger. */
async function stockLot(
  db: ScopedDb,
  f: Fixture,
  options: {
    label: string;
    units: number;
    unitCostMinor: number;
    expiresAt: Date;
    branchId?: string;
    locationId?: string;
    /** See `postedReceipt`: 1 when the scenario's sale takes part of a pack. */
    unitsPerPack?: number;
  }
) {
  const batch = await db.pharmacyManufacturingBatch.create({
    data: {
      organizationId: f.organizationId,
      medicineId: f.medicineId,
      batchNumber: `B-${tag(options.label)}`,
      expiresAt: options.expiresAt,
      expiryPrecision: 'DAY',
    },
  });
  const { lot } = await deps.ledger.receiveLot(db, scopeOf(f, options.branchId), {
    manufacturingBatchId: batch.id,
    packLevelId: f.packLevelId,
    stockLocationId: options.locationId ?? f.storeId,
    unitsPerPack: options.unitsPerPack ?? 10,
    supplierName: 'Distributor Ltd',
    supplierInvoiceRef: `INV-${tag(options.label)}`,
    unitCostMinor: options.unitCostMinor,
    printedMrpMinor: 3_000 * (options.unitsPerPack ?? 10),
    receivedExpiresAt: options.expiresAt,
    receivedExpiryPrecision: 'DAY',
    quantityUnits: options.units,
    idempotencyKey: `receipt-${tag(options.label)}`,
    receivedAt: RECEIVED_AT,
  });
  return { batch, lot };
}

/** A COMPLETED sale with one line, through the real POS-03/04 aggregate. */
async function completedSaleLine(
  db: ScopedDb,
  f: Fixture,
  options: {
    label: string;
    quantity: number;
    discountMinor?: number;
    discountKind?: 'DISCOUNT' | 'PROMOTION' | 'COMPLIMENTARY';
  }
) {
  const sale = await deps.sales.createSale(db, scopeOf(f));
  const { line, allocation } = await deps.sales.addSaleLine(db, scopeOf(f), {
    saleId: sale.id,
    medicineId: f.medicineId,
    presentationId: f.presentationId,
    packLevelId: f.packLevelId,
    saleUnit: 'UNIT',
    quantity: options.quantity,
    canonicalUnitsPerSaleUnit: 1,
    discountKind: options.discountKind,
    discountMinor: options.discountMinor,
    approvedByUserId: options.discountMinor ? WITNESS : undefined,
    approvalPolicy: options.discountMinor ? 'branch-manager' : undefined,
    idempotencyKey: `sale-${tag(options.label)}`,
  });
  await db.pharmacySale.update({
    where: { id: sale.id },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });
  return { sale, line, allocation };
}

type Entry = { lines: Array<{ side: string; amountMinor: number; accountCode: string }> };

/** debits = credits, and the entry actually said something. */
function expectBalanced(entry: Entry | null): asserts entry is Entry {
  expect(entry).not.toBeNull();
  const lines = entry!.lines;
  expect(lines.length).toBeGreaterThan(1);
  const debits = lines
    .filter((line) => line.side === 'DEBIT')
    .reduce((sum, line) => sum + line.amountMinor, 0);
  const credits = lines
    .filter((line) => line.side === 'CREDIT')
    .reduce((sum, line) => sum + line.amountMinor, 0);
  expect(debits).toBe(credits);
  expect(debits).toBeGreaterThan(0);
}

function totalFor(entry: Entry, accountCode: string, side: 'DEBIT' | 'CREDIT') {
  return entry.lines
    .filter((line) => line.accountCode === accountCode && line.side === side)
    .reduce((sum, line) => sum + line.amountMinor, 0);
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, postings, reports, receipts, ledger, operations, sales, roleGuard] =
    await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('./finance-postings'),
      import('./finance-reports'),
      import('./goods-receipt'),
      import('./stock-ledger'),
      import('./inventory-operations'),
      import('./sales'),
      import('@/lib/testing/rls-role-guard'),
    ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    postings,
    reports,
    receipts,
    ledger,
    operations,
    sales,
  };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
  // Integrated tip (20261012120000_visibility_context_anchors): tenant rows must reference an
  // existing organization, so anchor this suite's synthetic tenants before any test runs.
  await scopedDb.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B]
    )
  );
  await inOrg(ORG_A, async (db) => {
    await db.organizationDepartment.create({
      data: { organizationId: ORG_A, key: 'pharmacy', name: 'Pharmacy' },
    });
    await db.user.create({
      data: {
        id: WITNESS,
        organizationId: ORG_A,
        name: 'Write-off witness',
        email: `${WITNESS}@example.test`,
        department: 'pharmacy',
        title: 'Manager',
        status: 'ACTIVE',
      },
    });
  });
}, 120_000);

afterAll(async () => {
  if (TEST_DATABASE_URL)
    await retirePharmacyRegulatoryRules(deps.withPlatformDb, [...regulatedBranches.values()]);
});

// ── FIN-01 — one balanced entry per event kind ──────────────────────────────

describeIfDatabase('FIN-01 — goods receipt', () => {
  it('posts a balanced entry traceable to the receipt', async () => {
    const f = await fixture(ORG_A, branch('grn'), 'grn');
    const { entry, receiptId, line } = await inOrg(ORG_A, async (db) => {
      const received = await postedReceipt(db, f, 'grn', { receivedPacks: 10 });
      return {
        receiptId: received.draft.id,
        line: received.line,
        entry: await deps.postings.postGoodsReceiptEntry(db, scopeOf(f), {
          goodsReceiptId: received.draft.id,
          at: RECEIVED_AT,
        }),
      };
    });

    expectBalanced(entry);
    expect(entry.sourceKind).toBe('PHARMACY_GOODS_RECEIPT');
    expect(entry.sourceId).toBe(receiptId);
    // 100 units at 1_000 minor each — the invoiced 10 packs at 10_000.
    expect(totalFor(entry, 'INVENTORY', 'DEBIT')).toBe(100_000);
    expect(totalFor(entry, 'GOODS_RECEIVED_ACCRUAL', 'CREDIT')).toBe(100_000);
    expect(entry.lines.every((leg) => leg.sourceLineId === null || leg.sourceLineId === line.id));
    expect(entry.lines.some((leg) => leg.lotId !== null)).toBe(true);
  });

  it('values quarantined units as inventory, at the location holding them', async () => {
    const f = await fixture(ORG_A, branch('grn-quar'), 'grn-quar');
    const entry = await inOrg(ORG_A, async (db) => {
      const received = await postedReceipt(db, f, 'grn-quar', {
        receivedPacks: 10,
        rejectedCanonicalUnits: 20,
      });
      return deps.postings.postGoodsReceiptEntry(db, scopeOf(f), {
        goodsReceiptId: received.draft.id,
        at: RECEIVED_AT,
      });
    });

    expectBalanced(entry);
    const locations = new Set(
      entry.lines.filter((leg) => leg.accountCode === 'INVENTORY').map((leg) => leg.locationId)
    );
    expect(locations).toContain(f.storeId);
    expect(locations).toContain(f.quarantineId);
    // Rejected units are owned stock, so the accrual still covers all 100.
    expect(totalFor(entry, 'GOODS_RECEIVED_ACCRUAL', 'CREDIT')).toBe(100_000);
  });

  it('books bonus units as quantity and a lower unit cost, never as revenue', async () => {
    const plain = await fixture(ORG_A, branch('bonus-none'), 'bonus-none');
    const bonus = await fixture(ORG_A, branch('bonus-free'), 'bonus-free');

    const withoutBonus = await inOrg(ORG_A, async (db) => {
      const received = await postedReceipt(db, plain, 'bonus-none', {
        receivedPacks: 10,
        bonusPacks: 0,
        invoicedPricePerPackMinor: 10_000,
      });
      return {
        unitCostMinor: received.line.unitCostMinor,
        units: received.line.acceptedCanonicalUnits,
        entry: await deps.postings.postGoodsReceiptEntry(db, scopeOf(plain), {
          goodsReceiptId: received.draft.id,
          at: RECEIVED_AT,
        }),
      };
    });
    const withBonus = await inOrg(ORG_A, async (db) => {
      const received = await postedReceipt(db, bonus, 'bonus-free', {
        receivedPacks: 10,
        bonusPacks: 2,
        invoicedPricePerPackMinor: 10_000,
      });
      return {
        unitCostMinor: received.line.unitCostMinor,
        units: received.line.acceptedCanonicalUnits,
        entry: await deps.postings.postGoodsReceiptEntry(db, scopeOf(bonus), {
          goodsReceiptId: received.draft.id,
          at: RECEIVED_AT,
        }),
      };
    });

    expectBalanced(withoutBonus.entry);
    expectBalanced(withBonus.entry);

    // Quantity up, unit cost down.
    expect(withBonus.units).toBeGreaterThan(withoutBonus.units);
    expect(withBonus.unitCostMinor).toBeLessThan(withoutBonus.unitCostMinor);

    // Never revenue: free goods are not a sale, and the money owed does not
    // grow because more units arrived.
    for (const { entry } of [withoutBonus, withBonus]) {
      expect(entry.lines.some((leg) => leg.accountCode === 'SALES_REVENUE')).toBe(false);
      expect(entry.lines.some((leg) => leg.accountCode === 'SALES_DISCOUNT')).toBe(false);
    }
    expect(totalFor(withBonus.entry, 'GOODS_RECEIVED_ACCRUAL', 'CREDIT')).toBeLessThanOrEqual(
      totalFor(withoutBonus.entry, 'GOODS_RECEIVED_ACCRUAL', 'CREDIT')
    );
  });
});

describeIfDatabase('FIN-01 / FIN-03 — sale line', () => {
  it('posts revenue and COGS at the EXACT allocated lot cost across two lots', async () => {
    const f = await fixture(ORG_A, branch('cogs'), 'cogs');
    const result = await inOrg(ORG_A, async (db) => {
      // FEFO takes the soon-expiring cheap lot first, then the dearer one.
      const cheap = await stockLot(db, f, {
        label: 'cogs-cheap',
        units: 10,
        unitCostMinor: 1_000,
        expiresAt: EXPIRY_SOON,
        unitsPerPack: 1,
      });
      const dear = await stockLot(db, f, {
        label: 'cogs-dear',
        units: 10,
        unitCostMinor: 1_500,
        expiresAt: EXPIRY_LATER,
        unitsPerPack: 1,
      });
      const sold = await completedSaleLine(db, f, { label: 'cogs', quantity: 15 });
      return {
        cheapLotId: cheap.lot.id,
        dearLotId: dear.lot.id,
        line: sold.line,
        entry: await deps.postings.postSaleLineEntry(db, scopeOf(f), {
          saleLineId: sold.line.id,
          at: SOLD_AT,
        }),
      };
    });

    expectBalanced(result.entry);
    expect(result.entry.sourceKind).toBe('PHARMACY_SALE_LINE');
    expect(result.entry.sourceId).toBe(result.line.id);

    // 10 units at 1_000 plus 5 at 1_500.
    const expectedCogs = 10 * 1_000 + 5 * 1_500;
    expect(totalFor(result.entry, 'COST_OF_GOODS_SOLD', 'DEBIT')).toBe(expectedCogs);
    expect(totalFor(result.entry, 'INVENTORY', 'CREDIT')).toBe(expectedCogs);

    // The line's own averaged unit cost would have produced a DIFFERENT number.
    // Asserting they differ is what makes this test non-vacuous: it fails if the
    // adapter ever falls back to the rounded per-sale-unit average.
    const averaged = result.line.unitCostMinor * result.line.quantity;
    expect(averaged).not.toBe(expectedCogs);

    // Per lot, cost is that lot's own landed cost — no blending.
    const byLot = new Map<string, number>();
    for (const leg of result.entry.lines) {
      if (leg.accountCode !== 'COST_OF_GOODS_SOLD') continue;
      byLot.set(leg.lotId!, (byLot.get(leg.lotId!) ?? 0) + leg.amountMinor);
    }
    expect(byLot.get(result.cheapLotId)).toBe(10_000);
    expect(byLot.get(result.dearLotId)).toBe(7_500);
  });

  it('recognises revenue gross and posts the discount as its own treatment', async () => {
    const f = await fixture(ORG_A, branch('discount'), 'discount');
    const { entry, line } = await inOrg(ORG_A, async (db) => {
      await stockLot(db, f, {
        label: 'discount',
        units: 20,
        unitCostMinor: 1_000,
        expiresAt: EXPIRY_LATER,
      });
      const sold = await completedSaleLine(db, f, {
        label: 'discount',
        quantity: 10,
        discountKind: 'DISCOUNT',
        discountMinor: 5_000,
      });
      return {
        line: sold.line,
        entry: await deps.postings.postSaleLineEntry(db, scopeOf(f), {
          saleLineId: sold.line.id,
          at: SOLD_AT,
        }),
      };
    });

    expectBalanced(entry);
    const gross = line.unitPriceMinor * line.quantity;
    // Revenue is the full gross; the discount is visible next to it rather than
    // netted into a smaller sale nobody can audit.
    expect(totalFor(entry, 'SALES_REVENUE', 'CREDIT')).toBe(gross);
    expect(totalFor(entry, 'SALES_DISCOUNT', 'DEBIT')).toBe(5_000);
    // What the customer owes is gross less the discount.
    const owed =
      totalFor(entry, 'SALES_CLEARING', 'DEBIT') - totalFor(entry, 'SALES_CLEARING', 'CREDIT');
    expect(owed).toBe(gross - 5_000);
  });

  it('posts a complimentary line as gross revenue, a full discount and real cost', async () => {
    const f = await fixture(ORG_A, branch('comp'), 'comp');
    const { entry, gross } = await inOrg(ORG_A, async (db) => {
      await stockLot(db, f, {
        label: 'comp',
        units: 20,
        unitCostMinor: 900,
        expiresAt: EXPIRY_LATER,
      });
      // The guardrail refuses a discount that takes the line below cost, so a
      // complimentary line is the largest discount the domain permits: down to
      // exactly cost.
      const sold = await completedSaleLine(db, f, {
        label: 'comp',
        quantity: 10,
        discountKind: 'COMPLIMENTARY',
        discountMinor: 3_000 * 10 - 900 * 10,
      });
      return {
        gross: sold.line.unitPriceMinor * sold.line.quantity,
        entry: await deps.postings.postSaleLineEntry(db, scopeOf(f), {
          saleLineId: sold.line.id,
          at: SOLD_AT,
        }),
      };
    });

    expectBalanced(entry);
    expect(totalFor(entry, 'SALES_REVENUE', 'CREDIT')).toBe(gross);
    expect(totalFor(entry, 'SALES_DISCOUNT', 'DEBIT')).toBe(gross - 9_000);
    expect(totalFor(entry, 'COST_OF_GOODS_SOLD', 'DEBIT')).toBe(9_000);
    expect(entry.lines.some((leg) => leg.memo === 'COMPLIMENTARY')).toBe(true);
  });
});

describeIfDatabase('FIN-01 — return', () => {
  it('posts a linked negation of the returned share and never edits the sale', async () => {
    const f = await fixture(ORG_A, branch('return'), 'return');
    const result = await inOrg(ORG_A, async (db) => {
      await stockLot(db, f, {
        label: 'return',
        units: 20,
        unitCostMinor: 1_000,
        expiresAt: EXPIRY_LATER,
      });
      const sold = await completedSaleLine(db, f, { label: 'return', quantity: 10 });
      const saleEntry = await deps.postings.postSaleLineEntry(db, scopeOf(f), {
        saleLineId: sold.line.id,
        at: SOLD_AT,
      });
      const returned = await deps.sales.returnSaleLine(db, scopeOf(f), {
        saleLineId: sold.line.id,
        lotId: sold.allocation.allocations[0].inventoryLotId,
        canonicalUnits: 4,
        quarantineLocationId: f.quarantineId,
        reason: 'Patient reaction',
        integrityDecision: 'QUARANTINE',
        idempotencyKey: `return-${tag('return')}`,
      });
      if (!returned.returnLine) throw new Error('Expected identified lot return');
      return {
        saleLineId: sold.line.id,
        gross: sold.line.unitPriceMinor * sold.line.quantity,
        saleEntry,
        returnEntry: await deps.postings.postSaleReturnEntry(db, scopeOf(f), {
          saleReturnLineId: returned.returnLine.id,
          at: LATER,
        }),
        saleEntryAfter: await db.financeJournalEntry.findFirstOrThrow({
          where: { organizationId: ORG_A, id: saleEntry.id },
          include: { lines: { orderBy: { id: 'asc' } } },
        }),
      };
    });

    expectBalanced(result.returnEntry);
    expect(result.returnEntry.sourceKind).toBe('PHARMACY_SALE_RETURN_LINE');
    // Four of ten units came back, at their own lot's landed cost.
    expect(totalFor(result.returnEntry, 'COST_OF_GOODS_SOLD', 'CREDIT')).toBe(4_000);
    expect(totalFor(result.returnEntry, 'SALES_REVENUE', 'DEBIT')).toBe(
      Math.floor((result.gross * 4) / 10)
    );
    // The goods are booked back where they physically are.
    expect(
      result.returnEntry.lines
        .filter((leg) => leg.accountCode === 'INVENTORY')
        .every((leg) => leg.locationId === f.quarantineId)
    ).toBe(true);
    // Its legs name the SALE line, so margin by line nets the two.
    expect(result.returnEntry.lines.every((leg) => leg.sourceLineId === result.saleLineId)).toBe(
      true
    );

    // Additive, not destructive: the sale posting is untouched.
    expect(result.saleEntryAfter.lines).toHaveLength(result.saleEntry.lines.length);
    expect(
      result.saleEntryAfter.lines.map((leg) => [leg.accountCode, leg.side, leg.amountMinor])
    ).toEqual(result.saleEntry.lines.map((leg) => [leg.accountCode, leg.side, leg.amountMinor]));
  });
});

describeIfDatabase('FIN-01 — expiry/damage write-off', () => {
  it('posts a balanced write-off at the lot cost, traceable to the movement', async () => {
    const f = await fixture(ORG_A, branch('writeoff'), 'writeoff');
    const { entry, movementId } = await inOrg(ORG_A, async (db) => {
      await assignWriteOffWitness(db, f);
      const { lot } = await stockLot(db, f, {
        label: 'writeoff',
        units: 20,
        unitCostMinor: 1_250,
        expiresAt: EXPIRY_SOON,
      });
      const written = await deps.operations.writeOff(db, scopeOf(f), {
        inventoryLotId: lot.id,
        stockLocationId: f.storeId,
        units: 10,
        witnessId: WITNESS,
        reason: 'Expired stock destroyed',
        evidenceRef: `DEST-${tag('writeoff')}`,
        idempotencyKey: `writeoff-${tag('writeoff')}`,
      });
      return {
        movementId: written.movement.id,
        entry: await deps.postings.postWriteOffEntry(db, scopeOf(f), {
          stockMovementId: written.movement.id,
          at: LATER,
        }),
      };
    });

    expectBalanced(entry);
    expect(entry.sourceId).toBe(movementId);
    expect(totalFor(entry, 'INVENTORY_WRITE_OFF', 'DEBIT')).toBe(12_500);
    expect(totalFor(entry, 'INVENTORY', 'CREDIT')).toBe(12_500);
  });
});

describeIfDatabase('FIN-01 — supplier claim', () => {
  it('moves the reserved value out of inventory into a supplier receivable', async () => {
    const f = await fixture(ORG_A, branch('claim'), 'claim');
    const { entry, claimId } = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, f, {
        label: 'claim',
        units: 30,
        unitCostMinor: 800,
        expiresAt: EXPIRY_SOON,
      });
      const claim = await deps.operations.reserveSupplierClaim(db, scopeOf(f), {
        inventoryLotId: lot.id,
        reservedUnits: 10,
        returnBy: new Date('2027-01-01T00:00:00.000Z'),
      });
      return {
        claimId: claim.id,
        entry: await deps.postings.postSupplierClaimEntry(db, scopeOf(f), {
          supplierClaimId: claim.id,
          at: LATER,
        }),
      };
    });

    expectBalanced(entry);
    expect(entry.sourceId).toBe(claimId);
    expect(totalFor(entry, 'SUPPLIER_CLAIM_RECEIVABLE', 'DEBIT')).toBe(8_000);
    expect(totalFor(entry, 'INVENTORY', 'CREDIT')).toBe(8_000);
  });
});

describeIfDatabase('FIN-01 — inter-branch transfer', () => {
  it('balances across two branches without creating or destroying value', async () => {
    const f = await fixture(ORG_A, branch('transfer'), 'transfer');
    const DESTINATION_BRANCH = branch('transfer-dest');
    const entry = await inOrg(ORG_A, async (db) => {
      await ensureBranch(db, ORG_A, DESTINATION_BRANCH);
      const destination = await db.pharmacyStockLocation.create({
        data: {
          organizationId: ORG_A,
          branchId: DESTINATION_BRANCH,
          code: `MAIN-${tag('transfer-dest')}`,
          name: 'Receiving store',
          kind: 'STORE',
        },
      });
      const { lot } = await stockLot(db, f, {
        label: 'transfer',
        units: 40,
        unitCostMinor: 600,
        expiresAt: EXPIRY_LATER,
      });
      const transfer = await deps.operations.allocateTransfer(db, scopeOf(f), {
        toBranchId: DESTINATION_BRANCH,
        lines: [
          {
            sourceLotId: lot.id,
            sourceStockLocationId: f.storeId,
            destinationStockLocationId: destination.id,
            quantityUnits: 20,
          },
        ],
      });
      return deps.postings.postInterbranchTransferEntry(db, scopeOf(f), {
        transferLineId: transfer.lines[0]!.id,
        at: LATER,
      });
    });

    expectBalanced(entry);
    expect(totalFor(entry, 'INVENTORY_IN_TRANSIT', 'DEBIT')).toBe(12_000);
    expect(totalFor(entry, 'INVENTORY', 'CREDIT')).toBe(12_000);
    // Value leaves one branch and arrives at the other; nothing hits a revenue
    // or expense account, because moving one's own stock earns nothing.
    const out = entry.lines.find((leg) => leg.accountCode === 'INVENTORY')!;
    const inTransit = entry.lines.find((leg) => leg.accountCode === 'INVENTORY_IN_TRANSIT')!;
    expect(out.branchId).toBe(f.branchId);
    expect(inTransit.branchId).toBe(DESTINATION_BRANCH);
  });
});

describeIfDatabase('FIN-01 — count adjustment', () => {
  it('posts a shortfall as shrinkage and a surplus back into inventory', async () => {
    const short = await fixture(ORG_A, branch('count-short'), 'count-short');
    const over = await fixture(ORG_A, branch('count-over'), 'count-over');

    const shortfall = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, short, {
        label: 'count-short',
        units: 30,
        unitCostMinor: 700,
        expiresAt: EXPIRY_LATER,
      });
      const count = await deps.operations.createCount(db, scopeOf(short), {
        varianceThreshold: 100,
        readings: [
          {
            inventoryLotId: lot.id,
            stockLocationId: short.storeId,
            countedSealedPacks: 2,
            countedLooseUnits: 5,
          },
        ],
      });
      await deps.operations.approveCount(db, scopeOf(short), count.id, `count-${tag('short')}`);
      return deps.postings.postCountAdjustmentEntry(db, scopeOf(short), {
        countLineId: count.lines[0]!.id,
        at: LATER,
      });
    });

    expectBalanced(shortfall);
    // 30 expected, 25 counted: five units of value gone.
    expect(totalFor(shortfall!, 'INVENTORY_SHRINKAGE', 'DEBIT')).toBe(3_500);
    expect(totalFor(shortfall!, 'INVENTORY', 'CREDIT')).toBe(3_500);

    const surplus = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, over, {
        label: 'count-over',
        units: 30,
        unitCostMinor: 700,
        expiresAt: EXPIRY_LATER,
      });
      const count = await deps.operations.createCount(db, scopeOf(over), {
        varianceThreshold: 100,
        readings: [
          {
            inventoryLotId: lot.id,
            stockLocationId: over.storeId,
            countedSealedPacks: 3,
            countedLooseUnits: 4,
          },
        ],
      });
      await deps.operations.approveCount(db, scopeOf(over), count.id, `count-${tag('over')}`);
      return deps.postings.postCountAdjustmentEntry(db, scopeOf(over), {
        countLineId: count.lines[0]!.id,
        at: LATER,
      });
    });

    expectBalanced(surplus);
    expect(totalFor(surplus!, 'INVENTORY', 'DEBIT')).toBe(2_800);
    expect(totalFor(surplus!, 'INVENTORY_SHRINKAGE', 'CREDIT')).toBe(2_800);
  });

  it('posts nothing at all when the count matched the book', async () => {
    const f = await fixture(ORG_A, branch('count-exact'), 'count-exact');
    const entry = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, f, {
        label: 'count-exact',
        units: 30,
        unitCostMinor: 700,
        expiresAt: EXPIRY_LATER,
      });
      const count = await deps.operations.createCount(db, scopeOf(f), {
        varianceThreshold: 100,
        readings: [
          {
            inventoryLotId: lot.id,
            stockLocationId: f.storeId,
            countedSealedPacks: 3,
            countedLooseUnits: 0,
          },
        ],
      });
      await deps.operations.approveCount(db, scopeOf(f), count.id, `count-${tag('exact')}`);
      return deps.postings.postCountAdjustmentEntry(db, scopeOf(f), {
        countLineId: count.lines[0]!.id,
        at: LATER,
      });
    });

    expect(entry).toBeNull();
  });
});

describeIfDatabase('FIN-01 — POS settlement and MIG-03 opening events', () => {
  async function settlementRows(label: string) {
    const branchId = branch(label);
    return inOrg(ORG_A, async (db) => {
      await ensureBranch(db, ORG_A, branchId);
      const deviceId = `device-${tag(label)}`;
      const drawer = await db.pharmacyDrawerSession.create({
        data: {
          organizationId: ORG_A,
          branchId,
          deviceId,
          businessDate: SOLD_AT,
          openingFloatMinor: 0,
          openedByActorId: ACTOR,
        },
      });
      const sale = await db.pharmacySale.create({
        data: { organizationId: ORG_A, branchId, createdByUserId: ACTOR },
      });
      const tender = await db.pharmacyTender.create({
        data: {
          organizationId: ORG_A,
          branchId,
          saleId: sale.id,
          type: 'CASH',
          amountMinor: 12_500,
          cashReceivedMinor: 12_500,
          changeGivenMinor: 0,
          drawerSessionId: drawer.id,
          businessDate: SOLD_AT,
          actorId: ACTOR,
          deviceId,
        },
      });
      return { branchId, sale, tender };
    });
  }

  it('posts a balanced tender settlement traceable to the tender', async () => {
    const { branchId, tender } = await settlementRows('tender');
    const entry = await inOrg(ORG_A, (db) =>
      deps.postings.postTenderEntry(
        db,
        { organizationId: ORG_A, branchId, actorId: ACTOR },
        { tenderId: tender.id, at: SOLD_AT }
      )
    );
    expectBalanced(entry);
    expect(entry).toMatchObject({ sourceKind: 'PHARMACY_TENDER', sourceId: tender.id });
    expect(totalFor(entry, 'CASH', 'DEBIT')).toBe(12_500);
  });

  it('posts a balanced additive refund traceable to the refund', async () => {
    const { branchId, sale, tender } = await settlementRows('refund');
    const refund = await inOrg(ORG_A, (db) =>
      db.pharmacyRefund.create({
        data: {
          organizationId: ORG_A,
          branchId,
          saleId: sale.id,
          originalTenderId: tender.id,
          amountMinor: 2_500,
          businessDate: LATER,
          reason: 'Customer return',
          actorId: ACTOR,
        },
      })
    );
    const entry = await inOrg(ORG_A, (db) =>
      deps.postings.postTenderRefundEntry(
        db,
        { organizationId: ORG_A, branchId, actorId: ACTOR },
        { refundId: refund.id, at: LATER }
      )
    );
    expectBalanced(entry);
    expect(entry).toMatchObject({ sourceKind: 'PHARMACY_REFUND', sourceId: refund.id });
    expect(totalFor(entry, 'CASH', 'CREDIT')).toBe(2_500);
  });

  it('posts only the balanced cash variance from a daily close', async () => {
    const branchId = branch('close');
    const close = await inOrg(ORG_A, async (db) => {
      await ensureBranch(db, ORG_A, branchId);
      return db.pharmacyDailyClose.create({
        data: {
          organizationId: ORG_A,
          branchId,
          businessDate: SOLD_AT,
          sequence: 1,
          grossSalesMinor: 10_000,
          refundTotalMinor: 0,
          netSalesMinor: 10_000,
          cashExpectedMinor: 10_000,
          cashCountedMinor: 9_900,
          cashVarianceMinor: -100,
          sourceHash: tag('close'),
          actorId: ACTOR,
        },
      });
    });
    const entry = await inOrg(ORG_A, (db) =>
      deps.postings.postDailyCloseEntry(
        db,
        { organizationId: ORG_A, branchId, actorId: ACTOR },
        { closeId: close.id, at: LATER }
      )
    );
    expectBalanced(entry);
    expect(entry).toMatchObject({ sourceKind: 'PHARMACY_DAILY_CLOSE', sourceId: close.id });
    expect(totalFor(entry, 'CASH_OVER_SHORT', 'DEBIT')).toBe(100);
  });

  it('posts a balanced opening-stock valuation from the MIG-03 total', async () => {
    const branchId = branch('opening-stock');
    const total = await inOrg(ORG_A, async (db) => {
      await ensureBranch(db, ORG_A, branchId);
      const session = await db.pharmacyOpeningSession.create({
        data: {
          organizationId: ORG_A,
          branchId,
          openingAt: RECEIVED_AT,
          status: 'POSTED',
          createdByActorId: ACTOR,
          postedByActorId: ACTOR,
          postedAt: RECEIVED_AT,
        },
      });
      return db.pharmacyOpeningTotal.create({
        data: {
          organizationId: ORG_A,
          branchId,
          sessionId: session.id,
          totalUnits: 20,
          totalValueMinor: BigInt(30_000),
          lineCount: 1,
          actorId: ACTOR,
          postedAt: RECEIVED_AT,
        },
      });
    });
    const entry = await inOrg(ORG_A, (db) =>
      deps.postings.postOpeningStockEntry(
        db,
        { organizationId: ORG_A, branchId, actorId: ACTOR },
        { sessionId: total.sessionId, at: RECEIVED_AT }
      )
    );
    expectBalanced(entry);
    expect(entry).toMatchObject({ sourceKind: 'PHARMACY_OPENING_STOCK', sourceId: total.id });
    expect(totalFor(entry, 'INVENTORY', 'DEBIT')).toBe(30_000);
  });

  it('posts a balanced signed opening ledger row from the MIG-03 interface', async () => {
    const branchId = branch('opening-ledger');
    const opening = await inOrg(ORG_A, async (db) => {
      await ensureBranch(db, ORG_A, branchId);
      const session = await db.pharmacyOpeningSession.create({
        data: { organizationId: ORG_A, branchId, openingAt: RECEIVED_AT, createdByActorId: ACTOR },
      });
      return db.pharmacyOpeningLedgerEntry.create({
        data: {
          organizationId: ORG_A,
          branchId,
          sessionId: session.id,
          account: 'ACCOUNTS_PAYABLE',
          balanceMinor: BigInt(-45_000),
          sourceRef: 'legacy-ap',
          actorId: ACTOR,
          postedAt: RECEIVED_AT,
        },
      });
    });
    const entry = await inOrg(ORG_A, (db) =>
      deps.postings.postOpeningLedgerEntry(
        db,
        { organizationId: ORG_A, branchId, actorId: ACTOR },
        { openingLedgerEntryId: opening.id, at: RECEIVED_AT }
      )
    );
    expectBalanced(entry);
    expect(entry).toMatchObject({ sourceKind: 'PHARMACY_OPENING_LEDGER', sourceId: opening.id });
    expect(totalFor(entry, 'ACCOUNTS_PAYABLE', 'CREDIT')).toBe(45_000);
  });
});

describeIfDatabase('FIN-01 — reversal is additive and org-scoped', () => {
  it('reverses a receipt posting without touching it, and nets it to zero', async () => {
    const f = await fixture(ORG_A, branch('reverse'), 'reverse');
    const result = await inOrg(ORG_A, async (db) => {
      const received = await postedReceipt(db, f, 'reverse', { receivedPacks: 5 });
      const entry = await deps.postings.postGoodsReceiptEntry(db, scopeOf(f), {
        goodsReceiptId: received.draft.id,
        at: RECEIVED_AT,
      });
      const reversal = await deps.postings.reversePostingForSource(db, scopeOf(f), {
        sourceKind: 'PHARMACY_GOODS_RECEIPT',
        sourceId: received.draft.id,
        reason: 'Delivery returned to the supplier',
        at: LATER,
      });
      return {
        entry,
        reversal,
        trail: await db.financeJournalEntry.findMany({
          where: {
            organizationId: ORG_A,
            sourceKind: 'PHARMACY_GOODS_RECEIPT',
            sourceId: received.draft.id,
          },
          include: { lines: true },
          orderBy: { occurredAt: 'asc' },
        }),
      };
    });

    expectBalanced(result.reversal);
    expect(result.reversal.reversesEntryId).toBe(result.entry.id);
    // Both postings survive; the correction is the SECOND one.
    expect(result.trail).toHaveLength(2);
    const net = result.trail
      .flatMap((entry) => entry.lines)
      .reduce((sum, leg) => sum + (leg.side === 'DEBIT' ? leg.amountMinor : -leg.amountMinor), 0);
    expect(net).toBe(0);
    const accrual = result.trail
      .flatMap((entry) => entry.lines)
      .filter((leg) => leg.accountCode === 'GOODS_RECEIVED_ACCRUAL')
      .reduce((sum, leg) => sum + (leg.side === 'CREDIT' ? leg.amountMinor : -leg.amountMinor), 0);
    expect(accrual).toBe(0);
  });

  it('keeps one organization’s postings invisible to another', async () => {
    const f = await fixture(ORG_A, branch('tenant'), 'tenant');
    const entryId = await inOrg(ORG_A, async (db) => {
      const received = await postedReceipt(db, f, 'tenant', { receivedPacks: 3 });
      const entry = await deps.postings.postGoodsReceiptEntry(db, scopeOf(f), {
        goodsReceiptId: received.draft.id,
        at: RECEIVED_AT,
      });
      return entry.id;
    });

    await fixture(ORG_B, BRANCH_B, 'tenant-b');
    const [seen, valuation, margin] = await inOrg(ORG_B, async (db) =>
      Promise.all([
        db.financeJournalEntry.findFirst({ where: { id: entryId } }),
        deps.reports.perpetualValuation(db, { organizationId: ORG_B }, LATER),
        deps.reports.grossMargin(db, { organizationId: ORG_B }, { ...WINDOW, by: 'branch' }),
      ])
    );
    expect(seen).toBeNull();
    expect(valuation).toHaveLength(0);
    expect(margin).toHaveLength(0);
  });
});

// ── FIN-03 — valuation, margin and leakage as queries ───────────────────────

describeIfDatabase('FIN-03 — perpetual valuation, margin and leakage', () => {
  it('values stock per lot and location, and relieves it as it is sold', async () => {
    const f = await fixture(ORG_A, branch('valuation'), 'valuation');
    const result = await inOrg(ORG_A, async (db) => {
      // The whole chain from real documents: two receipts posted onto the
      // books, then a sale that FEFO splits across both.
      const cheap = await postedReceipt(db, f, 'val-cheap', {
        receivedPacks: 10,
        canonicalUnitsPerPack: 1,
        invoicedPricePerPackMinor: 1_000,
        expiresAt: EXPIRY_SOON,
      });
      const dear = await postedReceipt(db, f, 'val-dear', {
        receivedPacks: 10,
        canonicalUnitsPerPack: 1,
        invoicedPricePerPackMinor: 1_500,
        expiresAt: EXPIRY_LATER,
      });
      for (const received of [cheap, dear]) {
        await deps.postings.postGoodsReceiptEntry(db, scopeOf(f), {
          goodsReceiptId: received.draft.id,
          at: RECEIVED_AT,
        });
      }
      const sold = await completedSaleLine(db, f, { label: 'valuation', quantity: 15 });
      await deps.postings.postSaleLineEntry(db, scopeOf(f), {
        saleLineId: sold.line.id,
        at: SOLD_AT,
      });
      return {
        cheapLotId: cheap.posted.lines[0]!.inventoryLotId,
        dearLotId: dear.posted.lines[0]!.inventoryLotId,
        rows: await deps.reports.perpetualValuation(
          db,
          { organizationId: ORG_A, branchId: f.branchId },
          LATER
        ),
      };
    });

    const byLot = new Map(result.rows.map((row) => [row.lotId, row]));
    // The cheap lot is sold out; it must not appear as inventory at all.
    expect(byLot.has(result.cheapLotId)).toBe(false);
    // Five units of the dearer lot remain, at its own landed cost.
    expect(byLot.get(result.dearLotId)?.valueMinor).toBe(7_500);
    expect(byLot.get(result.dearLotId)?.locationId).toBe(f.storeId);
    expect(byLot.get(result.dearLotId)?.medicineId).toBe(f.medicineId);
  });

  it('reports the same margin by line, product, branch and batch', async () => {
    const f = await fixture(ORG_A, branch('margin'), 'margin');
    const result = await inOrg(ORG_A, async (db) => {
      const lot = await stockLot(db, f, {
        label: 'margin',
        units: 20,
        unitCostMinor: 1_000,
        expiresAt: EXPIRY_LATER,
      });
      const sold = await completedSaleLine(db, f, {
        label: 'margin',
        quantity: 10,
        discountKind: 'DISCOUNT',
        discountMinor: 4_000,
      });
      await deps.postings.postSaleLineEntry(db, scopeOf(f), {
        saleLineId: sold.line.id,
        at: SOLD_AT,
      });
      const scope = { organizationId: ORG_A, branchId: f.branchId };
      return {
        batchId: lot.batch.id,
        gross: sold.line.unitPriceMinor * sold.line.quantity,
        saleLineId: sold.line.id,
        byLine: await deps.reports.grossMargin(db, scope, { ...WINDOW, by: 'line' }),
        byProduct: await deps.reports.grossMargin(db, scope, { ...WINDOW, by: 'product' }),
        byBranch: await deps.reports.grossMargin(db, scope, { ...WINDOW, by: 'branch' }),
        byBatch: await deps.reports.grossMargin(db, scope, { ...WINDOW, by: 'batch' }),
      };
    });

    const expected = {
      revenueMinor: result.gross,
      discountMinor: 4_000,
      cogsMinor: 10_000,
      grossMarginMinor: result.gross - 4_000 - 10_000,
    };
    expect(result.byLine).toEqual([{ key: result.saleLineId, ...expected }]);
    expect(result.byProduct).toEqual([{ key: f.medicineId, ...expected }]);
    expect(result.byBranch).toEqual([{ key: f.branchId, ...expected }]);
    // FIN-03: margin by BATCH, which only works because revenue and discount
    // are apportioned onto the allocated lot rather than left lot-less.
    expect(result.byBatch).toEqual([{ key: result.batchId, ...expected }]);
  });

  it('nets a return out of the margin it was sold into', async () => {
    const f = await fixture(ORG_A, branch('margin-return'), 'margin-return');
    const rows = await inOrg(ORG_A, async (db) => {
      await stockLot(db, f, {
        label: 'margin-return',
        units: 20,
        unitCostMinor: 1_000,
        expiresAt: EXPIRY_LATER,
      });
      const sold = await completedSaleLine(db, f, { label: 'margin-return', quantity: 10 });
      await deps.postings.postSaleLineEntry(db, scopeOf(f), {
        saleLineId: sold.line.id,
        at: SOLD_AT,
      });
      const returned = await deps.sales.returnSaleLine(db, scopeOf(f), {
        saleLineId: sold.line.id,
        lotId: sold.allocation.allocations[0].inventoryLotId,
        canonicalUnits: 10,
        quarantineLocationId: f.quarantineId,
        reason: 'Wrong item dispensed',
        integrityDecision: 'QUARANTINE',
        idempotencyKey: `return-${tag('margin-return')}`,
      });
      if (!returned.returnLine) throw new Error('Expected identified lot return');
      // returnSaleLine posts its own reversal at the return's createdAt (wall
      // clock), so this call is an idempotent replay that hands that entry
      // back. The window must reach it, or the reversal is simply out of range.
      const reversal = await deps.postings.postSaleReturnEntry(db, scopeOf(f), {
        saleReturnLineId: returned.returnLine.id,
        at: LATER,
      });
      return deps.reports.grossMargin(
        db,
        { organizationId: ORG_A, branchId: f.branchId },
        { from: WINDOW.from, to: new Date(reversal.occurredAt.getTime() + 1), by: 'line' }
      );
    });

    // Everything sold came back, so the line earned nothing and cost nothing.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      revenueMinor: 0,
      discountMinor: 0,
      cogsMinor: 0,
      grossMarginMinor: 0,
    });
  });

  it('reports discount, write-off and shrinkage as separate leakage', async () => {
    const f = await fixture(ORG_A, branch('leakage'), 'leakage');
    const rows = await inOrg(ORG_A, async (db) => {
      await assignWriteOffWitness(db, f);
      const { lot } = await stockLot(db, f, {
        label: 'leakage',
        units: 60,
        unitCostMinor: 1_000,
        expiresAt: EXPIRY_LATER,
      });
      const sold = await completedSaleLine(db, f, {
        label: 'leakage',
        quantity: 10,
        discountKind: 'DISCOUNT',
        discountMinor: 4_000,
      });
      await deps.postings.postSaleLineEntry(db, scopeOf(f), {
        saleLineId: sold.line.id,
        at: SOLD_AT,
      });
      const written = await deps.operations.writeOff(db, scopeOf(f), {
        inventoryLotId: lot.id,
        stockLocationId: f.storeId,
        units: 10,
        witnessId: WITNESS,
        reason: 'Damaged in storage',
        evidenceRef: `DEST-${tag('leakage')}`,
        idempotencyKey: `writeoff-${tag('leakage')}`,
      });
      await deps.postings.postWriteOffEntry(db, scopeOf(f), {
        stockMovementId: written.movement.id,
        at: LATER,
      });
      const count = await deps.operations.createCount(db, scopeOf(f), {
        varianceThreshold: 100,
        readings: [
          {
            inventoryLotId: lot.id,
            stockLocationId: f.storeId,
            countedSealedPacks: 3,
            countedLooseUnits: 0,
          },
        ],
      });
      await deps.operations.approveCount(db, scopeOf(f), count.id, `count-${tag('leakage')}`);
      await deps.postings.postCountAdjustmentEntry(db, scopeOf(f), {
        countLineId: count.lines[0]!.id,
        at: LATER,
      });

      return deps.reports.leakageReport(
        db,
        { organizationId: ORG_A, branchId: f.branchId },
        WINDOW
      );
    });

    expect(rows).toHaveLength(1);
    const leakage = rows[0]!;
    expect(leakage.discountMinor).toBe(4_000);
    expect(leakage.writeOffMinor).toBe(10_000);
    // 60 received, 10 sold, 10 written off: 40 on the book against 30 counted.
    expect(leakage.shrinkageMinor).toBe(10_000);
    expect(leakage.totalMinor).toBe(24_000);
    expect(leakage.medicineId).toBe(f.medicineId);
  });

  it('has equal debit and credit totals across every posting an organization made', async () => {
    const f = await fixture(ORG_A, branch('trial'), 'trial');
    const rows = await inOrg(ORG_A, async (db) => {
      const received = await postedReceipt(db, f, 'trial', { receivedPacks: 4 });
      await deps.postings.postGoodsReceiptEntry(db, scopeOf(f), {
        goodsReceiptId: received.draft.id,
        at: RECEIVED_AT,
      });
      const sold = await completedSaleLine(db, f, { label: 'trial', quantity: 10 });
      await deps.postings.postSaleLineEntry(db, scopeOf(f), {
        saleLineId: sold.line.id,
        at: SOLD_AT,
      });
      // ORGANIZATION-scoped on purpose. A BRANCH-scoped trial balance is not
      // required to balance: an inter-branch transfer puts its two legs in two
      // different branches, so either branch alone sees only one of them.
      return deps.reports.trialBalance(db, { organizationId: ORG_A }, WINDOW);
    });

    const debits = rows.reduce((sum, row) => sum + row.debitMinor, 0);
    const credits = rows.reduce((sum, row) => sum + row.creditMinor, 0);
    expect(debits).toBe(credits);
    expect(debits).toBeGreaterThan(0);
  });
});
