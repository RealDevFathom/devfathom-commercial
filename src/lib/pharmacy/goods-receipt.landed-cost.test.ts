/**
 * PUR-03 at posting: a draft's order-charge share is a preview. Posting settles
 * it again under the order's row lock from the receipts that have actually
 * posted, and moves the stamped unit cost by the difference only, so drafts made
 * side by side cannot both capitalise an order line's freight, a draft that
 * never posts cannot strand it, and nothing else inside the stamped cost moves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const receiveLot = vi.hoisted(() => vi.fn());

vi.mock('./stock-ledger', async () => {
  const actual = await vi.importActual<typeof import('./stock-ledger')>('./stock-ledger');
  return { ...actual, receiveLot };
});

// FIN-01 journals the posted receipt; the journal itself is covered elsewhere.
const finance = vi.hoisted(() => ({ postGoodsReceiptEntry: vi.fn() }));
vi.mock('./finance-postings', async () => ({
  ...(await vi.importActual<typeof import('./finance-postings')>('./finance-postings')),
  ...finance,
}));

import { postGoodsReceipt } from './goods-receipt';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const AT = new Date('2026-10-21T00:00:00.000Z');
const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' };

/** Ten 10-unit packs at 1_000 each, with a 10% rebate. */
const ORDER_LINE = {
  id: 'pol',
  medicineId: 'med',
  packLevelId: 'pack',
  orderedPacks: 10,
  bonusPacks: 0,
  canonicalUnitsPerPack: 10,
  orderedCanonicalUnits: 100,
  bonusCanonicalUnits: 0,
  listPricePerPackMinor: 1_000,
  discountBps: 0,
  rebateBps: 1_000,
  taxBps: 0,
  taxCreditable: false,
};

function receiptDb(input: {
  freightMinor: number;
  /** Paid units on other receipts against the order line, by their status. */
  earlier?: Array<{ status: 'DRAFT' | 'POSTED'; receivedCanonicalUnits: number }>;
  /** The cost the draft was stamped with when it was created. */
  stampedUnitCostMinor: number;
  /** The order-charge share the draft was stamped with. */
  stampedOrderChargeMinor: number;
  /** Freight the receipt's own supplier invoice billed (DEV-77). */
  receiptFreightMinor?: number;
}) {
  const earlier = input.earlier ?? [];
  const lineUpdate = vi.fn().mockResolvedValue({});
  const receiptLineFindMany = vi.fn(
    ({
      where,
    }: {
      where: {
        purchaseOrderLineId: string | { in: string[] };
        goodsReceipt: { status: string };
      };
    }) =>
      Promise.resolve(
        earlier
          .filter((line) => line.status === where.goodsReceipt.status)
          .map((line) => ({
            purchaseOrderLineId: 'pol',
            receivedCanonicalUnits: line.receivedCanonicalUnits,
            bonusCanonicalUnits: 0,
          }))
      )
  );
  const db = {
    $queryRaw: vi.fn((query: TemplateStringsArray) =>
      Promise.resolve(
        query.join('').includes('pharmacy_purchase_orders')
          ? [
              {
                id: 'po',
                branchId: 'branch_a',
                supplierId: 'supplier_a',
                status: 'RECEIVING',
                freightMinor: input.freightMinor,
                otherChargesMinor: 0,
              },
            ]
          : [{ id: 'gr' }]
      )
    ),
    medicine: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacySupplierLicence: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyGoodsReceipt: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'gr',
        organizationId: 'org_a',
        branchId: 'branch_a',
        status: 'DRAFT',
        reference: 'GRN-2',
        supplierInvoiceRef: 'INV',
        warrantyEvidenceRef: 'WAR',
        supplierId: 'supplier_a',
        purchaseOrderId: 'po',
        freightMinor: input.receiptFreightMinor ?? 0,
        receivedAt: AT,
        supplier: {
          name: 'Supplier',
          authorized: true,
          licences: [
            {
              expiresAt: new Date('2030-01-01T00:00:00.000Z'),
              verifiedAt: new Date('2020-01-01T00:00:00.000Z'),
            },
          ],
        },
        lines: [
          {
            id: 'line',
            lineNumber: 1,
            purchaseOrderLineId: 'pol',
            ocrFieldEvidence: null,
            medicineId: 'med',
            packLevelId: 'pack',
            batchNumber: 'B',
            printedExpiry: new Date('2028-12-31T00:00:00.000Z'),
            expiryPrecision: 'DAY',
            printedMrpMinor: 1_500,
            canonicalUnitsPerPack: 10,
            receivedPacks: 10,
            bonusPacks: 0,
            receivedCanonicalUnits: 100,
            bonusCanonicalUnits: 0,
            acceptedCanonicalUnits: 100,
            rejectedCanonicalUnits: 0,
            rejectionReason: null,
            invoicedPricePerPackMinor: 1_000,
            discountBps: 0,
            taxBps: 0,
            taxCreditable: false,
            unitCostMinor: input.stampedUnitCostMinor,
            allocatedOrderChargeMinor: input.stampedOrderChargeMinor,
            stockLocationId: 'loc',
            quarantineLocationId: null,
            gs1Warnings: [] as string[],
          },
        ],
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyManufacturingBatch: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'batch', expiresAt: new Date('2028-12-31') }),
    },
    pharmacyPurchaseOrderLine: {
      findMany: vi.fn().mockResolvedValue([ORDER_LINE]),
      findFirst: vi.fn().mockResolvedValue(ORDER_LINE),
    },
    pharmacyGoodsReceiptLine: { update: lineUpdate, findMany: receiptLineFindMany },
    pharmacyReceivingException: {
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'ex', ...data })),
    },
    pharmacyPurchaseOrder: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  return { db: db as unknown as ScopedDb, lineUpdate, receiptLineFindMany };
}

beforeEach(() => {
  finance.postGoodsReceiptEntry.mockReset().mockResolvedValue({ id: 'entry' });
  receiveLot.mockReset().mockResolvedValue({
    lot: { id: 'lot' },
    movement: { id: 'move' },
    quarantineMovement: null,
  } as never);
});

const postedCost = () => (receiveLot.mock.calls[0]![2] as { unitCostMinor: number }).unitCostMinor;

describe('postGoodsReceipt landed cost (PUR-03)', () => {
  it('posts the order rebate and the whole freight share for the first full delivery', async () => {
    // Drafted while another receipt held the share; that one never posted.
    const { db, lineUpdate } = receiptDb({
      freightMinor: 1_000,
      stampedUnitCostMinor: 90,
      stampedOrderChargeMinor: 0,
    });
    await postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT });
    // 10_000 − 10% rebate = 9_000, plus all 1_000 of freight, over 100 units.
    expect(postedCost()).toBe(100);
    expect(lineUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'line' },
        data: expect.objectContaining({ unitCostMinor: 100, allocatedOrderChargeMinor: 1_000 }),
      })
    );
  });

  it('re-prices a draft whose freight share another receipt already posted', async () => {
    // Both drafts were stamped with the full share; the other one posted first.
    const { db, receiptLineFindMany } = receiptDb({
      freightMinor: 1_000,
      earlier: [{ status: 'POSTED', receivedCanonicalUnits: 100 }],
      stampedUnitCostMinor: 100,
      stampedOrderChargeMinor: 1_000,
    });
    await postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT });
    // The freight is in stock once already: this lot carries only 9_000 / 100.
    expect(postedCost()).toBe(90);
    expect(receiptLineFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_a',
          purchaseOrderLineId: { in: ['pol'] },
          goodsReceipt: { status: 'POSTED' },
        }),
      })
    );
  });

  it('does not let an unposted draft strand the freight share', async () => {
    const { db } = receiptDb({
      freightMinor: 1_000,
      earlier: [{ status: 'DRAFT', receivedCanonicalUnits: 100 }],
      stampedUnitCostMinor: 90,
      stampedOrderChargeMinor: 0,
    });
    await postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT });
    expect(postedCost()).toBe(100);
  });

  it('keeps the stamped cost, and writes nothing, when posting agrees with the draft', async () => {
    const { db, lineUpdate } = receiptDb({
      freightMinor: 1_000,
      stampedUnitCostMinor: 100,
      stampedOrderChargeMinor: 1_000,
    });
    await postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT });
    expect(postedCost()).toBe(100);
    expect(lineUpdate.mock.calls[0]![0].data).not.toHaveProperty('unitCostMinor');
  });

  it('leaves a receipt that billed its own invoice freight without any order share', async () => {
    // Drafted at (9_000 + 500 invoice freight) / 100 with no order share.
    const { db, lineUpdate } = receiptDb({
      freightMinor: 1_000,
      receiptFreightMinor: 500,
      stampedUnitCostMinor: 95,
      stampedOrderChargeMinor: 0,
    });
    await postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT });
    expect(postedCost()).toBe(95);
    expect(lineUpdate.mock.calls[0]![0].data).not.toHaveProperty('unitCostMinor');
  });

  it('keeps any other charge already inside the stamped cost when the order share moves', async () => {
    // Stamped with the full order share plus 1_000 the receipt itself charged
    // (10 per unit); another receipt has since posted the order share.
    const { db } = receiptDb({
      freightMinor: 1_000,
      earlier: [{ status: 'POSTED', receivedCanonicalUnits: 100 }],
      stampedUnitCostMinor: 110,
      stampedOrderChargeMinor: 1_000,
    });
    await postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT });
    // Only the order share leaves: 110 − (100 − 90) = 100.
    expect(postedCost()).toBe(100);
  });
});
