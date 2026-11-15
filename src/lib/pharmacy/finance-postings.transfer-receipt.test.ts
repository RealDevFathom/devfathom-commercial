/**
 * DEV-131 — FIN-01 transit clearing: what arrives at the destination leaves
 * transit and joins that branch's inventory at the lot's cost, and what is
 * closed short is written off out of transit. Neither may clear transit that
 * was never debited, so a transfer dispatched before dispatches were journalled
 * has its dispatch entry backfilled first.
 *
 * Driven through the real `postJournalEntry` against a fake tenant client, so
 * the balance kernel, idempotency keys and leg dimensions are the real ones.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  postInterbranchTransferLossEntry,
  postInterbranchTransferReceiptEntry,
} from './finance-postings';

const AT = new Date('2026-11-02T09:00:00.000Z');
const DISPATCHED_AT = new Date('2026-11-01T11:00:00.000Z');
const destination = { organizationId: 'org_a', branchId: 'branch_dest', actorId: 'user_b' };
const DISPATCH_KEY = 'finance:PHARMACY_INTERBRANCH_TRANSFER_LINE:tline_1';

type Movement = Partial<{
  id: string;
  branchId: string;
  inventoryLotId: string;
  kind: string;
  disposition: string;
  quantityUnits: number;
  stockLocationId: string;
  reason: string | null;
}>;

function transferDb(
  overrides: {
    toBranchId?: string;
    movement?: Movement;
    unitCostMinor?: number;
    dispatchJournalled?: boolean;
    receivedUnits?: number;
  } = {}
) {
  const entries: Array<{
    idempotencyKey: string;
    actorId: string;
    occurredAt: Date;
    lines: Array<Record<string, unknown>>;
  }> = [];
  const db = {
    pharmacyInterbranchTransferLine: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'tline_1',
        transferId: 'transfer_1',
        sourceBranchId: 'branch_src',
        sourceLotId: 'lot_src',
        sourceStockLocationId: 'loc_src',
        destinationStockLocationId: 'loc_dest',
        quantityUnits: 20,
        receivedUnits: overrides.receivedUnits ?? 0,
        transfer: {
          id: 'transfer_1',
          toBranchId: overrides.toBranchId ?? 'branch_dest',
          dispatchedAt: DISPATCHED_AT,
          dispatchedById: 'user_dispatcher',
        },
      }),
    },
    pharmacyStockMovement: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'received_in',
        branchId: 'branch_dest',
        inventoryLotId: 'lot_dest',
        stockLocationId: 'loc_dest',
        kind: 'TRANSFER_IN',
        disposition: 'AVAILABLE',
        quantityUnits: 15,
        reason: null,
        ...overrides.movement,
      }),
    },
    pharmacyInventoryLot: {
      findMany: vi.fn().mockImplementation(async ({ where }) =>
        (where.id.in as string[]).map((id) => ({
          id,
          unitCostMinor: overrides.unitCostMinor ?? 600,
          batch: { medicineId: 'med_1' },
        }))
      ),
    },
    financeJournalEntry: {
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          overrides.dispatchJournalled && where.idempotencyKey === DISPATCH_KEY
            ? { id: 'dispatch_entry', lines: [] }
            : null
        ),
      create: vi.fn().mockImplementation(async ({ data }) => {
        entries.push({
          idempotencyKey: data.idempotencyKey,
          actorId: data.actorId,
          occurredAt: data.occurredAt,
          lines: [],
        });
        return { id: `entry_${entries.length}`, ...data };
      }),
      findFirstOrThrow: vi.fn().mockImplementation(async () => entries.at(-1)),
    },
    financeJournalLine: {
      create: vi.fn().mockImplementation(async ({ data }) => {
        entries.at(-1)!.lines.push(data);
        return data;
      }),
    },
  };
  return { db, scoped: db as unknown as ScopedDb, entries };
}

const receive = (scoped: ScopedDb) =>
  postInterbranchTransferReceiptEntry(scoped, destination, {
    transferLineId: 'tline_1',
    stockMovementId: 'received_in',
    at: AT,
  });

describe('postInterbranchTransferReceiptEntry', () => {
  it('moves the received value out of transit into destination inventory', async () => {
    const { db, scoped, entries } = transferDb({ dispatchJournalled: true });

    await receive(scoped);

    expect(db.financeJournalEntry.create).toHaveBeenCalledTimes(1);
    expect(db.financeJournalEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceKind: 'PHARMACY_INTERBRANCH_TRANSFER_LINE',
        sourceId: 'tline_1',
        branchId: 'branch_dest',
        occurredAt: AT,
        idempotencyKey: `${DISPATCH_KEY}:receipt:received_in`,
      }),
    });
    expect(entries[0]!.lines).toEqual([
      expect.objectContaining({
        accountCode: 'INVENTORY',
        side: 'DEBIT',
        amountMinor: 9_000,
        branchId: 'branch_dest',
        productId: 'med_1',
        lotId: 'lot_dest',
        locationId: 'loc_dest',
        sourceLineId: 'tline_1',
      }),
      expect.objectContaining({
        accountCode: 'INVENTORY_IN_TRANSIT',
        side: 'CREDIT',
        amountMinor: 9_000,
        // The same dimensions the dispatch debited, so transit nets to zero.
        branchId: 'branch_dest',
        lotId: 'lot_src',
        locationId: 'loc_dest',
        sourceLineId: 'tline_1',
      }),
    ]);
  });

  it('backfills the dispatch entry of a transfer dispatched before journalling', async () => {
    const { scoped, entries } = transferDb({ dispatchJournalled: false });

    await receive(scoped);

    expect(entries.map((entry) => entry.idempotencyKey)).toEqual([
      DISPATCH_KEY,
      `${DISPATCH_KEY}:receipt:received_in`,
    ]);
    // In the dispatcher's name, at the dispatch time; the receipt stays the
    // receiver's.
    expect(entries[0]).toMatchObject({ actorId: 'user_dispatcher', occurredAt: DISPATCHED_AT });
    expect(entries[1]).toMatchObject({ actorId: destination.actorId, occurredAt: AT });
    // Nothing was received yet, so the whole line goes into transit, from the
    // source branch.
    expect(entries[0]!.lines).toEqual([
      expect.objectContaining({
        accountCode: 'INVENTORY_IN_TRANSIT',
        side: 'DEBIT',
        amountMinor: 12_000,
        branchId: 'branch_dest',
        lotId: 'lot_src',
        locationId: 'loc_dest',
      }),
      expect.objectContaining({
        accountCode: 'INVENTORY',
        side: 'CREDIT',
        amountMinor: 12_000,
        branchId: 'branch_src',
        lotId: 'lot_src',
        locationId: 'loc_src',
      }),
    ]);
  });

  it('backfills only what was still in transit when receipts began to be journalled', async () => {
    // 5 of 20 units were shelved before receipts were journalled; they never
    // reached the GL, so only the 15 still outstanding go into transit.
    const { scoped, entries } = transferDb({ receivedUnits: 5 });

    await receive(scoped);

    expect(entries[0]!.idempotencyKey).toBe(DISPATCH_KEY);
    expect(entries[0]!.lines).toEqual([
      expect.objectContaining({ accountCode: 'INVENTORY_IN_TRANSIT', amountMinor: 9_000 }),
      expect.objectContaining({ accountCode: 'INVENTORY', amountMinor: 9_000 }),
    ]);
    // ...and the 15 received now take them all back out.
    expect(entries[1]!.lines).toEqual([
      expect.objectContaining({ accountCode: 'INVENTORY', side: 'DEBIT', amountMinor: 9_000 }),
      expect.objectContaining({
        accountCode: 'INVENTORY_IN_TRANSIT',
        side: 'CREDIT',
        amountMinor: 9_000,
      }),
    ]);
  });

  it('refuses a receiving branch that is not the transfer destination', async () => {
    const { db, scoped } = transferDb({ toBranchId: 'branch_other' });
    await expect(receive(scoped)).rejects.toMatchObject({ reason: 'CROSS_BRANCH_REFERENCE' });
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a movement that is not a transfer in', { kind: 'ADJUSTMENT' }],
    ['a movement still in transit', { disposition: 'IN_TRANSIT' }],
    ['a movement at another location', { stockLocationId: 'loc_other' }],
    ['a non-positive movement', { quantityUnits: -15 }],
  ])('refuses %s', async (_label, movement) => {
    const { db, scoped } = transferDb({ movement });
    await expect(receive(scoped)).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
  });

  it('posts nothing for a zero-cost lot', async () => {
    const { db, scoped } = transferDb({ unitCostMinor: 0 });
    await expect(receive(scoped)).resolves.toBeNull();
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
  });
});

describe('postInterbranchTransferLossEntry', () => {
  const lossMovement: Movement = {
    id: 'loss_out',
    branchId: 'branch_src',
    inventoryLotId: 'lot_src',
    stockLocationId: 'loc_src',
    kind: 'WRITE_OFF',
    disposition: 'IN_TRANSIT',
    quantityUnits: -5,
    reason: 'Transfer transfer_1 receipt variance: lost',
  };
  const close = (scoped: ScopedDb) =>
    postInterbranchTransferLossEntry(scoped, destination, {
      transferLineId: 'tline_1',
      stockMovementId: 'loss_out',
      at: AT,
    });

  it('writes the short units off out of transit at the source lot cost', async () => {
    const { db, scoped, entries } = transferDb({
      movement: lossMovement,
      dispatchJournalled: true,
    });

    await close(scoped);

    expect(db.financeJournalEntry.create).toHaveBeenCalledTimes(1);
    expect(entries[0]!.idempotencyKey).toBe(`${DISPATCH_KEY}:loss:loss_out`);
    expect(entries[0]!.lines).toEqual([
      expect.objectContaining({
        accountCode: 'INVENTORY_WRITE_OFF',
        side: 'DEBIT',
        amountMinor: 3_000,
        branchId: 'branch_dest',
      }),
      expect.objectContaining({
        accountCode: 'INVENTORY_IN_TRANSIT',
        side: 'CREDIT',
        amountMinor: 3_000,
        branchId: 'branch_dest',
        lotId: 'lot_src',
        locationId: 'loc_dest',
        sourceLineId: 'tline_1',
      }),
    ]);
    // The lot cost is read from the source branch, where the lot lives.
    expect(db.pharmacyInventoryLot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branchId: 'branch_src' }) })
    );
  });

  it('backfills an unjournalled dispatch before clearing transit', async () => {
    // 15 of 20 arrived before journalling; the 5 closed short are all that is
    // still in transit, so the backfill and the loss net transit to zero.
    const { scoped, entries } = transferDb({ movement: lossMovement, receivedUnits: 15 });
    await close(scoped);
    expect(entries.map((entry) => entry.idempotencyKey)).toEqual([
      DISPATCH_KEY,
      `${DISPATCH_KEY}:loss:loss_out`,
    ]);
    expect(entries[0]).toMatchObject({ actorId: 'user_dispatcher' });
    const transit = entries
      .flatMap((entry) => entry.lines)
      .filter((leg) => leg.accountCode === 'INVENTORY_IN_TRANSIT')
      .reduce(
        (sum, leg) =>
          sum + (leg.side === 'DEBIT' ? Number(leg.amountMinor) : -Number(leg.amountMinor)),
        0
      );
    expect(transit).toBe(0);
  });

  it.each([
    ['a movement that is not a write-off', { kind: 'ADJUSTMENT' }, 'INVALID_STATE'],
    ['a write-off of available stock', { disposition: 'AVAILABLE' }, 'INVALID_STATE'],
    ['a positive movement', { quantityUnits: 5 }, 'INVALID_STATE'],
    ['a movement on another lot', { inventoryLotId: 'lot_other' }, 'CROSS_BRANCH_REFERENCE'],
    ['a movement at another branch', { branchId: 'branch_other' }, 'CROSS_BRANCH_REFERENCE'],
  ])('refuses %s', async (_label, movement, reason) => {
    const { db, scoped } = transferDb({ movement: { ...lossMovement, ...movement } });
    await expect(close(scoped)).rejects.toMatchObject({ reason });
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
  });
});
