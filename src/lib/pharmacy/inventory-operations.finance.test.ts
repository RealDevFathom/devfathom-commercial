/**
 * DEV-131 — stock operations journal their own value movement.
 *
 * An approved count variance, a dispatched transfer and a received transfer
 * each change stock; each must post its FIN-01 entry in the same transaction,
 * through the same database client, or GL inventory drifts from the stock
 * ledger. The adapters themselves are proved against a real database in
 * `finance-postings.db.test.ts`; this file proves the operations call them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const finance = vi.hoisted(() => ({
  postCountAdjustmentEntry: vi.fn(),
  postInterbranchTransferEntry: vi.fn(),
  postInterbranchTransferReceiptEntry: vi.fn(),
}));
vi.mock('./finance-postings', () => finance);

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { approveCount, dispatchTransfer, receiveTransferLine } from './inventory-operations';

const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' };
const APPROVED_AT = new Date('2026-11-01T10:00:00.000Z');
const DISPATCHED_AT = new Date('2026-11-01T11:00:00.000Z');
const RECEIVED_AT = new Date('2026-11-02T09:00:00.000Z');

beforeEach(() => {
  for (const adapter of Object.values(finance)) adapter.mockReset().mockResolvedValue(null);
});

describe('approveCount journals each variance', () => {
  function countDb() {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacyInventoryCount: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'count_1',
          status: 'OPEN',
          createdById: 'user_counter',
          lines: [
            {
              id: 'line_short',
              inventoryLotId: 'lot_1',
              stockLocationId: 'loc_1',
              varianceUnits: -5,
              countedSealedPacks: 2,
              countedLooseUnits: 5,
              expectedSealedPacks: 3,
              expectedLooseUnits: 0,
            },
            {
              id: 'line_exact',
              inventoryLotId: 'lot_2',
              stockLocationId: 'loc_1',
              varianceUnits: 0,
              countedSealedPacks: 1,
              countedLooseUnits: 0,
              expectedSealedPacks: 1,
              expectedLooseUnits: 0,
            },
            {
              id: 'line_over',
              inventoryLotId: 'lot_3',
              stockLocationId: 'loc_1',
              varianceUnits: 4,
              countedSealedPacks: 3,
              countedLooseUnits: 4,
              expectedSealedPacks: 3,
              expectedLooseUnits: 0,
            },
          ],
        }),
        update: vi
          .fn()
          .mockResolvedValue({ id: 'count_1', status: 'APPROVED', approvedAt: APPROVED_AT }),
      },
      pharmacyStockMovement: { create: vi.fn().mockResolvedValue({ id: 'movement' }) },
    };
    return db;
  }

  it('posts one entry per non-zero variance line, after the count is APPROVED', async () => {
    const db = countDb();
    await approveCount(db as unknown as ScopedDb, scope, 'count_1', 'approve');

    expect(finance.postCountAdjustmentEntry.mock.calls).toEqual([
      [db, scope, { countLineId: 'line_short', at: APPROVED_AT }],
      [db, scope, { countLineId: 'line_over', at: APPROVED_AT }],
    ]);
    // The adapter refuses a count that is not APPROVED, so it runs after the write.
    expect(finance.postCountAdjustmentEntry.mock.invocationCallOrder[0]).toBeGreaterThan(
      db.pharmacyInventoryCount.update.mock.invocationCallOrder[0]!
    );
  });

  it('fails the approval when a variance cannot be journalled', async () => {
    finance.postCountAdjustmentEntry.mockRejectedValue(new Error('UNBALANCED'));
    await expect(
      approveCount(countDb() as unknown as ScopedDb, scope, 'count_1', 'approve')
    ).rejects.toThrow('UNBALANCED');
  });
});

describe('inter-branch transfers journal dispatch and receipt', () => {
  const transferLine = {
    id: 'tline_1',
    sourceLotId: 'lot_src',
    sourceStockLocationId: 'loc_src',
    destinationStockLocationId: 'loc_dest',
    quantityUnits: 20,
    receivedUnits: 0,
  };

  it('moves every dispatched line into transit in the same transaction', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          onHandUnits: 40,
          unitsPerPack: 10,
          state: 'ACTIVE',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        },
      ]),
      pharmacyInterbranchTransfer: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'transfer_1',
          status: 'APPROVED',
          lines: [transferLine, { ...transferLine, id: 'tline_2' }],
        }),
        update: vi.fn().mockResolvedValue({
          id: 'transfer_1',
          status: 'DISPATCHED',
          dispatchedAt: DISPATCHED_AT,
        }),
      },
      pharmacyStockMovement: { create: vi.fn().mockResolvedValue({ id: 'movement' }) },
    };

    await dispatchTransfer(db as unknown as ScopedDb, scope, 'transfer_1', 'dispatch');

    expect(finance.postInterbranchTransferEntry.mock.calls).toEqual([
      [db, scope, { transferLineId: 'tline_1', at: DISPATCHED_AT }],
      [db, scope, { transferLineId: 'tline_2', at: DISPATCHED_AT }],
    ]);
  });

  it('brings what arrived out of transit at the destination', async () => {
    const destination = { ...scope, branchId: 'branch_dest' };
    const db = {
      pharmacyInterbranchTransfer: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'transfer_1',
          status: 'DISPATCHED',
          fromBranchId: scope.branchId,
          toBranchId: destination.branchId,
          lines: [transferLine],
        }),
        update: vi.fn().mockResolvedValue({ id: 'transfer_1', status: 'EXCEPTION' }),
      },
      pharmacyInterbranchTransferLine: { update: vi.fn().mockResolvedValue({}) },
      pharmacyInventoryLot: {
        findFirstOrThrow: vi.fn().mockResolvedValue({
          id: 'lot_src',
          unitsPerPack: 10,
          manufacturingBatchId: 'batch',
          packLevelId: 'pack',
          supplierName: 'Supplier',
          supplierInvoiceRef: 'INV-1',
          unitCostMinor: 600,
          printedMrpMinor: 900,
          receivedExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
          receivedExpiryPrecision: 'DAY',
        }),
        create: vi.fn().mockResolvedValue({ id: 'lot_dest' }),
      },
      pharmacyStockMovement: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ id: 'transit_out', occurredAt: RECEIVED_AT })
          .mockResolvedValueOnce({ id: 'received_in', occurredAt: RECEIVED_AT }),
      },
    };

    await receiveTransferLine(db as unknown as ScopedDb, destination, {
      transferId: 'transfer_1',
      lineId: 'tline_1',
      receivedUnits: 15,
      idempotencyKeyPrefix: 'receive',
    });

    expect(finance.postInterbranchTransferReceiptEntry).toHaveBeenCalledTimes(1);
    expect(finance.postInterbranchTransferReceiptEntry).toHaveBeenCalledWith(db, destination, {
      transferLineId: 'tline_1',
      stockMovementId: 'received_in',
      at: RECEIVED_AT,
    });
  });
});
