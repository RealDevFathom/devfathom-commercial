/**
 * #402 against migrated PostgreSQL with FORCED row level security: the command centre's
 * supplier, ingredient and batch filters narrow every KPI that can be traced to stock and
 * every report list, and the KPIs that cannot be traced (cash, refunds, cash variance,
 * Khata, coverage, fiscal) read null instead of an unfiltered total.
 *
 * The fixture goes through the real receiving, FEFO allocation and journal posting paths:
 * two suppliers, two ingredients, three batches, and one sale line split across two lots of
 * different batches and suppliers with a discount that does not divide evenly, so the
 * per-lot sales here must equal the per-lot journal legs. Skipped unless TEST_DATABASE_URL
 * names a migrated database; the runtime role is asserted NOSUPERUSER/NOBYPASSRLS first.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG = `org_rpt402_${suffix}`;
const BRANCH = `branch_rpt402_${suffix}`;
const ACTOR = 'user_pharmacist';
const WITNESS = 'user_manager';
const DAY = 86_400_000;
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const RECEIVED_AT = new Date(NOW.getTime() - 2 * DAY);

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  receipts: typeof import('./goods-receipt');
  sales: typeof import('./sales');
  postings: typeof import('./finance-postings');
  finance: typeof import('./finance-reports');
  reports: typeof import('./reports');
  expiry: typeof import('./expiry-advisor-operations');
  packs: typeof import('./pack-authentication-operations');
  anomalies: typeof import('./anomaly-signals-operations');
};
let deps: Deps;

type Medicine = { id: string; presentationId: string; packLevelId: string };
type World = {
  supplier1: string;
  supplier2: string;
  ingredient1: string;
  ingredient2: string;
  medicine1: Medicine;
  medicine2: Medicine;
  batch1: string;
  batch2: string;
  batch3: string;
  receipt1: { id: string; lineId: string };
  splitLineId: string;
  otherLineId: string;
};
let world: World;

const inOrg = <T>(work: (db: ScopedDb) => Promise<T>) => deps.withTenantDb(ORG, work);
const scope = { organizationId: ORG, branchId: BRANCH, actorId: ACTOR };
const filters = (extra: { supplierId?: string; ingredientId?: string; batchId?: string } = {}) => ({
  branchIds: [BRANCH],
  from: TODAY,
  to: TODAY,
  ...extra,
});

async function medicine(db: ScopedDb, label: string, ingredientId: string): Promise<Medicine> {
  const created = await db.medicine.create({
    data: {
      organizationId: ORG,
      productName: `${label} ${suffix}`,
      productFamily: 'PHARMACEUTICAL',
      saleable: true,
      presentations: { create: { organizationId: ORG, presentation: 'Tablet, single unit' } },
    },
    include: { presentations: true },
  });
  await db.medicineStrengthComponent.create({
    data: { organizationId: ORG, medicineId: created.id, ingredientId, value: '400', unit: 'mg' },
  });
  const packLevel = await db.packLevel.create({
    data: {
      organizationId: ORG,
      presentationId: created.presentations[0]!.id,
      versionGroupId: `unit-${label}-${suffix}`,
      version: 1,
      level: 'STRIP',
      unitsPerParent: 10,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  return {
    id: created.id,
    presentationId: created.presentations[0]!.id,
    packLevelId: packLevel.id,
  };
}

async function supplier(db: ScopedDb, label: string) {
  const created = await db.pharmacySupplier.create({
    data: {
      organizationId: ORG,
      name: `${label} ${suffix}`,
      authorized: true,
      licences: {
        create: {
          licenceType: 'DRUG_SALE',
          licenceNumber: `DSL-${label}-${suffix}`,
          issuingAuthority: 'DRAP',
          issuedAt: new Date('2025-01-01T00:00:00.000Z'),
          expiresAt: new Date('2030-01-01T00:00:00.000Z'),
          verifiedAt: new Date('2025-01-02T00:00:00.000Z'),
        },
      },
    },
  });
  return created.id;
}

/** A POSTED direct-purchase receipt of `units` single units: the real PUR-02 path. */
async function receive(
  db: ScopedDb,
  input: {
    label: string;
    supplierId: string;
    medicine: Medicine;
    storeId: string;
    units: number;
    unitCostMinor: number;
    mrpMinor: number;
    expiresAt: Date;
  }
) {
  const draft = await db.pharmacyGoodsReceipt.create({
    data: {
      organizationId: ORG,
      branchId: BRANCH,
      reference: `GRN-${input.label}-${suffix}`,
      supplierId: input.supplierId,
      supplierInvoiceRef: `INV-${input.label}-${suffix}`,
      supplierInvoiceDate: RECEIVED_AT,
      warrantyEvidenceRef: `WARRANTY-${input.label}-${suffix}`,
      receivedByUserId: ACTOR,
      receivedAt: RECEIVED_AT,
      directPurchase: true,
      bypassReason: 'Cash-and-carry purchase for this test.',
      bypassApprovedByUserId: WITNESS,
      bypassApprovedAt: RECEIVED_AT,
      lines: {
        create: {
          lineNumber: 1,
          medicineId: input.medicine.id,
          packLevelId: input.medicine.packLevelId,
          batchNumber: `B-${input.label}-${suffix}`,
          printedExpiry: input.expiresAt,
          expiryPrecision: 'DAY',
          printedMrpMinor: input.mrpMinor,
          canonicalUnitsPerPack: 1,
          receivedPacks: input.units,
          bonusPacks: 0,
          receivedCanonicalUnits: input.units,
          bonusCanonicalUnits: 0,
          acceptedCanonicalUnits: input.units,
          rejectedCanonicalUnits: 0,
          invoicedPricePerPackMinor: input.unitCostMinor,
          unitCostMinor: input.unitCostMinor,
          stockLocationId: input.storeId,
        },
      },
    },
    include: { lines: true },
  });
  const posted = await deps.receipts.postGoodsReceipt(db, scope, {
    goodsReceiptId: draft.id,
    at: RECEIVED_AT,
  });
  const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
    where: { id: posted.lines[0]!.inventoryLotId },
  });
  return { receiptId: draft.id, lineId: draft.lines[0]!.id, batchId: lot.manufacturingBatchId };
}

/** A COMPLETED sale line through the real POS aggregate and FEFO allocator, then posted. */
async function sell(
  db: ScopedDb,
  input: { label: string; medicine: Medicine; quantity: number; discountMinor?: number }
) {
  const sale = await deps.sales.createSale(db, scope);
  const { line } = await deps.sales.addSaleLine(db, scope, {
    saleId: sale.id,
    medicineId: input.medicine.id,
    presentationId: input.medicine.presentationId,
    packLevelId: input.medicine.packLevelId,
    saleUnit: 'UNIT',
    quantity: input.quantity,
    canonicalUnitsPerSaleUnit: 1,
    ...(input.discountMinor
      ? {
          discountKind: 'DISCOUNT' as const,
          discountMinor: input.discountMinor,
          approvedByUserId: WITNESS,
          approvalPolicy: 'branch-manager',
        }
      : {}),
    idempotencyKey: `sale-${input.label}-${suffix}`,
  });
  await db.pharmacySale.update({
    where: { id: sale.id },
    data: {
      status: 'COMPLETED',
      completedAt: NOW,
      businessDate: new Date(`${TODAY}T00:00:00.000Z`),
    },
  });
  await deps.postings.postSaleLineEntry(db, scope, { saleLineId: line.id, at: NOW });
  return line.id;
}

/** Per-lot revenue less discount for a line, apportioned exactly as `postSaleLineEntry`. */
async function lotShares(db: ScopedDb, saleLineId: string) {
  const line = await db.pharmacySaleLine.findFirstOrThrow({
    where: { id: saleLineId },
    include: { allocations: { orderBy: { id: 'asc' } } },
  });
  const units = line.allocations.map((allocation) => allocation.canonicalUnits);
  const gross = deps.postings.apportion(line.unitPriceMinor * line.quantity, units);
  const discount = deps.postings.apportion(line.discountMinor, units);
  const lots = await db.pharmacyInventoryLot.findMany({
    where: { id: { in: line.allocations.map((allocation) => allocation.inventoryLotId) } },
  });
  const batchOf = new Map(lots.map((lot) => [lot.id, lot.manufacturingBatchId]));
  return line.allocations.map((allocation, index) => ({
    batchId: batchOf.get(allocation.inventoryLotId)!,
    netMinor: gross[index]! - discount[index]!,
  }));
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  deps = {
    withTenantDb: (await import('@/lib/tenancy/scoped-db')).withTenantDb,
    receipts: await import('./goods-receipt'),
    sales: await import('./sales'),
    postings: await import('./finance-postings'),
    finance: await import('./finance-reports'),
    reports: await import('./reports'),
    expiry: await import('./expiry-advisor-operations'),
    packs: await import('./pack-authentication-operations'),
    anomalies: await import('./anomaly-signals-operations'),
  };
  const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Reports 402', 'Reports 402', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ORG
    )
  );

  world = await inOrg(async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: BRANCH,
        organizationId: ORG,
        code: 'R402',
        name: 'Reports 402',
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    const store = await db.pharmacyStockLocation.create({
      data: {
        organizationId: ORG,
        branchId: BRANCH,
        code: `MAIN-${suffix}`,
        name: 'Main',
        kind: 'STORE',
      },
    });
    const [ingredient1, ingredient2] = await Promise.all([
      db.ingredient.create({ data: { organizationId: ORG, name: `Cefixime ${suffix}` } }),
      db.ingredient.create({ data: { organizationId: ORG, name: `Paracetamol ${suffix}` } }),
    ]);
    const medicine1 = await medicine(db, 'Cefixime 400mg', ingredient1.id);
    const medicine2 = await medicine(db, 'Paracetamol 500mg', ingredient2.id);
    const supplier1 = await supplier(db, 'North Distributors');
    const supplier2 = await supplier(db, 'South Distributors');
    // Medicine 1 arrives from both suppliers; FEFO sells batch 1 (sooner expiry) first.
    const r1 = await receive(db, {
      label: 'm1-s1',
      supplierId: supplier1,
      medicine: medicine1,
      storeId: store.id,
      units: 3,
      unitCostMinor: 1_000,
      mrpMinor: 3_001,
      expiresAt: new Date(NOW.getTime() + 40 * DAY),
    });
    const r2 = await receive(db, {
      label: 'm1-s2',
      supplierId: supplier2,
      medicine: medicine1,
      storeId: store.id,
      units: 10,
      unitCostMinor: 1_100,
      mrpMinor: 3_001,
      expiresAt: new Date(NOW.getTime() + 100 * DAY),
    });
    const r3 = await receive(db, {
      label: 'm2-s2',
      supplierId: supplier2,
      medicine: medicine2,
      storeId: store.id,
      units: 10,
      unitCostMinor: 500,
      mrpMinor: 1_500,
      expiresAt: new Date(NOW.getTime() + 20 * DAY),
    });
    // 5 units span batch 1 (3) and batch 2 (2); a 101 discount leaves a remainder.
    const splitLineId = await sell(db, {
      label: 'split',
      medicine: medicine1,
      quantity: 5,
      discountMinor: 101,
    });
    const otherLineId = await sell(db, { label: 'other', medicine: medicine2, quantity: 2 });

    const lotOf = async (batchId: string) =>
      db.pharmacyInventoryLot.findFirstOrThrow({ where: { manufacturingBatchId: batchId } });
    // A reserved claim on batch 2, a receiving exception on receipt 1, two open recalls
    // (batch 2 by batch, medicine 2 by medicine) and three pack flags.
    await db.pharmacySupplierClaim.create({
      data: {
        organizationId: ORG,
        branchId: BRANCH,
        inventoryLotId: (await lotOf(r2.batchId)).id,
        reservedUnits: 1,
        returnBy: new Date(NOW.getTime() + 10 * DAY),
        createdById: ACTOR,
      },
    });
    await db.pharmacyReceivingException.create({
      data: {
        organizationId: ORG,
        branchId: BRANCH,
        goodsReceiptId: r1.receiptId,
        goodsReceiptLineId: r1.lineId,
        kind: 'DAMAGE',
        detail: 'Crushed carton',
      },
    });
    await db.pharmacyRecallNotice.createMany({
      data: [
        {
          organizationId: ORG,
          batchId: r2.batchId,
          reference: `RC-B-${suffix}`,
          reason: 'Batch recall',
          createdById: ACTOR,
        },
        {
          organizationId: ORG,
          medicineId: medicine2.id,
          reference: `RC-M-${suffix}`,
          reason: 'Medicine recall',
          createdById: ACTOR,
        },
      ],
    });
    const scan = {
      organizationId: ORG,
      branchId: BRANCH,
      source: 'RECEIVING' as const,
      status: 'FLAGGED' as const,
      issues: ['SERIAL_UNKNOWN'],
      explanation: 'Serial not on file.',
      advisory: true,
      scannedByUserId: ACTOR,
    };
    await db.pharmacyPackAuthenticationScan.createMany({
      data: [
        { ...scan, medicineId: medicine1.id, manufacturingBatchId: r1.batchId },
        { ...scan, medicineId: medicine2.id, manufacturingBatchId: r3.batchId },
        { ...scan, status: 'NOT_VERIFIABLE' as const },
      ],
    });
    return {
      supplier1,
      supplier2,
      ingredient1: ingredient1.id,
      ingredient2: ingredient2.id,
      medicine1,
      medicine2,
      batch1: r1.batchId,
      batch2: r2.batchId,
      batch3: r3.batchId,
      receipt1: { id: r1.receiptId, lineId: r1.lineId },
      splitLineId,
      otherLineId,
    };
  });
}, 120_000);

describeIfDatabase('#402 command-centre dimension filters against PostgreSQL', () => {
  it('splits the line across two batches, so the fixture really spans lots and suppliers', async () => {
    const shares = await inOrg((db) => lotShares(db, world.splitLineId));
    expect(shares.map((share) => share.batchId).sort()).toEqual(
      [world.batch1, world.batch2].sort()
    );
  });

  it('narrows sales and margin by supplier, ingredient and batch, matching the journal legs', async () => {
    const result = await inOrg(async (db) => {
      const split = await lotShares(db, world.splitLineId);
      const other = await lotShares(db, world.otherLineId);
      const salesBy = (batchIds: string[]) =>
        [...split, ...other]
          .filter((share) => batchIds.includes(share.batchId))
          .reduce((sum, share) => sum + share.netMinor, 0);
      const margins = await deps.finance.grossMargin(
        db,
        { organizationId: ORG, branchId: BRANCH },
        {
          from: new Date(`${TODAY}T00:00:00.000Z`),
          to: new Date(new Date(`${TODAY}T00:00:00.000Z`).getTime() + DAY),
          by: 'batch',
        }
      );
      const marginBy = (batchIds: string[]) =>
        margins
          .filter((row) => row.key && batchIds.includes(row.key))
          .reduce((sum, row) => sum + row.grossMarginMinor, 0);
      const journalNetBy = (batchIds: string[]) =>
        margins
          .filter((row) => row.key && batchIds.includes(row.key))
          .reduce((sum, row) => sum + row.revenueMinor - row.discountMinor, 0);
      const read = (extra: Parameters<typeof filters>[0]) =>
        deps.reports.readPharmacyOwnerCommandCentre(db, filters(extra));
      const cases = {
        all: [world.batch1, world.batch2, world.batch3],
        supplier1: [world.batch1],
        supplier2: [world.batch2, world.batch3],
        ingredient1: [world.batch1, world.batch2],
        ingredient2: [world.batch3],
        batch1: [world.batch1],
        batch2: [world.batch2],
      } as const;
      const reads = {
        all: await read({}),
        supplier1: await read({ supplierId: world.supplier1 }),
        supplier2: await read({ supplierId: world.supplier2 }),
        ingredient1: await read({ ingredientId: world.ingredient1 }),
        ingredient2: await read({ ingredientId: world.ingredient2 }),
        batch1: await read({ batchId: world.batch1 }),
        batch2: await read({ batchId: world.batch2 }),
      };
      return Object.fromEntries(
        Object.entries(cases).map(([name, batchIds]) => [
          name,
          {
            sales: reads[name as keyof typeof reads].metrics.salesMinor,
            margin: reads[name as keyof typeof reads].metrics.marginMinor,
            expectedSales: salesBy([...batchIds]),
            journalNet: journalNetBy([...batchIds]),
            expectedMargin: marginBy([...batchIds]),
          },
        ])
      );
    });
    // 5 x 3001 - 101 on medicine 1, 2 x 1500 on medicine 2.
    expect(result.all!.sales).toBe(15_005 - 101 + 3_000);
    for (const [name, row] of Object.entries(result)) {
      expect({ name, sales: row.sales }).toEqual({ name, sales: row.expectedSales });
      expect({ name, sales: row.sales }).toEqual({ name, sales: row.journalNet });
      expect({ name, margin: row.margin }).toEqual({ name, margin: row.expectedMargin });
    }
    expect(result.batch1!.sales + result.batch2!.sales).toBe(15_005 - 101);
    expect(result.supplier1!.sales).not.toBe(result.all!.sales);
  });

  it('narrows stock, recall, claim and exception KPIs and nulls what cannot be traced', async () => {
    const read = (extra: Parameters<typeof filters>[0]) =>
      inOrg((db) => deps.reports.readPharmacyOwnerCommandCentre(db, filters(extra)));
    const pick = ({ metrics, filterCoverage }: Awaited<ReturnType<typeof read>>) => ({
      expiry30: metrics.expiryValueMinor30,
      expiry180: metrics.expiryValueMinor180,
      recalls: metrics.openRecalls,
      claims: metrics.openClaims,
      exceptions: metrics.openReceivingExceptions,
      unavailable: filterCoverage.unavailableMetrics.length,
    });
    // After the sales: batch 1 is sold out, batch 2 holds 8 x 1100, batch 3 holds 8 x 500.
    expect(pick(await read({}))).toEqual({
      expiry30: 4_000,
      expiry180: 12_800,
      recalls: 2,
      claims: 1,
      exceptions: 1,
      unavailable: 0,
    });
    expect(pick(await read({ supplierId: world.supplier1 }))).toEqual({
      expiry30: 0,
      expiry180: 0,
      recalls: 0,
      claims: 0,
      exceptions: 1,
      unavailable: 7,
    });
    expect(pick(await read({ supplierId: world.supplier2 }))).toEqual({
      expiry30: 4_000,
      expiry180: 12_800,
      recalls: 2,
      claims: 1,
      exceptions: 0,
      unavailable: 7,
    });
    expect(pick(await read({ ingredientId: world.ingredient1 }))).toEqual({
      expiry30: 0,
      expiry180: 8_800,
      recalls: 1,
      claims: 1,
      exceptions: 1,
      unavailable: 7,
    });
    expect(pick(await read({ batchId: world.batch3 }))).toEqual({
      expiry30: 4_000,
      expiry180: 4_000,
      recalls: 1,
      claims: 0,
      exceptions: 0,
      unavailable: 7,
    });
    expect(pick(await read({ batchId: world.batch1, supplierId: world.supplier2 }))).toEqual({
      expiry30: 0,
      expiry180: 0,
      recalls: 0,
      claims: 0,
      exceptions: 0,
      unavailable: 7,
    });

    const unfiltered = await read({});
    const narrowed = await read({ batchId: world.batch2 });
    for (const key of deps.reports.PHARMACY_UNATTRIBUTABLE_METRICS) {
      expect({ key, value: unfiltered.metrics[key] }).not.toEqual({ key, value: null });
      expect({ key, value: narrowed.metrics[key] }).toEqual({ key, value: null });
    }
    expect(narrowed.filterCoverage.dimensions).toEqual(['batch']);
  });

  it('narrows the expiry advice and pack authentication lists', async () => {
    const lists = await inOrg(async (db) => {
      const advice = async (extra: Parameters<typeof filters>[0]) =>
        (await deps.expiry.readExpiryAdvice(db, [BRANCH], undefined, extra))
          .map((item) => item.batchNumber)
          .sort();
      const flags = async (extra: Parameters<typeof filters>[0]) =>
        (await deps.packs.readPackAuthenticationFlags(db, [BRANCH], extra))
          .map((flag) => flag.manufacturingBatchId)
          .sort();
      return {
        advice: {
          all: await advice({}),
          supplier1: await advice({ supplierId: world.supplier1 }),
          supplier2: await advice({ supplierId: world.supplier2 }),
          ingredient1: await advice({ ingredientId: world.ingredient1 }),
          batch3: await advice({ batchId: world.batch3 }),
        },
        flags: {
          all: (await flags({})).length,
          supplier1: await flags({ supplierId: world.supplier1 }),
          supplier2: await flags({ supplierId: world.supplier2 }),
          ingredient2: await flags({ ingredientId: world.ingredient2 }),
          batch1: await flags({ batchId: world.batch1 }),
        },
      };
    });
    const number = (label: string) => `B-${label}-${suffix}`;
    expect(lists.advice).toEqual({
      all: [number('m1-s2'), number('m2-s2')].sort(),
      supplier1: [],
      supplier2: [number('m1-s2'), number('m2-s2')].sort(),
      ingredient1: [number('m1-s2')],
      batch3: [number('m2-s2')],
    });
    expect(lists.flags).toEqual({
      all: 3,
      supplier1: [world.batch1],
      supplier2: [world.batch3],
      ingredient2: [world.batch3],
      batch1: [world.batch1],
    });
  });

  it('applies anomaly scope filters before the 200-signal cap', async () => {
    const window = {
      start: new Date(`${TODAY}T00:00:00.000Z`),
      end: new Date(new Date(`${TODAY}T00:00:00.000Z`).getTime() + DAY),
    };
    const signal = (index: number, computedAt: Date) => ({
      organizationId: ORG,
      branchId: BRANCH,
      kind: 'CASH_VARIANCE' as const,
      dedupKey: `cash-${index}-${suffix}`,
      severity: 'REVIEW' as const,
      scope: { branchId: BRANCH },
      policyVersion: 'test',
      exactNumbers: {},
      explanation: 'Test signal.',
      dataWindowStart: window.start,
      dataWindowEnd: window.end,
      sourceObservedAt: computedAt,
      freshnessSeconds: 60,
      computedAt,
    });
    const found = await inOrg(async (db) => {
      await db.pharmacyAnomalySignal.createMany({
        data: Array.from({ length: 200 }, (_, index) => signal(index, NOW)),
      });
      // Older than every unattributable signal, so it sorts after the first 200 rows.
      await db.pharmacyAnomalySignal.create({
        data: {
          ...signal(999, new Date(NOW.getTime() - DAY)),
          kind: 'PURCHASE_PRICE_DRIFT',
          dedupKey: `price-${suffix}`,
          scope: {
            branchId: BRANCH,
            supplierId: world.supplier2,
            medicineId: world.medicine1.id,
            batchId: world.batch2,
          },
        },
      });
      const read = (extra: Parameters<typeof filters>[0]) =>
        deps.anomalies.readPharmacyAnomalySignals(db, filters(extra));
      return {
        supplier: (await read({ supplierId: world.supplier2 })).map((row) => row.kind),
        ingredient: (await read({ ingredientId: world.ingredient1 })).map((row) => row.kind),
        batch: (await read({ batchId: world.batch2 })).map((row) => row.kind),
        otherSupplier: (await read({ supplierId: world.supplier1 })).length,
      };
    });
    expect(found).toEqual({
      supplier: ['PURCHASE_PRICE_DRIFT'],
      ingredient: ['PURCHASE_PRICE_DRIFT'],
      batch: ['PURCHASE_PRICE_DRIFT'],
      otherSupplier: 0,
    });
  });
});
