import { beforeEach, describe, expect, it, vi } from 'vitest';

const receiveLot = vi.hoisted(() => vi.fn());

vi.mock('./finance-postings', () => ({ postGoodsReceiptEntry: vi.fn() }));

vi.mock('./stock-ledger', async () => {
  const actual = await vi.importActual<typeof import('./stock-ledger')>('./stock-ledger');
  return { ...actual, receiveLot };
});

import { postGoodsReceipt } from './goods-receipt';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const AT = new Date('2026-10-21T00:00:00.000Z');
const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' };

function receiptDb(line: {
  accepted: number;
  rejected: number;
  expiry: string;
  precision?: 'DAY' | 'MONTH';
  warnings?: string[];
  purchaseOrderStatus?: 'DRAFT' | 'SENT' | 'RECEIVING';
  purchaseOrderBranchId?: string | null;
  purchaseOrderSupplierId?: string;
}) {
  const batchFind = vi.fn().mockResolvedValue(null);
  const lineUpdate = vi.fn().mockResolvedValue({});
  const db = {
    $queryRaw: vi.fn().mockImplementation((query: TemplateStringsArray) => {
      const sql = query.join('');
      if (sql.includes('pharmacy_purchase_orders')) {
        return Promise.resolve(
          line.purchaseOrderStatus
            ? [
                {
                  id: 'po',
                  branchId:
                    line.purchaseOrderBranchId === undefined
                      ? 'branch_a'
                      : line.purchaseOrderBranchId,
                  supplierId: line.purchaseOrderSupplierId ?? 'supplier_a',
                  status: line.purchaseOrderStatus,
                },
              ]
            : []
        );
      }
      return Promise.resolve([{ id: 'gr' }]);
    }),
    medicine: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyGoodsReceipt: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'gr',
        organizationId: 'org_a',
        branchId: 'branch_a',
        status: 'DRAFT',
        supplierInvoiceRef: 'INV',
        warrantyEvidenceRef: 'WAR',
        supplierId: 'supplier_a',
        purchaseOrderId: line.purchaseOrderStatus ? 'po' : null,
        purchaseOrder: line.purchaseOrderStatus
          ? {
              id: 'po',
              branchId:
                line.purchaseOrderBranchId === undefined ? 'branch_a' : line.purchaseOrderBranchId,
              status: line.purchaseOrderStatus,
            }
          : null,
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
            ocrFieldEvidence: null,
            batchNumber: 'B',
            printedExpiry: new Date(`${line.expiry}T00:00:00.000Z`),
            canonicalUnitsPerPack: 10,
            printedMrpMinor: 100,
            acceptedCanonicalUnits: line.accepted,
            rejectedCanonicalUnits: line.rejected,
            gs1Warnings: line.warnings ?? [],
            expiryPrecision: line.precision ?? 'DAY',
            medicineId: 'med',
            packLevelId: 'pack',
            stockLocationId: 'loc',
            unitCostMinor: 10,
            lineNumber: 1,
            receivedCanonicalUnits: line.accepted + line.rejected,
            bonusCanonicalUnits: 0,
            invoicedPricePerPackMinor: 100,
            purchaseOrderLineId: null,
            quarantineLocationId: line.rejected > 0 ? 'quar' : null,
            rejectionReason: line.rejected > 0 ? 'Expired' : null,
          },
        ],
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyManufacturingBatch: {
      findFirst: batchFind,
      create: vi.fn().mockResolvedValue({ id: 'batch' }),
    },
    pharmacyGoodsReceiptLine: { update: lineUpdate },
    pharmacyReceivingException: {
      create: vi.fn().mockResolvedValue({ id: 'ex', kind: 'DAMAGE', detail: '' }),
    },
    pharmacyPurchaseOrder: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  return {
    db: db as unknown as ScopedDb,
    batchFind,
    batchCreate: db.pharmacyManufacturingBatch.create,
    lineUpdate,
  };
}

beforeEach(() => {
  receiveLot.mockReset().mockResolvedValue({
    lot: { id: 'lot' },
    movement: { id: 'move' },
    quarantineMovement: null,
  } as never);
});

describe('postGoodsReceipt expiry', () => {
  it.each(['SENT', 'RECEIVING'] as const)(
    'posts a receipt for a %s organization-wide purchase order',
    async (purchaseOrderStatus) => {
      const { db } = receiptDb({
        accepted: 10,
        rejected: 0,
        expiry: '2027-12-31',
        purchaseOrderStatus,
        purchaseOrderBranchId: null,
      });

      await expect(
        postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT })
      ).resolves.toMatchObject({ goodsReceiptId: 'gr' });
      expect(receiveLot).toHaveBeenCalledWith(db, SCOPE, expect.any(Object));
    }
  );

  it('refuses to post an existing draft against an order that was never sent', async () => {
    const { db, batchFind } = receiptDb({
      accepted: 10,
      rejected: 0,
      expiry: '2027-12-31',
      purchaseOrderStatus: 'DRAFT',
    });
    await expect(
      postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT })
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSITION' });
    expect(batchFind).not.toHaveBeenCalled();
    expect(receiveLot).not.toHaveBeenCalled();
  });

  it('allows a subsequent receipt while the linked order is receiving', async () => {
    const { db } = receiptDb({
      accepted: 10,
      rejected: 0,
      expiry: '2027-12-31',
      purchaseOrderStatus: 'RECEIVING',
    });

    await expect(
      postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT })
    ).resolves.toMatchObject({ goodsReceiptId: 'gr' });
    expect(db.pharmacyPurchaseOrder.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to post an existing draft against another branch's order", async () => {
    const { db, batchFind } = receiptDb({
      accepted: 10,
      rejected: 0,
      expiry: '2027-12-31',
      purchaseOrderStatus: 'SENT',
      purchaseOrderBranchId: 'branch_b',
    });
    await expect(
      postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT })
    ).rejects.toMatchObject({ reason: 'CROSS_BRANCH_REFERENCE' });
    expect(batchFind).not.toHaveBeenCalled();
    expect(receiveLot).not.toHaveBeenCalled();
  });

  it('refuses to post when the linked order belongs to another supplier', async () => {
    const { db, batchFind } = receiptDb({
      accepted: 10,
      rejected: 0,
      expiry: '2027-12-31',
      purchaseOrderStatus: 'SENT',
      purchaseOrderSupplierId: 'supplier_b',
    });
    await expect(
      postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT })
    ).rejects.toMatchObject({ reason: 'CROSS_TENANT_REFERENCE' });
    expect(batchFind).not.toHaveBeenCalled();
    expect(receiveLot).not.toHaveBeenCalled();
  });

  it.each([
    ['DAY', '2027-06-16T00:00:00.000Z', '2027-06-15T19:00:00.000Z'],
    ['DAY', '2027-06-15T19:00:00.000Z', '2027-06-15T19:00:00.000Z'],
    ['MONTH', '2027-07-01T00:00:00.000Z', '2027-06-30T19:00:00.000Z'],
    ['MONTH', '2027-06-30T19:00:00.000Z', '2027-06-30T19:00:00.000Z'],
  ] as const)('joins a %s receipt to an existing batch at %s', async (precision, stored, pkt) => {
    const { db, batchFind, batchCreate } = receiptDb({
      accepted: 10,
      rejected: 0,
      expiry: '2027-06-15',
      precision,
    });
    batchFind.mockResolvedValue({ id: 'existing_batch', expiresAt: new Date(stored) });

    const posted = await postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT });

    expect(posted.lines).toHaveLength(1);
    expect(batchCreate).not.toHaveBeenCalled();
    expect(receiveLot).toHaveBeenCalledWith(
      db,
      SCOPE,
      expect.objectContaining({
        manufacturingBatchId: 'existing_batch',
        receivedExpiresAt: new Date(pkt),
        receivedExpiryPrecision: precision,
        quantityUnits: 10,
      })
    );
  });

  it.each([
    ['DAY', '2027-06-17T00:00:00.000Z'],
    ['MONTH', '2027-07-02T00:00:00.000Z'],
    ['DAY', '2027-06-15T19:00:00.001Z'],
  ] as const)('refuses a conflicting %s batch expiry at %s', async (precision, stored) => {
    const { db, batchFind, batchCreate } = receiptDb({
      accepted: 10,
      rejected: 0,
      expiry: '2027-06-15',
      precision,
    });
    batchFind.mockResolvedValue({ id: 'existing_batch', expiresAt: new Date(stored) });

    await expect(
      postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT })
    ).rejects.toMatchObject({ reason: 'BATCH_EXPIRY_CONFLICT' });
    expect(batchCreate).not.toHaveBeenCalled();
    expect(receiveLot).not.toHaveBeenCalled();
  });

  it('does not put accepted units of an expired pack into stock', async () => {
    const { db, batchFind } = receiptDb({ accepted: 10, rejected: 0, expiry: '2025-12-31' });
    await expect(
      postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT })
    ).rejects.toMatchObject({ reason: 'EXPIRED_PACK' });
    expect(batchFind).not.toHaveBeenCalled();
    expect(receiveLot).not.toHaveBeenCalled();
  });

  it('posts a fully rejected expired pack into quarantine', async () => {
    const { db } = receiptDb({ accepted: 0, rejected: 10, expiry: '2025-12-31' });
    await postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT });
    expect(receiveLot).toHaveBeenCalledWith(
      db,
      SCOPE,
      expect.objectContaining({
        quantityUnits: 0,
        quarantine: expect.objectContaining({ units: 10, stockLocationId: 'quar' }),
      })
    );
  });

  it('records a near-expiry warning while the accepted units stay receivable', async () => {
    const { db, lineUpdate } = receiptDb({ accepted: 10, rejected: 0, expiry: '2026-11-30' });
    await postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr', at: AT });
    expect(receiveLot).toHaveBeenCalledWith(
      db,
      SCOPE,
      expect.objectContaining({ quantityUnits: 10 })
    );
    expect(lineUpdate).toHaveBeenCalledWith({
      where: { id: 'line' },
      data: { inventoryLotId: 'lot', gs1Warnings: ['NEAR_EXPIRY'] },
    });
  });
});
