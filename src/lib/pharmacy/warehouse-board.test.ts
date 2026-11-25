import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { warehouseBoard } from './warehouse-board';

const now = new Date('2026-11-25T10:00:00.000Z');
const scope = { organizationId: 'org', branchId: 'branch', actorId: 'operator' };
const noMetrics = {
  completedShipments: 0,
  averageHours: null,
  countedLines: 0,
  matchingLines: 0,
  expiryWriteOffUnits: 0,
};
const shipment = {
  transferId: 'transfer',
  fromBranchId: 'central',
  fromBranchName: 'Central',
  toBranchId: scope.branchId,
  toBranchName: 'Branch',
  status: 'EXCEPTION',
  dispatchedAt: new Date('2026-11-23T10:00:00.000Z'),
  adoptable: false,
  medicineId: 'paracetamol',
  medicineName: 'Paracetamol 500 mg',
  lotId: 'lot-a',
  shelfLabelNumber: 32,
  batchNumber: 'printed-A',
  destinationBinCode: 'A-2',
  destinationStockLocationId: 'bin-a',
  quantityUnits: 10,
  receivedUnits: 8,
  coldChain: false,
  minimumStorageTemperatureC: null,
  controlled: false,
};
const demand = {
  orderId: 'order',
  demandId: 'demand',
  toBranchId: 'dest',
  toBranchName: 'Branch',
  medicineName: 'Paracetamol',
  requestedUnits: 10,
  committedUnits: 6,
  fulfilledUnits: 4,
  requestedAt: now,
  status: 'OPEN',
};
function service(transfers: unknown[] = [], demands: unknown[] = [], metrics = noMetrics) {
  const query = vi
    .fn()
    .mockResolvedValueOnce(transfers)
    .mockResolvedValueOnce(demands)
    .mockResolvedValueOnce([metrics])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
  const db = { $queryRaw: query } as unknown as ScopedDb;
  return { db, query };
}

describe('warehouse supervision', () => {
  it('counts each shipment and exception once across lots, and includes the due boundary', async () => {
    const { db } = service([
      { ...shipment, lineId: 'line-1' },
      { ...shipment, lineId: 'line-2', batchNumber: 'printed-B', shelfLabelNumber: 63 },
      {
        ...shipment,
        transferId: 'out',
        lineId: 'line-3',
        fromBranchId: scope.branchId,
        toBranchId: 'dest',
        status: 'ALLOCATED',
        dispatchedAt: null,
        adoptable: true,
      },
    ]);
    const board = await warehouseBoard(db, scope, now);
    expect(board.incoming).toHaveLength(1);
    expect(board.incoming[0].lines.map((line) => line.batchNumber)).toEqual([
      'printed-A',
      'printed-B',
    ]);
    expect(board.overdue.map((t) => t.id)).toEqual(['transfer']);
    expect(board.adoptable.map((t) => t.id)).toEqual(['out']);
    expect(board.metrics.openExceptions).toBe(1);
  });

  it('requires transport evidence for refrigerated lines and for ambient lines with approved storage limits', async () => {
    const { db } = service([
      { ...shipment, lineId: 'ambient' },
      { ...shipment, lineId: 'labelled', minimumStorageTemperatureC: 15 },
      { ...shipment, lineId: 'refrigerated', coldChain: true },
    ]);
    const board = await warehouseBoard(db, scope, now);
    expect(
      board.incoming[0].lines.map((line) => [line.id, line.requiresTemperatureEvidence])
    ).toEqual([
      ['ambient', false],
      ['labelled', true],
      ['refrigerated', true],
    ]);
  });

  it('uses received units for fill rate while keeping older outstanding shortages actionable', async () => {
    const { db } = service(
      [],
      [
        demand,
        {
          ...demand,
          demandId: 'pending',
          requestedUnits: 6,
          orderId: null,
          committedUnits: 0,
          fulfilledUnits: 0,
          status: 'REQUESTED',
        },
        {
          ...demand,
          demandId: 'older',
          requestedAt: new Date('2026-10-25T09:59:59Z'),
          committedUnits: 9,
        },
      ],
      { ...noMetrics, countedLines: 6, matchingLines: 4, expiryWriteOffUnits: 12 }
    );
    const board = await warehouseBoard(db, scope, now);
    expect(board.metrics.fillRate).toEqual({ requestedUnits: 16, fulfilledUnits: 4, percent: 25 });
    expect(board.shortages.map((r) => [r.demandId, r.shortfallUnits])).toEqual([
      ['demand', 4],
      ['older', 1],
    ]);
    expect(board.metrics.binAccuracy.percent).toBe(66.7);
    expect(board.metrics.expiryWriteOffUnits).toBe(12);
  });

  it('leaves rates undefined for an empty site and scopes each read to the admitted branch and tenant', async () => {
    const { db, query } = service();
    const board = await warehouseBoard(db, scope, now);
    expect(board.metrics.binAccuracy.percent).toBeNull();
    expect(board.metrics.fillRate.percent).toBeNull();
    expect(board.metrics.receiptTime.averageHours).toBeNull();
    for (const [statement] of query.mock.calls) {
      expect(statement.values).toContain(scope.organizationId);
      expect(statement.values).toContain(scope.branchId);
    }
  });
});
