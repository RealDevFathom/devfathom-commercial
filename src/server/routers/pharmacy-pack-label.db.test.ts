/**
 * DEV-752 against migrated PostgreSQL with FORCED row level security.
 *
 * The pack-photo shortcut only suggests values; stock still moves through
 * `createGoodsReceipt` and `postGoodsReceipt`. These cases prove, on the real
 * policies and triggers, that: a photo read crosses no tenant or branch and
 * writes nothing; a mixed-lot delivery drafts and posts as separate lots of one
 * order line, atomically and only once; and a receiving shelf from another
 * branch or tenant is refused before anything is written.
 *
 * Synthetic data only. Skipped (never silently passed) without a database URL.
 */
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
// Role grants are covered by the router unit suite; here the data boundary is under test.
vi.mock('@/lib/pharmacy/procurement-access', () => ({ actorCanProcure: vi.fn(async () => true) }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: vi.fn(async () => ({ ok: true, retryAfter: 0, remaining: 1 })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

const suffix = randomBytes(5).toString('hex');
const ORG_A = `dev752_a_${suffix}`;
const ORG_B = `dev752_b_${suffix}`;
const BRANCH_A = `dev752_ba_${suffix}`;
const BRANCH_A2 = `dev752_ba2_${suffix}`;
const BRANCH_B = `dev752_bb_${suffix}`;
// One receiver per tenant: a live member of that tenant, so the purchasing
// router's deny-by-default checks (#994) run for real against PostgreSQL.
const receiverFor = (organizationId: string) => `${organizationId}_receiver`;
const RECEIVED_AT = new Date('2026-10-20T09:00:00.000Z');

let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let purchasing: typeof import('./pharmacy-purchasing');
let packLabel: typeof import('./pharmacy-pack-label');
let createTRPCRouter: (typeof import('../trpc'))['router'];
let pg: typeof import('pg');
let owner: import('pg').Client;

function context(db: ScopedDb, organizationId: string) {
  return {
    db,
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-procurement'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: { id: receiverFor(organizationId), role: 'EMPLOYEE', status: 'ACTIVE', organizationId },
    },
    organization: { id: organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never;
}
const purchasingCaller = (db: ScopedDb, org: string) =>
  purchasing.pharmacyPurchasingRouter.createCaller(context(db, org));
const packLabelCaller = (db: ScopedDb, org: string) =>
  createTRPCRouter({ pharmacyPackLabel: packLabel.pharmacyPackLabelRouter }).createCaller(
    context(db, org)
  ).pharmacyPackLabel;

type Fixture = {
  organizationId: string;
  branchId: string;
  medicineId: string;
  packLevelId: string;
  storeId: string;
  supplierId: string;
  purchaseOrderId: string;
  purchaseOrderLineId: string;
};

let unique = 0;
const tag = (label: string) => `${suffix}-${label}-${(unique += 1)}`;

async function branch(db: ScopedDb, organizationId: string, id: string) {
  await db.pharmacyBranch.createMany({
    data: [
      {
        id,
        organizationId,
        code: id,
        name: `Branch ${id}`,
        addressLine: '1 Synthetic Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    ],
    skipDuplicates: true,
  });
  // The receiver works at every branch the case creates; branch scope is what
  // the location checks below are about, not whether the receiver is assigned.
  // A branch id already taken by another tenant is skipped above, so there is
  // no branch here to assign.
  const created = await db.pharmacyBranch.findFirst({
    where: { id, organizationId },
    select: { id: true },
  });
  if (!created) return;
  await db.pharmacyBranchAssignment.createMany({
    data: [{ organizationId, branchId: id, userId: receiverFor(organizationId) }],
    skipDuplicates: true,
  });
}

async function storeAt(db: ScopedDb, organizationId: string, branchId: string, label: string) {
  return db.pharmacyStockLocation.create({
    data: { organizationId, branchId, code: `S-${tag(label)}`, name: 'Shelf', kind: 'STORE' },
  });
}

/** One SENT order for 10 packs of 10, built through the tenant path so RLS applies. */
async function fixture(organizationId: string, branchId: string, label: string): Promise<Fixture> {
  return withTenantDb(organizationId, async (db) => {
    await branch(db, organizationId, branchId);
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Synthetic amoxicillin ${tag(label)}`,
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
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const store = await storeAt(db, organizationId, branchId, label);
    const supplier = await db.pharmacySupplier.create({
      data: {
        organizationId,
        name: `Synthetic distributor ${tag(label)}`,
        authorized: true,
        licences: {
          create: {
            licenceType: 'DRUG_SALE',
            licenceNumber: `DSL-${tag(label)}`,
            issuingAuthority: 'DRAP',
            issuedAt: new Date('2025-01-01T00:00:00.000Z'),
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
            verifiedAt: new Date('2025-01-02T00:00:00.000Z'),
          },
        },
      },
    });
    const order = await db.pharmacyPurchaseOrder.create({
      data: {
        organizationId,
        branchId,
        reference: `PO-${tag(label)}`,
        supplierId: supplier.id,
        createdByUserId: 'dev752_buyer',
        lines: {
          create: {
            lineNumber: 1,
            medicineId: medicine.id,
            packLevelId: packLevel.id,
            orderedPacks: 10,
            bonusPacks: 0,
            canonicalUnitsPerPack: 10,
            orderedCanonicalUnits: 100,
            bonusCanonicalUnits: 0,
            listPricePerPackMinor: 10_000,
          },
        },
      },
      include: { lines: true },
    });
    for (const [status, extra] of [
      ['SUBMITTED', { submittedAt: RECEIVED_AT }],
      ['APPROVED', { approvedAt: RECEIVED_AT, approvedByUserId: 'dev752_manager' }],
      ['SENT', { sentAt: RECEIVED_AT }],
    ] as const) {
      await db.pharmacyPurchaseOrder.update({
        where: { id: order.id },
        data: { status, ...extra },
      });
    }
    return {
      organizationId,
      branchId,
      medicineId: medicine.id,
      packLevelId: packLevel.id,
      storeId: store.id,
      supplierId: supplier.id,
      purchaseOrderId: order.id,
      purchaseOrderLineId: order.lines[0]!.id,
    };
  });
}

function lot(f: Fixture, batchNumber: string, receivedPacks: number, expiry: string) {
  return {
    purchaseOrderLineId: f.purchaseOrderLineId,
    medicineId: f.medicineId,
    packLevelId: f.packLevelId,
    batchNumber,
    printedExpiry: new Date(`${expiry}T00:00:00.000Z`),
    expiryPrecision: 'MONTH' as const,
    printedMrpMinor: 25_000,
    canonicalUnitsPerPack: 10,
    receivedPacks,
    bonusPacks: 0,
    invoicedPricePerPackMinor: 10_000,
    stockLocationId: f.storeId,
  };
}

/**
 * These receipts name a purchase order, so drafting never needs an approver PIN.
 * Narrow away the `{ blocked }` outcome, and fail loudly if it ever appears.
 */
function assertDrafted<R>(result: R): asserts result is Exclude<R, { blocked: string }> {
  if (result && typeof result === 'object' && 'blocked' in result) {
    throw new Error(`Goods receipt draft was blocked: ${String(result.blocked)}`);
  }
}

function receipt(f: Fixture, label: string, lines: ReturnType<typeof lot>[]) {
  return {
    reference: `GRN-${tag(label)}`,
    branchId: f.branchId,
    supplierId: f.supplierId,
    purchaseOrderId: f.purchaseOrderId,
    supplierInvoiceRef: `INV-${tag(label)}`,
    supplierInvoiceDate: RECEIVED_AT,
    warrantyEvidenceRef: `W-${tag(label)}`,
    receivedAt: RECEIVED_AT,
    lines,
  };
}

async function photo() {
  const bytes = await sharp({
    create: { width: 64, height: 32, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  return { contentType: 'image/png' as const, dataBase64: bytes.toString('base64') };
}

describeIfDatabase('DEV-752 pack-photo receiving against PostgreSQL', () => {
  beforeAll(async () => {
    ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    purchasing = await import('./pharmacy-purchasing');
    packLabel = await import('./pharmacy-pack-label');
    ({ router: createTRPCRouter } = await import('../trpc'));
    pg = await import('pg');
    owner = new pg.default.Client({ connectionString: TEST_DATABASE_URL });
    await owner.connect();
    const roles = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    // With either attribute the tenant cases would pass for the wrong reason.
    expect(roles.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    await owner.query(`SET app.is_platform_admin = 'true'`);
    for (const id of [ORG_A, ORG_B]) {
      await owner.query(
        `INSERT INTO organizations
           (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $1, $1, $1, 'PHARMACY', 'ONBOARDING', 'SHARED', now(), now())`,
        [id]
      );
      // The receiver: an active member holding only the Goods-in capability.
      await owner.query(
        `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
         VALUES ($1, $2, 'Pharmacy', 'Pharmacy', now())`,
        [`${id}_department`, id]
      );
      await owner.query(
        `INSERT INTO organization_roles (id, "organizationId", key, name, "isSystem", "updatedAt")
         VALUES ($1, $2, 'receiving', 'Receiving', false, now())`,
        [`${id}_receiving_role`, id]
      );
      await owner.query(
        `INSERT INTO organization_role_permissions
           (id, "organizationId", "organizationRoleId", capability, effect)
         VALUES ($1, $2, $3, 'pharmacy:procurement', 'ALLOW')`,
        [`${id}_receiving_grant`, id, `${id}_receiving_role`]
      );
      await owner.query(
        `INSERT INTO users
           (id, "organizationId", name, email, role, department, title, "organizationRoleId", "updatedAt")
         VALUES ($1, $2, 'Receiver', $1 || '@dev752.test', 'EMPLOYEE', 'Pharmacy', 'Receiver', $3, now())`,
        [receiverFor(id), id, `${id}_receiving_role`]
      );
    }
    const { createFixturePackLabelOcrAdapter } = await import('@/lib/pharmacy/pack-label-ocr');
    packLabel.packLabelAdapterSeam.resolve = () => createFixturePackLabelOcrAdapter();
  });

  afterAll(async () => {
    // Append-only fixture rows stay in the throwaway database; no trigger is weakened.
    await owner?.end();
  });

  it('reads a pack photo as a suggestion and writes no receipt or stock', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'read');
    const counts = (db: ScopedDb) =>
      Promise.all([db.pharmacyGoodsReceipt.count(), db.pharmacyInventoryLot.count()]);
    const before = await withTenantDb(ORG_A, counts);
    const proposal = await withTenantDb(ORG_A, async (db) =>
      packLabelCaller(db, ORG_A).read({
        branchId: f.branchId,
        purchaseOrderId: f.purchaseOrderId,
        purchaseOrderLineId: f.purchaseOrderLineId,
        photo: await photo(),
      })
    );
    expect(proposal).toMatchObject({ status: 'PROPOSED', batch: { value: 'SYN-B2741' } });
    expect(await withTenantDb(ORG_A, counts)).toEqual(before);
  });

  it('cannot read another tenant’s order line, even with its exact ids', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'xtenant-read');
    await withTenantDb(ORG_B, (db) => branch(db, ORG_B, BRANCH_A));
    await expect(
      withTenantDb(ORG_B, async (db) =>
        packLabelCaller(db, ORG_B).read({
          branchId: BRANCH_A,
          purchaseOrderId: f.purchaseOrderId,
          purchaseOrderLineId: f.purchaseOrderLineId,
          photo: await photo(),
        })
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cannot read an order line out for another branch of the same tenant', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'xbranch-read');
    await withTenantDb(ORG_A, (db) => branch(db, ORG_A, BRANCH_A2));
    await expect(
      withTenantDb(ORG_A, async (db) =>
        packLabelCaller(db, ORG_A).read({
          branchId: BRANCH_A2,
          purchaseOrderId: f.purchaseOrderId,
          purchaseOrderLineId: f.purchaseOrderLineId,
          photo: await photo(),
        })
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('drafts and posts a mixed-lot delivery as two lots of one order line, only once', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'mixed');
    const drafted = await withTenantDb(ORG_A, (db) =>
      purchasingCaller(db, ORG_A).createGoodsReceipt(
        receipt(f, 'mixed', [
          lot(f, `SYN-L1-${suffix}`, 6, '2028-06-30'),
          lot(f, `SYN-L2-${suffix}`, 4, '2028-09-30'),
        ])
      )
    );
    assertDrafted(drafted);
    expect(drafted.lines.map((line) => line.purchaseOrderLineId)).toEqual([
      f.purchaseOrderLineId,
      f.purchaseOrderLineId,
    ]);
    // Drafting moved nothing.
    expect(
      await withTenantDb(ORG_A, (db) =>
        db.pharmacyInventoryLot.count({
          where: { id: { in: drafted.lines.map((line) => line.inventoryLotId ?? '') } },
        })
      )
    ).toBe(0);

    const post = () =>
      withTenantDb(ORG_A, (db) =>
        purchasingCaller(db, ORG_A).postGoodsReceipt({
          branchId: f.branchId,
          goodsReceiptId: drafted.id,
        })
      );
    await post();
    await expect(post()).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const posted = await withTenantDb(ORG_A, (db) =>
      db.pharmacyGoodsReceiptLine.findMany({
        where: { goodsReceiptId: drafted.id },
        orderBy: { lineNumber: 'asc' },
        select: { inventoryLotId: true, acceptedCanonicalUnits: true, batchNumber: true },
      })
    );
    expect(posted.map((line) => line.acceptedCanonicalUnits)).toEqual([60, 40]);
    expect(new Set(posted.map((line) => line.inventoryLotId)).size).toBe(2);
    const movements = await withTenantDb(ORG_A, (db) =>
      db.pharmacyStockMovement.count({
        where: { inventoryLotId: { in: posted.map((line) => line.inventoryLotId!) } },
      })
    );
    expect(movements).toBe(2);
    // 6 + 4 lots meet the 10 ordered: no false shortage on the first lot.
    expect(
      await withTenantDb(ORG_A, (db) =>
        db.pharmacyReceivingException.findMany({
          where: { goodsReceiptId: drafted.id },
          select: { kind: true },
        })
      )
    ).toEqual([]);
  });

  it('raises one over-receipt for lots that together exceed the order line', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'overage');
    const drafted = await withTenantDb(ORG_A, (db) =>
      purchasingCaller(db, ORG_A).createGoodsReceipt(
        receipt(f, 'overage', [
          lot(f, `SYN-O1-${suffix}`, 10, '2028-06-30'),
          lot(f, `SYN-O2-${suffix}`, 10, '2028-09-30'),
        ])
      )
    );
    assertDrafted(drafted);
    await withTenantDb(ORG_A, (db) =>
      purchasingCaller(db, ORG_A).postGoodsReceipt({
        branchId: f.branchId,
        goodsReceiptId: drafted.id,
      })
    );
    const exceptions = await withTenantDb(ORG_A, (db) =>
      db.pharmacyReceivingException.findMany({
        where: { goodsReceiptId: drafted.id },
        select: { kind: true, expectedUnits: true, observedUnits: true, goodsReceiptLineId: true },
      })
    );
    expect(exceptions).toEqual([
      {
        kind: 'OVERAGE',
        expectedUnits: 100,
        observedUnits: 200,
        goodsReceiptLineId: drafted.lines[1]!.id,
      },
    ]);
  });

  it('raises one shortage, on the last lot, when lots together fall short', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'shortage');
    const drafted = await withTenantDb(ORG_A, (db) =>
      purchasingCaller(db, ORG_A).createGoodsReceipt(
        receipt(f, 'shortage', [
          lot(f, `SYN-H1-${suffix}`, 3, '2028-06-30'),
          lot(f, `SYN-H2-${suffix}`, 4, '2028-09-30'),
        ])
      )
    );
    assertDrafted(drafted);
    await withTenantDb(ORG_A, (db) =>
      purchasingCaller(db, ORG_A).postGoodsReceipt({
        branchId: f.branchId,
        goodsReceiptId: drafted.id,
      })
    );
    const exceptions = await withTenantDb(ORG_A, (db) =>
      db.pharmacyReceivingException.findMany({
        where: { goodsReceiptId: drafted.id },
        select: { kind: true, expectedUnits: true, observedUnits: true, goodsReceiptLineId: true },
      })
    );
    expect(exceptions).toEqual([
      {
        kind: 'SHORTAGE',
        expectedUnits: 100,
        observedUnits: 70,
        goodsReceiptLineId: drafted.lines[1]!.id,
      },
    ]);
  });

  it('keeps the branch default shelf, the order price and the order status the receipt left them', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'defaults');
    await withTenantDb(ORG_A, (db) =>
      db.pharmacyBranch.update({
        where: { id: f.branchId },
        data: { defaultStockLocationId: f.storeId },
      })
    );
    const other = await withTenantDb(ORG_A, (db) => storeAt(db, ORG_A, BRANCH_A, 'override'));
    const snapshot = () =>
      withTenantDb(ORG_A, async (db) => ({
        branchDefault: (
          await db.pharmacyBranch.findFirstOrThrow({
            where: { id: f.branchId },
            select: { defaultStockLocationId: true },
          })
        ).defaultStockLocationId,
        listPrice: (
          await db.pharmacyPurchaseOrderLine.findFirstOrThrow({
            where: { id: f.purchaseOrderLineId },
            select: { listPricePerPackMinor: true },
          })
        ).listPricePerPackMinor,
      }));
    const before = await snapshot();
    // The receiver overrode the shelf for this line only.
    const drafted = await withTenantDb(ORG_A, (db) =>
      purchasingCaller(db, ORG_A).createGoodsReceipt(
        receipt(f, 'defaults', [
          { ...lot(f, `SYN-D1-${suffix}`, 10, '2028-06-30'), stockLocationId: other.id },
        ])
      )
    );
    assertDrafted(drafted);
    expect(
      await withTenantDb(ORG_A, (db) =>
        db.pharmacyPurchaseOrder.findFirstOrThrow({
          where: { id: f.purchaseOrderId },
          select: { status: true },
        })
      )
    ).toEqual({ status: 'SENT' });
    await withTenantDb(ORG_A, (db) =>
      purchasingCaller(db, ORG_A).postGoodsReceipt({
        branchId: f.branchId,
        goodsReceiptId: drafted.id,
      })
    );
    expect(await snapshot()).toEqual(before);
    expect(before.branchDefault).toBe(f.storeId);
    const posted = await withTenantDb(ORG_A, (db) =>
      db.pharmacyGoodsReceiptLine.findFirstOrThrow({
        where: { goodsReceiptId: drafted.id },
        select: { stockLocationId: true },
      })
    );
    expect(posted.stockLocationId).toBe(other.id);
  });

  it('refuses a duplicate submit of the same receipt and keeps exactly one', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'dup');
    const input = receipt(f, 'dup', [lot(f, `SYN-U1-${suffix}`, 2, '2028-06-30')]);
    await withTenantDb(ORG_A, (db) => purchasingCaller(db, ORG_A).createGoodsReceipt(input));
    await expect(
      withTenantDb(ORG_A, (db) => purchasingCaller(db, ORG_A).createGoodsReceipt(input))
    ).rejects.toBeTruthy();
    expect(
      await withTenantDb(ORG_A, (db) =>
        db.pharmacyGoodsReceipt.count({ where: { reference: input.reference } })
      )
    ).toBe(1);
  });

  it('refuses a receiving shelf from another branch before writing anything', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'shelf-branch');
    const other = await withTenantDb(ORG_A, async (db) => {
      await branch(db, ORG_A, BRANCH_A2);
      return storeAt(db, ORG_A, BRANCH_A2, 'other-branch');
    });
    const reference = `GRN-${tag('shelf-branch')}`;
    await expect(
      withTenantDb(ORG_A, (db) =>
        purchasingCaller(db, ORG_A).createGoodsReceipt({
          ...receipt(f, 'shelf-branch', [
            { ...lot(f, `SYN-S1-${suffix}`, 2, '2028-06-30'), stockLocationId: other.id },
          ]),
          reference,
        })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'CROSS_BRANCH_REFERENCE' });
    expect(
      await withTenantDb(ORG_A, (db) => db.pharmacyGoodsReceipt.count({ where: { reference } }))
    ).toBe(0);
  });

  it('refuses a receiving shelf that belongs to another tenant', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'shelf-tenant');
    const foreign = await withTenantDb(ORG_B, async (db) => {
      await branch(db, ORG_B, BRANCH_B);
      return storeAt(db, ORG_B, BRANCH_B, 'foreign');
    });
    await expect(
      withTenantDb(ORG_A, (db) =>
        purchasingCaller(db, ORG_A).createGoodsReceipt(
          receipt(f, 'shelf-tenant', [
            { ...lot(f, `SYN-T1-${suffix}`, 2, '2028-06-30'), stockLocationId: foreign.id },
          ])
        )
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'CROSS_TENANT_REFERENCE' });
  });
});
