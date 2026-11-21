/**
 * PH-PUR / PUR-02 receiving, PUR-04, PUR-05 against migrated PostgreSQL with
 * FORCED row level security.
 *
 * Only a real database can settle these. "Rejected goods never enter available
 * stock" is a disposition split that has to survive a trigger, a CHECK and the
 * ledger's own projection; "exceptions remain visible until resolved" is a
 * status column no update may quietly rewrite; "reversal creates linked
 * movements" is a foreign key plus a negation trigger, and the interesting case
 * — reversing a receipt whose stock has already been sold — is decided by the
 * non-negative balance CHECK behind it. A mocked client would prove that this
 * code calls Prisma, not that any of that holds. Skipped (never silently
 * passed) when the database URL is absent.
 *
 * The runtime role is asserted NOSUPERUSER/NOBYPASSRLS first: with either
 * attribute the tenant cases would read through every policy and pass for the
 * wrong reason.
 *
 * STRUCTURAL RULE, learned from the sibling PH-INV suite: an expected database
 * error aborts its whole transaction, so a case that provokes a trigger and
 * then reads back must do the read from a new one (`expectRejection`).
 */
import { createHmac, randomBytes, randomInt } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1171_a_${suffix}`;
const ORG_B = `org_wha1171_b_${suffix}`;
const ORG_RETURN = `org_controlled_return_${suffix}`;
const BRANCH_RETURN = `branch_controlled_return_${suffix}`;
const BRANCH_A = `branch_a_${suffix}`;
const BRANCH_B = `branch_b_${suffix}`;
const RECEIVER = 'user_receiver';
const APPROVER = 'user_manager';

/** Fixed instants, so no case depends on the wall clock. */
const RECEIVED_AT = new Date('2026-09-02T09:00:00.000Z');
const EXPIRY = new Date('2027-06-01T00:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  receipts: typeof import('./goods-receipt');
  ledger: typeof import('./stock-ledger');
  locks: typeof import('./stock-lock-order');
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

/** Run one statement that is EXPECTED to fail, in its own transaction. */
async function expectRejection(
  organizationId: string,
  work: (db: ScopedDb) => Promise<unknown>
): Promise<string> {
  return inOrg(organizationId, (db) =>
    work(db)
      .then(() => 'ACCEPTED — the statement was expected to fail')
      .catch((error: Error) => error.message)
  );
}

type Fixture = {
  organizationId: string;
  branchId: string;
  medicineId: string;
  packLevelId: string;
  storeId: string;
  quarantineId: string;
  supplierId: string;
  purchaseOrderId: string;
  purchaseOrderLineId: string;
};

/**
 * A private catalog, two locations, a licensed supplier and one SENT purchase
 * order for 10 packs of 10 at 10_000 minor per pack, plus 2 free packs.
 *
 * Everything is built as a tenant would build it, so RLS, the PUR-01 supplier
 * trigger and the PUR-02 status machine all apply to the fixture too — a
 * fixture that had to bypass them would not be evidence about the product.
 */
async function fixture(
  organizationId: string,
  branchId: string,
  label: string,
  organizationWide = false,
  locationIds: { storeId?: string; quarantineId?: string } = {}
): Promise<Fixture> {
  return inOrg(organizationId, async (db) => {
    await ensureBranch(db, organizationId, branchId);
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Amoxicillin 500mg ${tag(label)}`,
        productFamily: 'PHARMACEUTICAL',
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
    const [store, quarantine] = await Promise.all([
      db.pharmacyStockLocation.create({
        data: {
          id: locationIds.storeId,
          organizationId,
          branchId,
          code: `MAIN-${tag(label)}`,
          name: 'Main store',
          kind: 'STORE',
        },
      }),
      db.pharmacyStockLocation.create({
        data: {
          id: locationIds.quarantineId,
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

    const order = await db.pharmacyPurchaseOrder.create({
      data: {
        organizationId,
        branchId: organizationWide ? null : branchId,
        reference: `PO-${tag(label)}`,
        supplierId: supplier.id,
        createdByUserId: 'user_buyer',
        lines: {
          create: {
            lineNumber: 1,
            medicineId: medicine.id,
            packLevelId: packLevel.id,
            orderedPacks: 10,
            bonusPacks: 2,
            canonicalUnitsPerPack: 10,
            orderedCanonicalUnits: 100,
            bonusCanonicalUnits: 20,
            listPricePerPackMinor: 10_000,
          },
        },
      },
      include: { lines: true },
    });
    // Walk the PUR-02 status machine rather than writing SENT directly: the
    // trigger refuses a shortcut, and receiving is only legal from SENT.
    await db.pharmacyPurchaseOrder.update({
      where: { id: order.id },
      data: { status: 'SUBMITTED', submittedAt: RECEIVED_AT },
    });
    await db.pharmacyPurchaseOrder.update({
      where: { id: order.id },
      data: { status: 'APPROVED', approvedAt: RECEIVED_AT, approvedByUserId: APPROVER },
    });
    await db.pharmacyPurchaseOrder.update({
      where: { id: order.id },
      data: { status: 'SENT', sentAt: RECEIVED_AT },
    });

    return {
      organizationId,
      branchId,
      medicineId: medicine.id,
      packLevelId: packLevel.id,
      storeId: store.id,
      quarantineId: quarantine.id,
      supplierId: supplier.id,
      purchaseOrderId: order.id,
      purchaseOrderLineId: order.lines[0]!.id,
    };
  });
}

function scopeOf(f: Fixture) {
  return { organizationId: f.organizationId, branchId: f.branchId, actorId: RECEIVER };
}

type LineOverrides = {
  receivedPacks?: number;
  bonusPacks?: number;
  rejectedCanonicalUnits?: number;
  rejectionReason?: string | null;
  invoicedPricePerPackMinor?: number;
  canonicalUnitsPerPack?: number;
  purchaseOrderLineId?: string | null;
  batchNumber?: string;
};

/** A DRAFT receipt with one line. `direct` takes the PUR-05 path instead. */
async function draftReceipt(
  db: ScopedDb,
  f: Fixture,
  label: string,
  options: { direct?: boolean; line?: LineOverrides } = {}
) {
  const line = options.line ?? {};
  const receivedPacks = line.receivedPacks ?? 10;
  const bonusPacks = line.bonusPacks ?? 2;
  const unitsPerPack = line.canonicalUnitsPerPack ?? 10;
  const rejected = line.rejectedCanonicalUnits ?? 0;
  const arrived = (receivedPacks + bonusPacks) * unitsPerPack;

  return db.pharmacyGoodsReceipt.create({
    data: {
      organizationId: f.organizationId,
      branchId: f.branchId,
      reference: `GRN-${tag(label)}`,
      supplierId: f.supplierId,
      purchaseOrderId: options.direct ? null : f.purchaseOrderId,
      supplierInvoiceRef: `INV-${tag(label)}`,
      supplierInvoiceDate: RECEIVED_AT,
      warrantyEvidenceRef: `WARRANTY-${tag(label)}`,
      receivedByUserId: RECEIVER,
      receivedAt: RECEIVED_AT,
      directPurchase: Boolean(options.direct),
      bypassReason: options.direct ? 'Emergency cash-and-carry purchase.' : null,
      bypassApprovedByUserId: options.direct ? APPROVER : null,
      bypassApprovedAt: options.direct ? RECEIVED_AT : null,
      lines: {
        create: {
          lineNumber: 1,
          purchaseOrderLineId:
            line.purchaseOrderLineId === undefined
              ? options.direct
                ? null
                : f.purchaseOrderLineId
              : line.purchaseOrderLineId,
          medicineId: f.medicineId,
          packLevelId: f.packLevelId,
          batchNumber: line.batchNumber ?? `B-${tag(label)}`,
          printedExpiry: EXPIRY,
          expiryPrecision: 'DAY',
          printedMrpMinor: 25_000,
          canonicalUnitsPerPack: unitsPerPack,
          receivedPacks,
          bonusPacks,
          receivedCanonicalUnits: receivedPacks * unitsPerPack,
          bonusCanonicalUnits: bonusPacks * unitsPerPack,
          acceptedCanonicalUnits: arrived - rejected,
          rejectedCanonicalUnits: rejected,
          rejectionReason: rejected > 0 ? (line.rejectionReason ?? 'Crushed blisters') : null,
          invoicedPricePerPackMinor: line.invoicedPricePerPackMinor ?? 10_000,
          unitCostMinor: 833,
          stockLocationId: f.storeId,
          quarantineLocationId: rejected > 0 ? f.quarantineId : null,
        },
      },
    },
    include: { lines: true },
  });
}

/** On-hand units for one lot, keyed by disposition. */
async function balancesFor(db: ScopedDb, organizationId: string, inventoryLotId: string) {
  const rows = await db.pharmacyStockBalance.findMany({
    where: { organizationId, inventoryLotId },
    orderBy: { disposition: 'asc' },
  });
  return Object.fromEntries(rows.map((row) => [row.disposition, row.onHandUnits]));
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, receipts, ledger, locks, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./goods-receipt'),
    import('./stock-ledger'),
    import('./stock-lock-order'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scopedDb.withTenantDb, receipts, ledger, locks };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
  // Receipt posting creates finance journal entries whose visibility foreign
  // key requires the organization itself to exist before any tenant fixtures.
  await scopedDb.withPlatformDb((db) =>
    db.organization.createMany({
      data: [ORG_A, ORG_B, ORG_RETURN].map((id) => ({
        id,
        slug: id,
        legalName: `Goods receipt ${id}`,
        displayName: `Goods receipt ${id}`,
        status: 'ACTIVE' as const,
        // DEV-961: these approvals use PINs, which apply while the authenticator is off.
        requireApprovalAuthenticator: false,
      })),
      skipDuplicates: true,
    })
  );
}, 120_000);

// ── Row level security ──────────────────────────────────────────────────────

describeIfDatabase('PH-PUR receiving — row level security', () => {
  it('enables and forces RLS with a tenant/branch policy on every new table', async () => {
    const tables = [
      'pharmacy_goods_receipts',
      'pharmacy_goods_receipt_lines',
      'pharmacy_receiving_exceptions',
    ];
    const rows = await inOrg(ORG_A, (db) =>
      db.$queryRawUnsafe<
        {
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
          policies: number;
        }[]
      >(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                (SELECT count(*)::int FROM pg_policy p
                  WHERE p.polrelid = c.oid AND p.polname = 'tenant_branch_isolation') AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1)
          ORDER BY c.relname`,
        tables
      )
    );
    expect(rows).toHaveLength(tables.length);
    for (const row of rows) {
      expect({ table: row.relname, ...row }).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: 1,
      });
    }
  });

  it('hides another tenant’s goods receipts and their exceptions', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'rls');
    const receipt = await inOrg(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'rls', {
        line: { receivedPacks: 5, bonusPacks: 0 },
      });
      await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      return drafted;
    });

    const seenByB = await inOrg(ORG_B, async (db) => ({
      receipts: await db.pharmacyGoodsReceipt.count({ where: { id: receipt.id } }),
      lines: await db.pharmacyGoodsReceiptLine.count({ where: { goodsReceiptId: receipt.id } }),
      exceptions: await db.pharmacyReceivingException.count({
        where: { goodsReceiptId: receipt.id },
      }),
    }));
    expect(seenByB).toEqual({ receipts: 0, lines: 0, exceptions: 0 });
  });

  it('refuses a receipt line attached to a receipt in another branch', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'xbranch');
    const receipt = await inOrg(ORG_A, (db) => draftReceipt(db, f, 'xbranch'));
    // The branch travels in the composite key, so the line cannot be adopted by
    // a receipt in a branch it does not belong to.
    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyGoodsReceiptLine.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_B,
          goodsReceiptId: receipt.id,
          lineNumber: 2,
          medicineId: f.medicineId,
          packLevelId: f.packLevelId,
          batchNumber: 'B-XBRANCH',
          printedExpiry: EXPIRY,
          expiryPrecision: 'DAY',
          printedMrpMinor: 25_000,
          canonicalUnitsPerPack: 10,
          receivedPacks: 1,
          bonusPacks: 0,
          receivedCanonicalUnits: 10,
          bonusCanonicalUnits: 0,
          acceptedCanonicalUnits: 10,
          rejectedCanonicalUnits: 0,
          invoicedPricePerPackMinor: 10_000,
          unitCostMinor: 1_000,
          stockLocationId: f.storeId,
        },
      })
    );
    expect(message).not.toContain('ACCEPTED');
  });
});

// ── PUR-02 — receiving into the batch ledger ────────────────────────────────

describeIfDatabase('PUR-02 — posting a receipt into the batch ledger', () => {
  it('creates the lot and the RECEIPT movement, and on-hand projects from them', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'post');
    const result = await inOrg(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'post');
      const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      const lotId = posted.lines[0]!.inventoryLotId;
      return {
        posted,
        lot: await db.pharmacyInventoryLot.findFirstOrThrow({ where: { id: lotId } }),
        movements: await db.pharmacyStockMovement.findMany({
          where: { inventoryLotId: lotId },
          orderBy: { disposition: 'asc' },
        }),
        balances: await balancesFor(db, ORG_A, lotId),
        receipt: await db.pharmacyGoodsReceipt.findFirstOrThrow({ where: { id: drafted.id } }),
        order: await db.pharmacyPurchaseOrder.findFirstOrThrow({
          where: { id: f.purchaseOrderId },
        }),
      };
    });

    // 10 paid packs + 2 free, at 10 canonical units per pack.
    expect(result.balances).toEqual({ AVAILABLE: 120 });
    expect(result.movements).toHaveLength(1);
    expect(result.movements[0]).toMatchObject({
      kind: 'RECEIPT',
      disposition: 'AVAILABLE',
      quantityUnits: 120,
      sealedPackDelta: 12,
      looseUnitDelta: 0,
    });
    // The batch, expiry, MRP and pack conversion the counter needs are all on
    // the lot: this is what "saleable" means (PUR-02).
    expect(result.lot).toMatchObject({
      unitsPerPack: 10,
      printedMrpMinor: 25_000,
      receivedExpiryPrecision: 'DAY',
    });
    expect(result.lot.receivedAt).not.toBeNull();
    expect(result.receipt.status).toBe('POSTED');
    // PUR-02: the order is now being received against.
    expect(result.order.status).toBe('RECEIVING');
    expect(result.posted.exceptions).toEqual([]);
  });

  it('drafts and posts branch receipts against SENT and RECEIVING organization-wide orders', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'org-wide', true);
    const result = await inOrg(ORG_A, async (db) => {
      const balances = [];
      for (const delivery of ['first', 'second']) {
        const order = await deps.receipts.lockReceivablePurchaseOrder(db, scopeOf(f), {
          purchaseOrderId: f.purchaseOrderId,
          supplierId: f.supplierId,
        });
        expect(order.branchId).toBeNull();
        expect(order.status).toBe(delivery === 'first' ? 'SENT' : 'RECEIVING');
        const receipt = await draftReceipt(db, f, `org-wide-${delivery}`, {
          line: { receivedPacks: 5, bonusPacks: 0 },
        });
        const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
          goodsReceiptId: receipt.id,
          at: RECEIVED_AT,
        });
        expect(receipt.branchId).toBe(BRANCH_A);
        balances.push(await balancesFor(db, ORG_A, posted.lines[0]!.inventoryLotId));
      }
      return {
        balances,
        order: await db.pharmacyPurchaseOrder.findFirstOrThrow({
          where: { id: f.purchaseOrderId },
        }),
      };
    });

    expect(result.balances).toEqual([{ AVAILABLE: 50 }, { AVAILABLE: 50 }]);
    expect(result.order).toMatchObject({ branchId: null, status: 'RECEIVING' });
  });

  it('serializes posting against cancellation of the linked order', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'post-cancel-race');
    const drafted = await inOrg(ORG_A, (db) => draftReceipt(db, f, 'post-cancel-race'));

    let releaseOrderLock!: () => void;
    const holdOrderLock = new Promise<void>((resolve) => {
      releaseOrderLock = resolve;
    });
    let orderLocked!: () => void;
    const hasOrderLock = new Promise<void>((resolve) => {
      orderLocked = resolve;
    });

    const posting = inOrg(ORG_A, async (db) => {
      let lockQueries = 0;
      const pausedDb = new Proxy(db, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== '$queryRaw' || typeof value !== 'function') return value;
          return async (...args: unknown[]) => {
            const rows = await Reflect.apply(value, target, args);
            lockQueries += 1;
            if (lockQueries === 2) {
              orderLocked();
              await holdOrderLock;
            }
            return rows;
          };
        },
      }) as ScopedDb;
      return deps.receipts.postGoodsReceipt(pausedDb, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
    });

    await hasOrderLock;
    let cancellationSettled = false;
    const cancellation = inOrg(ORG_A, (db) =>
      db.pharmacyPurchaseOrder
        .update({ where: { id: f.purchaseOrderId }, data: { status: 'CANCELLED' } })
        .finally(() => {
          cancellationSettled = true;
        })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cancellationSettled).toBe(false);

    releaseOrderLock();
    await posting;
    await expect(cancellation).rejects.toThrow();

    const result = await inOrg(ORG_A, async (db) => ({
      order: await db.pharmacyPurchaseOrder.findFirstOrThrow({
        where: { id: f.purchaseOrderId },
      }),
      receipt: await db.pharmacyGoodsReceipt.findFirstOrThrow({ where: { id: drafted.id } }),
      movements: await db.pharmacyStockMovement.count({
        where: { organizationId: ORG_A, branchId: BRANCH_A, kind: 'RECEIPT' },
      }),
    }));
    expect(result.order.status).toBe('RECEIVING');
    expect(result.receipt.status).toBe('POSTED');
    expect(result.movements).toBeGreaterThan(0);
  });

  it('refuses receipt creation when cancellation wins across two concurrent transactions', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'draft-cancel-race');

    let releaseCancellation!: () => void;
    const holdCancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let orderCancelled!: () => void;
    const hasCancelledOrder = new Promise<void>((resolve) => {
      orderCancelled = resolve;
    });

    const cancellation = inOrg(ORG_A, async (db) => {
      await db.pharmacyPurchaseOrder.update({
        where: { id: f.purchaseOrderId },
        data: { status: 'CANCELLED' },
      });
      orderCancelled();
      await holdCancellation;
    });

    await hasCancelledOrder;
    let draftingSettled = false;
    const drafting = inOrg(ORG_A, async (db) => {
      await deps.receipts.lockReceivablePurchaseOrder(db, scopeOf(f), {
        purchaseOrderId: f.purchaseOrderId,
        supplierId: f.supplierId,
      });
      return draftReceipt(db, f, 'draft-cancel-race');
    }).finally(() => {
      draftingSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(draftingSettled).toBe(false);

    releaseCancellation();
    await cancellation;
    await expect(drafting).rejects.toThrow('INVALID_TRANSITION');

    const receiptCount = await inOrg(ORG_A, (db) =>
      db.pharmacyGoodsReceipt.count({ where: { purchaseOrderId: f.purchaseOrderId } })
    );
    expect(receiptCount).toBe(0);
  });

  it('joins a second delivery of the same batch number to the one batch', async () => {
    // §8A invariant 18: one manufacturing batch, many inventory lots — which is
    // what lets a recall reach every lot of it at once.
    const f = await fixture(ORG_A, BRANCH_A, 'samebatch');
    const lots = await inOrg(ORG_A, async (db) => {
      const first = await draftReceipt(db, f, 'samebatch-1', {
        line: { batchNumber: 'B-SHARED', receivedPacks: 5, bonusPacks: 0 },
      });
      const second = await draftReceipt(db, f, 'samebatch-2', {
        line: { batchNumber: 'B-SHARED', receivedPacks: 5, bonusPacks: 0 },
      });
      const a = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: first.id,
        at: RECEIVED_AT,
      });
      const b = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: second.id,
        at: RECEIVED_AT,
      });
      return db.pharmacyInventoryLot.findMany({
        where: { id: { in: [a.lines[0]!.inventoryLotId, b.lines[0]!.inventoryLotId] } },
      });
    });
    expect(lots).toHaveLength(2);
    expect(lots[0]!.manufacturingBatchId).toBe(lots[1]!.manufacturingBatchId);
  });

  it('refuses the same batch number arriving with a different expiry', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'expiryclash');
    const message = await expectRejection(ORG_A, async (db) => {
      const first = await draftReceipt(db, f, 'expiry-1', {
        line: { batchNumber: 'B-CLASH', receivedPacks: 1, bonusPacks: 0 },
      });
      await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: first.id,
        at: RECEIVED_AT,
      });
      const second = await db.pharmacyGoodsReceipt.create({
        data: {
          organizationId: f.organizationId,
          branchId: f.branchId,
          reference: `GRN-${tag('expiry-2')}`,
          supplierId: f.supplierId,
          purchaseOrderId: f.purchaseOrderId,
          supplierInvoiceRef: `INV-${tag('expiry-2')}`,
          supplierInvoiceDate: RECEIVED_AT,
          warrantyEvidenceRef: 'WARRANTY-CLASH',
          receivedByUserId: RECEIVER,
          receivedAt: RECEIVED_AT,
          lines: {
            create: {
              lineNumber: 1,
              medicineId: f.medicineId,
              packLevelId: f.packLevelId,
              batchNumber: 'B-CLASH',
              // Same batch, a year later — a contradiction about the same goods.
              printedExpiry: new Date('2028-06-01T00:00:00.000Z'),
              expiryPrecision: 'DAY',
              printedMrpMinor: 25_000,
              canonicalUnitsPerPack: 10,
              receivedPacks: 1,
              bonusPacks: 0,
              receivedCanonicalUnits: 10,
              bonusCanonicalUnits: 0,
              acceptedCanonicalUnits: 10,
              rejectedCanonicalUnits: 0,
              invoicedPricePerPackMinor: 10_000,
              unitCostMinor: 1_000,
              stockLocationId: f.storeId,
            },
          },
        },
      });
      return deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: second.id,
        at: RECEIVED_AT,
      });
    });
    expect(message).toContain('BATCH_EXPIRY_CONFLICT');
  });

  it('refuses to post once the supplier’s authorization has been withdrawn', async () => {
    // The whole point of re-checking at posting: the supplier was orderable
    // when the receipt was drafted and is not when the goods arrive.
    const f = await fixture(ORG_A, BRANCH_A, 'unauth');
    const message = await expectRejection(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'unauth');
      await db.pharmacySupplier.update({
        where: { id: f.supplierId },
        data: { authorized: false },
      });
      return deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
    });
    expect(message).toContain('SUPPLIER_NOT_AUTHORIZED');
  });

  it('refuses a receipt posted against an order that was never sent', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'notsent');
    const message = await expectRejection(ORG_A, async (db) => {
      const order = await db.pharmacyPurchaseOrder.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          reference: `PO-DRAFT-${tag('notsent')}`,
          supplierId: f.supplierId,
          createdByUserId: 'user_buyer',
        },
      });
      const receipt = await db.pharmacyGoodsReceipt.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          reference: `GRN-${tag('notsent')}`,
          supplierId: f.supplierId,
          purchaseOrderId: order.id,
          supplierInvoiceRef: `INV-${tag('notsent')}`,
          supplierInvoiceDate: RECEIVED_AT,
          warrantyEvidenceRef: 'WARRANTY-NOTSENT',
          receivedByUserId: RECEIVER,
          receivedAt: RECEIVED_AT,
          // A complete receipt in every other respect, so the refusal can only
          // be about the order's status.
          lines: {
            create: {
              lineNumber: 1,
              medicineId: f.medicineId,
              packLevelId: f.packLevelId,
              batchNumber: 'B-NOTSENT',
              printedExpiry: EXPIRY,
              expiryPrecision: 'DAY',
              printedMrpMinor: 25_000,
              canonicalUnitsPerPack: 10,
              receivedPacks: 1,
              bonusPacks: 0,
              receivedCanonicalUnits: 10,
              bonusCanonicalUnits: 0,
              acceptedCanonicalUnits: 10,
              rejectedCanonicalUnits: 0,
              invoicedPricePerPackMinor: 10_000,
              unitCostMinor: 1_000,
              stockLocationId: f.storeId,
            },
          },
        },
      });
      return db.pharmacyGoodsReceipt.update({
        where: { id: receipt.id },
        data: { status: 'POSTED', postedAt: RECEIVED_AT },
      });
    });
    expect(message).toContain('only be posted against a sent purchase order');
  });

  it('refuses a posted receipt with no lines', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'nolines');
    const message = await expectRejection(ORG_A, async (db) => {
      const receipt = await db.pharmacyGoodsReceipt.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          reference: `GRN-${tag('nolines')}`,
          supplierId: f.supplierId,
          purchaseOrderId: f.purchaseOrderId,
          supplierInvoiceRef: `INV-${tag('nolines')}`,
          supplierInvoiceDate: RECEIVED_AT,
          warrantyEvidenceRef: 'WARRANTY-NOLINES',
          receivedByUserId: RECEIVER,
          receivedAt: RECEIVED_AT,
        },
      });
      return db.pharmacyGoodsReceipt.update({
        where: { id: receipt.id },
        data: { status: 'POSTED', postedAt: RECEIVED_AT },
      });
    });
    expect(message).toContain('cannot be posted with no lines');
  });

  it.each([
    ['batch number', { batchNumber: '   ' }],
    ['printed MRP', { printedMrpMinor: 0 }],
    ['pack conversion', { canonicalUnitsPerPack: 0 }],
  ] as const)('refuses a receipt line with no %s at the row level', async (_field, missing) => {
    // Fail closed in the database, not only in the service: these four columns
    // are what make received stock saleable, so an absent one is
    // unrepresentable rather than merely unreached.
    const f = await fixture(ORG_A, BRANCH_A, `field-${_field.replace(/\s/g, '')}`);
    const receipt = await inOrg(ORG_A, (db) => draftReceipt(db, f, `field-${_field}`));
    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyGoodsReceiptLine.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          goodsReceiptId: receipt.id,
          lineNumber: 2,
          medicineId: f.medicineId,
          packLevelId: f.packLevelId,
          batchNumber: 'B-FIELD',
          printedExpiry: EXPIRY,
          expiryPrecision: 'DAY',
          printedMrpMinor: 25_000,
          canonicalUnitsPerPack: 10,
          receivedPacks: 1,
          bonusPacks: 0,
          receivedCanonicalUnits: 10,
          bonusCanonicalUnits: 0,
          acceptedCanonicalUnits: 10,
          rejectedCanonicalUnits: 0,
          invoicedPricePerPackMinor: 10_000,
          unitCostMinor: 1_000,
          stockLocationId: f.storeId,
          ...missing,
        },
      })
    );
    expect(message).not.toContain('ACCEPTED');
  });

  it('refuses canonical units that do not project the packs they came from', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'projection');
    const receipt = await inOrg(ORG_A, (db) => draftReceipt(db, f, 'projection'));
    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyGoodsReceiptLine.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          goodsReceiptId: receipt.id,
          lineNumber: 2,
          medicineId: f.medicineId,
          packLevelId: f.packLevelId,
          batchNumber: 'B-PROJ',
          printedExpiry: EXPIRY,
          expiryPrecision: 'DAY',
          printedMrpMinor: 25_000,
          canonicalUnitsPerPack: 10,
          receivedPacks: 10,
          bonusPacks: 0,
          receivedCanonicalUnits: 999,
          bonusCanonicalUnits: 0,
          acceptedCanonicalUnits: 999,
          rejectedCanonicalUnits: 0,
          invoicedPricePerPackMinor: 10_000,
          unitCostMinor: 1_000,
          stockLocationId: f.storeId,
        },
      })
    );
    expect(message).not.toContain('ACCEPTED');
  });
});

// ── PUR-04 — rejected goods, exceptions, reversal ───────────────────────────

describeIfDatabase('PUR-04 — rejected goods never enter available stock', () => {
  it('posts rejected units to QUARANTINE and only the rest to AVAILABLE', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'reject');
    const result = await inOrg(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'reject', {
        line: { receivedPacks: 10, bonusPacks: 0, rejectedCanonicalUnits: 30 },
      });
      const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      const lotId = posted.lines[0]!.inventoryLotId;
      return {
        balances: await balancesFor(db, ORG_A, lotId),
        movements: await db.pharmacyStockMovement.findMany({
          where: { inventoryLotId: lotId },
          orderBy: { disposition: 'asc' },
        }),
        onHand: await deps.ledger.onHand(db, f, f.medicineId, RECEIVED_AT),
      };
    });

    expect(result.balances).toEqual({ AVAILABLE: 70, QUARANTINE: 30 });
    // Both postings are RECEIPT movements against the one lot: the rejected
    // units are on the books and counted, just not sellable.
    expect(result.movements.map((m) => [m.disposition, m.quantityUnits])).toEqual([
      ['AVAILABLE', 70],
      ['QUARANTINE', 30],
    ]);
    const quarantined = result.onHand.find((row) => row.onHandUnits === 30);
    expect(quarantined).toMatchObject({ disposition: 'QUARANTINE', blockedBy: 'QUARANTINED' });
  });

  it('posts a wholly rejected delivery to QUARANTINE with nothing available', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'allreject');
    const balances = await inOrg(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'allreject', {
        line: { receivedPacks: 4, bonusPacks: 0, rejectedCanonicalUnits: 40 },
      });
      const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      return balancesFor(db, ORG_A, posted.lines[0]!.inventoryLotId);
    });
    expect(balances).toEqual({ QUARANTINE: 40 });
  });

  it('refuses to send rejected goods to a location that is not quarantine or returns', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'badquar');
    const receipt = await inOrg(ORG_A, (db) => draftReceipt(db, f, 'badquar'));
    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyGoodsReceiptLine.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          goodsReceiptId: receipt.id,
          lineNumber: 2,
          medicineId: f.medicineId,
          packLevelId: f.packLevelId,
          batchNumber: 'B-BADQUAR',
          printedExpiry: EXPIRY,
          expiryPrecision: 'DAY',
          printedMrpMinor: 25_000,
          canonicalUnitsPerPack: 10,
          receivedPacks: 1,
          bonusPacks: 0,
          receivedCanonicalUnits: 10,
          bonusCanonicalUnits: 0,
          acceptedCanonicalUnits: 5,
          rejectedCanonicalUnits: 5,
          rejectionReason: 'Damaged',
          invoicedPricePerPackMinor: 10_000,
          unitCostMinor: 1_000,
          stockLocationId: f.storeId,
          // The dispensing shelf, dressed up as a quarantine destination.
          quarantineLocationId: f.storeId,
        },
      })
    );
    expect(message).toContain('quarantine or returns location');
  });

  it('refuses rejected units with no reason and no destination', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'noreason');
    const receipt = await inOrg(ORG_A, (db) => draftReceipt(db, f, 'noreason'));
    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyGoodsReceiptLine.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          goodsReceiptId: receipt.id,
          lineNumber: 2,
          medicineId: f.medicineId,
          packLevelId: f.packLevelId,
          batchNumber: 'B-NOREASON',
          printedExpiry: EXPIRY,
          expiryPrecision: 'DAY',
          printedMrpMinor: 25_000,
          canonicalUnitsPerPack: 10,
          receivedPacks: 1,
          bonusPacks: 0,
          receivedCanonicalUnits: 10,
          bonusCanonicalUnits: 0,
          acceptedCanonicalUnits: 5,
          rejectedCanonicalUnits: 5,
          invoicedPricePerPackMinor: 10_000,
          unitCostMinor: 1_000,
          stockLocationId: f.storeId,
        },
      })
    );
    expect(message).not.toContain('ACCEPTED');
  });

  it('refuses a split that loses or invents a unit', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'split');
    const receipt = await inOrg(ORG_A, (db) => draftReceipt(db, f, 'split'));
    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyGoodsReceiptLine.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          goodsReceiptId: receipt.id,
          lineNumber: 2,
          medicineId: f.medicineId,
          packLevelId: f.packLevelId,
          batchNumber: 'B-SPLIT',
          printedExpiry: EXPIRY,
          expiryPrecision: 'DAY',
          printedMrpMinor: 25_000,
          canonicalUnitsPerPack: 10,
          receivedPacks: 10,
          bonusPacks: 0,
          receivedCanonicalUnits: 100,
          bonusCanonicalUnits: 0,
          // 90 + 5 is not the 100 that arrived.
          acceptedCanonicalUnits: 90,
          rejectedCanonicalUnits: 5,
          rejectionReason: 'Damaged',
          invoicedPricePerPackMinor: 10_000,
          unitCostMinor: 1_000,
          stockLocationId: f.storeId,
          quarantineLocationId: f.quarantineId,
        },
      })
    );
    expect(message).not.toContain('ACCEPTED');
  });
});

describeIfDatabase('PUR-04 — exceptions remain visible until resolved', () => {
  it('raises a shortage, a price conflict and damage from one bad delivery', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'exceptions');
    const raised = await inOrg(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'exceptions', {
        line: {
          // Receive the promised bonus so only the paid quantity is short.
          receivedPacks: 6,
          bonusPacks: 2,
          rejectedCanonicalUnits: 10,
          invoicedPricePerPackMinor: 12_000,
        },
      });
      await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      return deps.receipts.listReceivingExceptions(db, f, { goodsReceiptId: drafted.id });
    });
    expect(raised.map((exception) => exception.kind)).toEqual([
      'SHORTAGE',
      'DAMAGE',
      'PRICE_CONFLICT',
    ]);
    // Ordered 100 + 20 free; 80 arrived.
    expect(raised[0]).toMatchObject({ status: 'OPEN', expectedUnits: 120, observedUnits: 80 });
    expect(raised[2]).toMatchObject({ expectedMinor: 10_000, observedMinor: 12_000 });
  });

  it('keeps an exception in the open queue until it is resolved with an actor and a note', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'resolve');
    const journey = await inOrg(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'resolve', {
        // Isolate the paid shortage that this case resolves.
        line: { receivedPacks: 5, bonusPacks: 2 },
      });
      const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      const before = await deps.receipts.listReceivingExceptions(db, f, {
        goodsReceiptId: drafted.id,
      });
      const resolved = await deps.receipts.resolveReceivingException(db, scopeOf(f), {
        receivingExceptionId: posted.exceptions[0]!.id,
        resolutionNote: 'Supplier confirmed the balance ships next week.',
        at: RECEIVED_AT,
      });
      return {
        before,
        resolved,
        stillOpen: await deps.receipts.listReceivingExceptions(db, f, {
          goodsReceiptId: drafted.id,
        }),
      };
    });
    expect(journey.before).toHaveLength(1);
    expect(journey.resolved).toMatchObject({
      status: 'RESOLVED',
      resolvedByUserId: RECEIVER,
    });
    expect(journey.stillOpen).toEqual([]);
  });

  it('refuses to close an exception without an actor and a note', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'closeempty');
    const message = await expectRejection(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'closeempty', {
        line: { receivedPacks: 5, bonusPacks: 0 },
      });
      const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      return db.pharmacyReceivingException.update({
        where: { id: posted.exceptions[0]!.id },
        data: { status: 'RESOLVED', resolvedAt: RECEIVED_AT },
      });
    });
    expect(message).not.toContain('ACCEPTED');
  });

  it('refuses to rewrite a shortage into a smaller one on the way to closing it', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'rewrite');
    const message = await expectRejection(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'rewrite', {
        line: { receivedPacks: 5, bonusPacks: 0 },
      });
      const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      return db.pharmacyReceivingException.update({
        where: { id: posted.exceptions[0]!.id },
        data: { observedUnits: 120, detail: 'Nothing to see here.' },
      });
    });
    expect(message).toContain('only be resolved, not rewritten');
  });

  it('refuses to delete an exception rather than resolving it', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'delete-ex');
    const message = await expectRejection(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'delete-ex', {
        line: { receivedPacks: 5, bonusPacks: 0 },
      });
      const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      return db.pharmacyReceivingException.delete({ where: { id: posted.exceptions[0]!.id } });
    });
    expect(message).toContain('never hard-deleted');
  });
});

describeIfDatabase('PUR-04 — reversal creates linked movements and never edits', () => {
  async function controlledReceipt(
    label: string,
    line: LineOverrides,
    organizationId = ORG_A,
    branchId = BRANCH_A
  ) {
    const f = await fixture(organizationId, branchId, label);
    const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
    const pin = String(randomInt(100_000, 1_000_000));
    const credentialHash = await hashOperatorCredential('PIN', pin);
    // Commit the people and credential before reversal: its fresh witness PIN
    // is verified in an independent tenant transaction.
    const { actor, witness, staff, receipt } = await inOrg(organizationId, async (db) => {
      const department = await db.organizationDepartment.create({
        data: { organizationId: organizationId, key: tag('controlled'), name: tag('Pharmacy') },
      });
      async function member(capability: string) {
        const label = tag('pharmacist');
        return db.user.create({
          data: {
            organizationId: organizationId,
            name: label,
            email: `${label}@example.test`,
            department: department.key,
            title: 'Pharmacist',
            permissionOverrides: {
              create: {
                organizationId: organizationId,
                capability,
                effect: 'ALLOW',
                reason: 'Test fixture',
              },
            },
          },
        });
      }
      const actor = await member('pharmacy:safety');
      await db.userPermissionOverride.create({
        data: {
          organizationId: organizationId,
          userId: actor.id,
          capability: 'pharmacy:dispense',
          effect: 'ALLOW',
          reason: 'Test fixture',
        },
      });
      const witness = await member('pharmacy:dispense');
      await db.pharmacyBranchAssignment.create({
        data: { organizationId: organizationId, branchId: branchId, userId: actor.id },
      });
      const staff = await db.restaurantStaffProfile.create({
        data: {
          organizationId: organizationId,
          userId: witness.id,
          displayName: witness.name,
          credentials: { create: { organizationId: organizationId, type: 'PIN', credentialHash } },
        },
      });
      await db.medicine.update({ where: { id: f.medicineId }, data: { controlled: true } });
      const receipt = await draftReceipt(db, f, label, { line });
      await db.pharmacyGoodsReceipt.update({
        where: { id: receipt.id },
        data: { qualifiedPersonUserId: witness.id },
      });
      return { actor, witness, staff, receipt };
    });
    const scope = { ...scopeOf(f), actorId: actor.id };
    const posted = await inOrg(organizationId, (db) =>
      deps.receipts.postGoodsReceipt(db, scope, {
        goodsReceiptId: receipt.id,
        at: RECEIVED_AT,
        staffProfileId: staff.id,
        pin,
      })
    );
    const lotId = posted.lines[0]!.inventoryLotId;
    async function snapshot() {
      return inOrg(organizationId, async (db) => ({
        entries: await db.pharmacyControlledRegisterEntry.findMany({
          where: { organizationId: organizationId, branchId: branchId, inventoryLotId: lotId },
          orderBy: { serial: 'asc' },
        }),
        balances: await balancesFor(db, organizationId, lotId),
        sellable: await db.pharmacyStockBalance.aggregate({
          where: {
            organizationId: organizationId,
            branchId: branchId,
            inventoryLotId: lotId,
            disposition: 'AVAILABLE',
          },
          _sum: { onHandUnits: true },
        }),
      }));
    }
    return { f, actor, witness, staff, receipt, scope, posted, pin, lotId, snapshot };
  }

  it('keeps the controlled register equal to sellable stock after receiving and reversing (DEV-892)', async () => {
    const { actor, witness, staff, receipt, scope, posted, pin, snapshot } =
      await controlledReceipt('controlled-reverse', {
        receivedPacks: 10,
        bonusPacks: 2,
        rejectedCanonicalUnits: 30,
      });
    const received = await snapshot();
    expect(received.balances).toEqual({ AVAILABLE: 90, QUARANTINE: 30 });
    expect(received.entries).toHaveLength(1);
    expect(received.entries[0]).toMatchObject({
      entryKind: 'PURCHASE',
      stockMovementId: posted.lines[0]!.acceptedMovementId,
      quantityCanonicalUnits: 90,
      balanceDelta: 90,
      runningBalance: 90,
      recordedByUserId: actor.id,
      witnessedByUserId: witness.id,
    });
    expect(received.entries[0]!.runningBalance).toBe(received.sellable._sum.onHandUnits);

    const reversal = await inOrg(ORG_A, (db) =>
      deps.receipts.reverseGoodsReceipt(db, scope, {
        goodsReceiptId: receipt.id,
        reason: 'Wrong controlled consignment; returned to supplier.',
        at: RECEIVED_AT,
        controlledWitness: { staffProfileId: staff.id, pin },
      })
    );
    const reversed = await snapshot();
    expect(reversed.balances).toEqual({ AVAILABLE: 0, QUARANTINE: 0 });
    expect(reversed.entries).toHaveLength(2);
    expect(reversed.entries[0]).toEqual(received.entries[0]);
    expect(reversed.entries[1]).toMatchObject({
      entryKind: 'CORRECTION',
      correctsEntryId: received.entries[0]!.id,
      quantityCanonicalUnits: 0,
      balanceDelta: -90,
      runningBalance: 0,
      recordedByUserId: actor.id,
      witnessedByUserId: witness.id,
    });
    expect(reversal.reversalMovementIds).toContain(reversed.entries[1]!.restorationMovementId);
    expect(reversed.entries[1]!.runningBalance).toBe(reversed.sellable._sum.onHandUnits);

    await expect(
      inOrg(ORG_A, (db) =>
        deps.receipts.reverseGoodsReceipt(db, scope, {
          goodsReceiptId: receipt.id,
          reason: 'Retry reversal',
          at: RECEIVED_AT,
          controlledWitness: { staffProfileId: staff.id, pin },
        })
      )
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSITION' });
    expect(await snapshot()).toEqual(reversed);
  }, 30_000);

  it('keeps the controlled batch in balance after a sale, a refused reversal and supplier dispatch', async () => {
    const { f, actor, witness, staff, receipt, scope, pin, lotId, snapshot } =
      await controlledReceipt(
        'controlled-return',
        { receivedPacks: 10, bonusPacks: 0 },
        ORG_RETURN,
        BRANCH_RETURN
      );
    const { appendControlledSaleEntries } = await import('./controlled-register');
    const returns = await import('./supplier-returns-operations');
    const received = await snapshot();
    expect(received.balances.AVAILABLE).toBe(100);
    expect(received.entries.at(-1)?.runningBalance).toBe(received.balances.AVAILABLE);
    await inOrg(ORG_RETURN, async (db) => {
      const patient = await db.pharmacyPatient.create({
        data: { organizationId: ORG_RETURN, displayName: tag('patient') },
      });
      const prescriber = await db.pharmacyPrescriber.create({
        data: { organizationId: ORG_RETURN, name: tag('doctor'), registrationNumber: tag('reg') },
      });
      const pack = await db.packLevel.findUniqueOrThrow({ where: { id: f.packLevelId } });
      const rx = await db.prescription.create({
        data: {
          organizationId: ORG_RETURN,
          patientId: patient.id,
          prescriberId: prescriber.id,
          sourceKind: 'PAPER_IMAGE',
          sourceFileRef: tag('rx'),
          validFrom: RECEIVED_AT,
          validUntil: EXPIRY,
          capturedByUserId: actor.id,
          lines: {
            create: {
              lineNumber: 1,
              medicineId: f.medicineId,
              presentationId: pack.presentationId,
              authorizedCanonicalUnits: 20,
              directions: 'Test prescription',
            },
          },
        },
        include: { lines: true },
      });
      const sale = await deps.ledger.allocateForSale(db, scope, {
        medicineId: f.medicineId,
        requiredUnits: 20,
        at: RECEIVED_AT,
        idempotencyKeyPrefix: tag('sale'),
      });
      await appendControlledSaleEntries(db, {
        organizationId: ORG_RETURN,
        branchId: BRANCH_RETURN,
        movementIds: sale.movementIds,
        patientId: patient.id,
        patientAddress: 'Test address',
        medicineId: f.medicineId,
        manufacturer: null,
        prescriberId: prescriber.id,
        prescriberName: prescriber.name,
        prescriberRegNo: prescriber.registrationNumber,
        prescriptionId: rx.id,
        prescriptionLineId: rx.lines[0]!.id,
        emergency: false,
        rxSerialWritten: true,
        refEntryId: null,
        recordedByUserId: actor.id,
        witnessedByUserId: witness.id,
        signatureRef: tag('test-signature'),
      });
    });
    const sold = await snapshot();
    expect(sold.balances.AVAILABLE).toBe(80);
    expect(sold.entries.at(-1)?.runningBalance).toBe(sold.balances.AVAILABLE);
    await expect(
      inOrg(ORG_RETURN, (db) =>
        deps.receipts.reverseGoodsReceipt(db, scope, {
          goodsReceiptId: receipt.id,
          at: RECEIVED_AT,
          reason: 'Return the remainder',
          controlledWitness: { staffProfileId: staff.id, pin },
        })
      )
    ).rejects.toMatchObject({ reason: 'REVERSAL_STOCK_MOVED' });
    expect(await snapshot()).toEqual(sold);

    const document = await inOrg(ORG_RETURN, (db) =>
      returns.createPurchaseReturn(db, scope, {
        supplierId: f.supplierId,
        kind: 'PURCHASE_RETURN',
        reference: tag('return'),
        lines: [
          {
            inventoryLotId: lotId,
            stockLocationId: f.storeId,
            quantityUnits: 80,
            reason: 'Return remaining stock',
            returnWindowEndsAt: EXPIRY,
            expectedCreditMinor: 80000,
          },
        ],
      })
    );
    await inOrg(ORG_RETURN, (db) =>
      returns.submitPurchaseReturn(db, scope, { purchaseReturnId: document.id, at: RECEIVED_AT })
    );
    const dispatch = (
      sender: string,
      controlledWitness?: { staffProfileId: string; pin: string }
    ) =>
      inOrg(ORG_RETURN, (db) =>
        returns.dispatchPurchaseReturn(
          db,
          { ...scope, actorId: sender },
          {
            purchaseReturnId: document.id,
            at: RECEIVED_AT,
            idempotencyKeyPrefix: tag('dispatch'),
            controlledWitness,
          }
        )
      );
    const proof = { staffProfileId: staff.id, pin };
    await expect(dispatch(actor.id)).rejects.toThrow(/different pharmacist/);
    await expect(dispatch(witness.id, proof)).rejects.toThrow(/different pharmacist/);
    await expect(
      dispatch(actor.id, { ...proof, pin: pin === '111111' ? '222222' : '111111' })
    ).rejects.toThrow(/different pharmacist/);
    expect(
      await inOrg(ORG_RETURN, (db) =>
        db.restaurantOperatorCredential.findFirstOrThrow({
          where: { staffProfileId: staff.id },
          select: { failedAttempts: true },
        })
      )
    ).toEqual({ failedAttempts: 1 });
    expect(await snapshot()).toEqual(sold);
    // Force a transaction failure after both entries are visible, then read in a new transaction.
    await expect(
      inOrg(ORG_RETURN, async (db) => {
        await returns.dispatchPurchaseReturn(db, scope, {
          purchaseReturnId: document.id,
          at: RECEIVED_AT,
          idempotencyKeyPrefix: tag('rollback'),
          controlledWitness: proof,
        });
        const outgoing = await db.pharmacyControlledRegisterEntry.findFirstOrThrow({
          where: { supplierReturnLineId: document.lines[0]!.id },
        });
        expect(outgoing.balanceDelta).toBe(-80);
        expect((await balancesFor(db, ORG_RETURN, lotId)).AVAILABLE).toBe(0);
        throw new Error('fixture rollback');
      })
    ).rejects.toThrow('fixture rollback');
    expect(await snapshot()).toEqual(sold);
    // Enrol the independent witness before the real dispatch. The approved
    // code must be consumed once even when two submissions arrive together.
    const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
    await withPlatformDb((db) =>
      db.organization.update({
        where: { id: ORG_RETURN },
        data: { requireApprovalAuthenticator: true },
      })
    );
    const { encryptSecret } = await import('@/lib/secret-crypto');
    const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    await inOrg(ORG_RETURN, (db) =>
      db.approvalAuthenticator.create({
        data: {
          organizationId: ORG_RETURN,
          userId: witness.id,
          enabledAt: new Date(),
          encryptedSecret: encryptSecret(rfcSecret),
        },
      })
    );
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const mac = createHmac('sha1', '12345678901234567890').update(counter).digest();
    const code = String(
      (mac.readUInt32BE(mac[mac.length - 1]! & 15) & 0x7fffffff) % 1000000
    ).padStart(6, '0');
    const approval = { ...proof, pin: code };
    await Promise.all([dispatch(actor.id, approval), dispatch(actor.id, approval)]);
    const dispatched = await snapshot();
    expect(dispatched.balances.AVAILABLE).toBe(0);
    expect(dispatched.entries).toHaveLength(3);
    expect(dispatched.entries.slice(0, 2)).toEqual(sold.entries);
    expect(dispatched.entries[2]).toMatchObject({
      entryKind: 'RETURN_TO_SUPPLIER',
      recordedByUserId: actor.id,
      witnessedByUserId: witness.id,
      signatureRef: expect.stringMatching(/^authenticator:/),
      sourcePurchaseEntryId: received.entries[0]!.id,
      quantityCanonicalUnits: 80,
      balanceDelta: -80,
      runningBalance: dispatched.balances.AVAILABLE,
    });
    const out = await inOrg(ORG_RETURN, (db) =>
      db.pharmacyStockMovement.findUniqueOrThrow({
        where: { id: dispatched.entries[2]!.stockMovementId! },
      })
    );
    expect(out).toMatchObject({
      inventoryLotId: lotId,
      disposition: 'AVAILABLE',
      quantityUnits: -80,
      actorId: actor.id,
    });
    expect(dispatched.entries[2]!.counterpartyName).toBe(received.entries[0]!.counterpartyName);
    await dispatch(actor.id, approval);
    expect(await snapshot()).toEqual(dispatched);
  }, 30_000);

  it('adds a negating ADJUSTMENT per posting, linked to what it cancels', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'reverse');
    const result = await inOrg(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'reverse', {
        line: { receivedPacks: 10, bonusPacks: 0, rejectedCanonicalUnits: 30 },
      });
      const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      const lotId = posted.lines[0]!.inventoryLotId;
      const before = await db.pharmacyStockMovement.findMany({
        where: { inventoryLotId: lotId },
        orderBy: { idempotencyKey: 'asc' },
      });
      const reversal = await deps.receipts.reverseGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        reason: 'Wrong consignment; returned to the distributor.',
        at: RECEIVED_AT,
      });
      return {
        before,
        reversal,
        after: await db.pharmacyStockMovement.findMany({
          where: { inventoryLotId: lotId },
          orderBy: { idempotencyKey: 'asc' },
        }),
        balances: await balancesFor(db, ORG_A, lotId),
        receipt: await db.pharmacyGoodsReceipt.findFirstOrThrow({ where: { id: drafted.id } }),
      };
    });

    // Both original postings survive byte for byte; the reversal is additive.
    expect(result.after).toHaveLength(4);
    for (const original of result.before) {
      expect(result.after.find((movement) => movement.id === original.id)).toEqual(original);
    }
    const reversals = result.after.filter((movement) => movement.reversesMovementId !== null);
    expect(reversals).toHaveLength(2);
    expect(reversals.map((movement) => [movement.kind, movement.quantityUnits]).sort()).toEqual([
      ['ADJUSTMENT', -30],
      ['ADJUSTMENT', -70],
    ]);
    expect(new Set(reversals.map((movement) => movement.reversesMovementId))).toEqual(
      new Set(result.before.map((movement) => movement.id))
    );
    expect(result.balances).toEqual({ AVAILABLE: 0, QUARANTINE: 0 });
    expect(result.receipt).toMatchObject({
      status: 'REVERSED',
      reversedByUserId: RECEIVER,
      reversalReason: 'Wrong consignment; returned to the distributor.',
    });
  });

  it('refuses to reverse the same receipt twice', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'twice');
    const message = await expectRejection(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'twice', {
        line: { receivedPacks: 2, bonusPacks: 0 },
      });
      await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      await deps.receipts.reverseGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        reason: 'First reversal.',
        at: RECEIVED_AT,
      });
      return deps.receipts.reverseGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        reason: 'Second reversal.',
        at: RECEIVED_AT,
      });
    });
    expect(message).toContain('INVALID_TRANSITION');
  });

  it('refuses a reversal once the stock has been sold, instead of going negative', async () => {
    // §8A invariant 6. The paperwork cannot be undone after the goods have left
    // the shelf; the operator has to write off or return instead.
    const f = await fixture(ORG_A, BRANCH_A, 'sold');
    const message = await expectRejection(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'sold', {
        line: { receivedPacks: 2, bonusPacks: 0 },
      });
      await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      await deps.ledger.allocateForSale(db, scopeOf(f), {
        medicineId: f.medicineId,
        requiredUnits: 20,
        at: RECEIVED_AT,
        idempotencyKeyPrefix: `sale-${tag('sold')}`,
      });
      return deps.receipts.reverseGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        reason: 'Too late.',
        at: RECEIVED_AT,
      });
    });
    expect(message).toContain('REVERSAL_STOCK_MOVED');
  });

  it('refuses a compensating movement that is not the exact negation of its original', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'notnegation');
    const message = await expectRejection(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'notnegation', {
        line: { receivedPacks: 5, bonusPacks: 0 },
      });
      const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      const original = await db.pharmacyStockMovement.findFirstOrThrow({
        where: { id: posted.lines[0]!.acceptedMovementId! },
      });
      return db.pharmacyStockMovement.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          inventoryLotId: original.inventoryLotId,
          stockLocationId: original.stockLocationId,
          kind: 'ADJUSTMENT',
          disposition: 'AVAILABLE',
          // A partial "reversal" would silently write off the difference.
          quantityUnits: -10,
          sealedPackDelta: -1,
          looseUnitDelta: 0,
          actorId: RECEIVER,
          idempotencyKey: `bogus-${tag('notnegation')}`,
          reversesMovementId: original.id,
        },
      });
    });
    expect(message).toContain('exact negation');
  });

  it('refuses to edit or delete a posted receipt line', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'settled');
    const drafted = await inOrg(ORG_A, async (db) => {
      const receipt = await draftReceipt(db, f, 'settled', {
        line: { receivedPacks: 3, bonusPacks: 0 },
      });
      await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: receipt.id,
        at: RECEIVED_AT,
      });
      return receipt;
    });

    const edited = await expectRejection(ORG_A, (db) =>
      db.pharmacyGoodsReceiptLine.update({
        where: { id: drafted.lines[0]!.id },
        data: { receivedPacks: 99 },
      })
    );
    const deleted = await expectRejection(ORG_A, (db) =>
      db.pharmacyGoodsReceipt.delete({ where: { id: drafted.id } })
    );
    expect(edited).toContain('reverse the receipt instead');
    expect(deleted).toContain('never hard-deleted');
  });
});

// ── DEV-610 — reversal against a concurrent stock path ─────────────────────

describeIfDatabase('DEV-610 — a receipt reversal never deadlocks a concurrent stock path', () => {
  /** Wait until another backend is queued behind a lock that `holderPid` holds. */
  async function waitUntilBlockedBy(holderPid: number) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = await inOrg(
        ORG_A,
        (db) => db.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS "waiting" FROM pg_stat_activity
          WHERE ${holderPid}::int = ANY(pg_blocking_pids("pid"))`
      );
      if ((row?.waiting ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error('the reversal never queued behind the held lock');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('locks its balances in the global order, so two concurrent transactions both commit', async () => {
    // A line with rejected units posts two movements into one lot: accepted
    // units at the store, rejected units at quarantine. The reversal writes
    // them in idempotency-key order (accepted first), while the global lock
    // order (stock-lock-order.ts) sorts balances by location id. Pinning the
    // store's id above quarantine's makes the two orders disagree: a reversal
    // that locked each balance as it wrote it would take the store balance,
    // then queue for quarantine, while the other transaction holds quarantine
    // and queues for the store — a deadlock Postgres breaks by aborting one.
    const label = 'deadlock';
    const f = await fixture(ORG_A, BRANCH_A, label, false, {
      storeId: `loc_z_store_${suffix}`,
      quarantineId: `loc_a_quarantine_${suffix}`,
    });
    const { receipt, lotId } = await inOrg(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, label, {
        line: { receivedPacks: 10, bonusPacks: 0, rejectedCanonicalUnits: 30 },
      });
      const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      return { receipt: drafted, lotId: posted.lines[0]!.inventoryLotId };
    });
    const receiptMovements = await inOrg(ORG_A, (db) =>
      db.pharmacyStockMovement.findMany({
        where: { organizationId: ORG_A, inventoryLotId: lotId, kind: 'RECEIPT' },
        orderBy: { idempotencyKey: 'asc' },
        select: { inventoryLotId: true, stockLocationId: true, disposition: true },
      })
    );

    // Preconditions that keep this case able to fail: the reversal's write
    // order is the opposite of the global lock order.
    expect(receiptMovements.map((movement) => movement.stockLocationId)).toEqual([
      f.storeId,
      f.quarantineId,
    ]);
    const [low, high] = [...receiptMovements].sort(deps.locks.compareBalanceLockKeys);
    expect([low!.stockLocationId, high!.stockLocationId]).toEqual([f.quarantineId, f.storeId]);

    let releaseLow!: () => void;
    const holdLow = new Promise<void>((resolve) => {
      releaseLow = resolve;
    });
    let lowLocked!: (pid: number) => void;
    let lowFailed!: (error: unknown) => void;
    const hasLow = new Promise<number>((resolve, reject) => {
      lowLocked = resolve;
      lowFailed = reject;
    });

    // The concurrent stock path follows the global order through the shared
    // lock module, as every path does: the low balance, then the high one.
    const otherPath = inOrg(ORG_A, async (db) => {
      const [backend] = await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS "pid"`;
      await deps.locks.lockStockBalances(db, scopeOf(f), [low!]);
      lowLocked(backend!.pid);
      await holdLow;
      await deps.locks.lockStockBalances(db, scopeOf(f), [high!]);
      return 'committed';
    });
    // A failure before the low lock is held must fail the case, not hang it.
    otherPath.catch(lowFailed);
    const otherPid = await hasLow;

    const reversal = inOrg(ORG_A, (db) =>
      deps.receipts.reverseGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: receipt.id,
        reason: 'Wrong consignment; returned to the distributor.',
        at: RECEIVED_AT,
      })
    );

    // Only once the reversal is queued behind the low balance does the other
    // path ask for the high one: that is the interleaving that deadlocks when
    // the reversal already holds the high balance.
    let queued: unknown = null;
    try {
      await waitUntilBlockedBy(otherPid);
    } catch (error) {
      queued = error;
    } finally {
      releaseLow();
    }
    const outcomes = await Promise.allSettled([otherPath, reversal]);
    expect(queued).toBeNull();
    expect(
      outcomes.map((outcome) =>
        outcome.status === 'fulfilled' ? 'committed' : (outcome.reason as Error).message
      )
    ).toEqual(['committed', 'committed']);

    const after = await inOrg(ORG_A, async (db) => ({
      receipt: await db.pharmacyGoodsReceipt.findFirstOrThrow({ where: { id: receipt.id } }),
      balances: await balancesFor(db, ORG_A, lotId),
    }));
    expect(after.receipt.status).toBe('REVERSED');
    expect(after.balances).toEqual({ AVAILABLE: 0, QUARANTINE: 0 });
  });
});

// ── PUR-05 — the direct purchase path ───────────────────────────────────────

describeIfDatabase('PUR-05 — direct purchase, same validation and same postings', () => {
  it('posts a receipt with no purchase order exactly as the PO path does', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'direct');
    const result = await inOrg(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'direct', {
        direct: true,
        line: { receivedPacks: 10, bonusPacks: 2 },
      });
      const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      const lotId = posted.lines[0]!.inventoryLotId;
      return {
        posted,
        balances: await balancesFor(db, ORG_A, lotId),
        movements: await db.pharmacyStockMovement.findMany({ where: { inventoryLotId: lotId } }),
        lot: await db.pharmacyInventoryLot.findFirstOrThrow({ where: { id: lotId } }),
        receipt: await db.pharmacyGoodsReceipt.findFirstOrThrow({ where: { id: drafted.id } }),
      };
    });

    // Byte-for-byte the same posting shape as the PO case above: one lot, one
    // RECEIPT of 120 AVAILABLE units, the same batch/MRP/pack evidence.
    expect(result.balances).toEqual({ AVAILABLE: 120 });
    expect(result.movements).toHaveLength(1);
    expect(result.movements[0]).toMatchObject({
      kind: 'RECEIPT',
      disposition: 'AVAILABLE',
      quantityUnits: 120,
      sealedPackDelta: 12,
    });
    expect(result.lot).toMatchObject({ unitsPerPack: 10, printedMrpMinor: 25_000 });
    expect(result.receipt).toMatchObject({
      status: 'POSTED',
      directPurchase: true,
      purchaseOrderId: null,
      bypassApprovedByUserId: APPROVER,
    });
    // No order means no quantity or price to match against, so nothing is
    // invented; damage would still be raised on this path.
    expect(result.posted.exceptions).toEqual([]);
  });

  it('applies the same fail-closed supplier rule to the direct path', async () => {
    // The identical scenario to the PO case above, refused for the identical
    // reason: skipping the order does not skip the supplier check.
    const f = await fixture(ORG_A, BRANCH_A, 'direct-unauth');
    const message = await expectRejection(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'direct-unauth', { direct: true });
      await db.pharmacySupplier.update({
        where: { id: f.supplierId },
        data: { authorized: false },
      });
      return deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
    });
    expect(message).toContain('SUPPLIER_NOT_AUTHORIZED');
  });

  it('still raises damage for goods rejected on the direct path', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'direct-damage');
    const raised = await inOrg(ORG_A, async (db) => {
      const drafted = await draftReceipt(db, f, 'direct-damage', {
        direct: true,
        line: { receivedPacks: 5, bonusPacks: 0, rejectedCanonicalUnits: 20 },
      });
      const posted = await deps.receipts.postGoodsReceipt(db, scopeOf(f), {
        goodsReceiptId: drafted.id,
        at: RECEIVED_AT,
      });
      return posted.exceptions;
    });
    expect(raised.map((exception) => exception.kind)).toEqual(['DAMAGE']);
  });

  /** A well-formed PUR-05 header, before a case breaks one thing about it. */
  function directHeader(f: Fixture, label: string) {
    return {
      organizationId: ORG_A,
      branchId: BRANCH_A,
      reference: `GRN-${tag(label)}`,
      supplierId: f.supplierId,
      purchaseOrderId: null as string | null,
      supplierInvoiceRef: `INV-${tag(label)}`,
      supplierInvoiceDate: RECEIVED_AT,
      warrantyEvidenceRef: 'WARRANTY-BAD',
      receivedByUserId: RECEIVER,
      receivedAt: RECEIVED_AT,
      directPurchase: true,
      bypassReason: 'Emergency purchase.' as string | null,
      bypassApprovedByUserId: APPROVER as string | null,
      bypassApprovedAt: RECEIVED_AT as Date | null,
    };
  }

  it('refuses a direct receipt with no bypass reason and no approver', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'direct-nobypass');
    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyGoodsReceipt.create({
        data: {
          ...directHeader(f, 'direct-nobypass'),
          bypassReason: null,
          bypassApprovedByUserId: null,
          bypassApprovedAt: null,
        },
      })
    );
    expect(message).not.toContain('ACCEPTED');
  });

  it('refuses a bypass the receiver approved for themselves', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'direct-self');
    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyGoodsReceipt.create({
        data: { ...directHeader(f, 'direct-self'), bypassApprovedByUserId: RECEIVER },
      })
    );
    expect(message).not.toContain('ACCEPTED');
  });

  it('refuses a receipt that claims a bypass and a purchase order at once', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'direct-both');
    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyGoodsReceipt.create({
        data: { ...directHeader(f, 'direct-both'), purchaseOrderId: f.purchaseOrderId },
      })
    );
    expect(message).not.toContain('ACCEPTED');
  });

  it('refuses a PO receipt that smuggles in a bypass reason', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'smuggle');
    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyGoodsReceipt.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          reference: `GRN-${tag('smuggle')}`,
          supplierId: f.supplierId,
          purchaseOrderId: f.purchaseOrderId,
          supplierInvoiceRef: `INV-${tag('smuggle')}`,
          supplierInvoiceDate: RECEIVED_AT,
          warrantyEvidenceRef: 'WARRANTY-SMUGGLE',
          receivedByUserId: RECEIVER,
          receivedAt: RECEIVED_AT,
          directPurchase: false,
          bypassReason: 'No approval needed, honest.',
        },
      })
    );
    expect(message).not.toContain('ACCEPTED');
  });

  it('refuses a second receipt for the same supplier invoice', async () => {
    const f = await fixture(ORG_A, BRANCH_A, 'dupinvoice');
    const invoice = `INV-DUP-${tag('dupinvoice')}`;
    const message = await expectRejection(ORG_A, async (db) => {
      for (const label of ['one', 'two']) {
        await db.pharmacyGoodsReceipt.create({
          data: {
            organizationId: ORG_A,
            branchId: BRANCH_A,
            reference: `GRN-${tag(`dup-${label}`)}`,
            supplierId: f.supplierId,
            purchaseOrderId: f.purchaseOrderId,
            supplierInvoiceRef: invoice,
            supplierInvoiceDate: RECEIVED_AT,
            warrantyEvidenceRef: 'WARRANTY-DUP',
            receivedByUserId: RECEIVER,
            receivedAt: RECEIVED_AT,
          },
        });
      }
      return null;
    });
    expect(message).not.toContain('ACCEPTED');
  });
});
