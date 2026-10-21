import { beforeEach, describe, expect, it, vi } from 'vitest';

const receiveLot = vi.hoisted(() => vi.fn());

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
  warnings?: string[];
}) {
  const batchFind = vi.fn().mockResolvedValue(null);
  const lineUpdate = vi.fn().mockResolvedValue({});
  const db = {
    medicine: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyGoodsReceipt: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'gr',
        organizationId: 'org_a',
        branchId: 'branch_a',
        status: 'DRAFT',
        supplierInvoiceRef: 'INV',
        warrantyEvidenceRef: 'WAR',
        purchaseOrderId: null,
        supplier: {
          name: 'Supplier',
          authorized: true,
          licences: [
            {
              issuedAt: new Date('2020-01-01T00:00:00.000Z'),
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
            expiryPrecision: 'DAY',
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
  };
  return { db: db as unknown as ScopedDb, batchFind, lineUpdate };
}

beforeEach(() => {
  receiveLot.mockReset().mockResolvedValue({
    lot: { id: 'lot' },
    movement: { id: 'move' },
    quarantineMovement: null,
  } as never);
});

describe('postGoodsReceipt expiry', () => {
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
