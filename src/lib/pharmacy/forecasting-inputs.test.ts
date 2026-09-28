// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { loadForecastingInputs } from './forecasting-inputs';
import { simulateReplenishmentDecision, type ReplenishmentDecisionInput } from './forecasting';
import { loadStockCandidatesForRead } from './stock-ledger';

const scope = { organizationId: 'org', branchId: 'branch', medicineId: 'medicine' };
const now = new Date('2026-09-14T00:00:00Z');
const expiry = new Date('2027-01-01T00:00:00Z');
const receivedAt = new Date('2026-09-01T00:00:00Z');
const candidate = () => ({
  inventoryLotId: 'lot',
  stockLocationId: 'shelf',
  organizationId: scope.organizationId,
  branchId: scope.branchId,
  batchState: 'ACTIVE',
  disposition: 'AVAILABLE',
  expiresAt: expiry,
  receivedAt,
  availableUnits: BigInt(7),
  unitsPerPack: 10,
  sealedPacks: 1,
  looseUnits: 0,
});
const purchase = () => ({
  id: 'po-line',
  organizationId: scope.organizationId,
  medicineId: scope.medicineId,
  orderedCanonicalUnits: 20,
  bonusCanonicalUnits: 4,
  purchaseOrder: {
    id: 'po',
    organizationId: scope.organizationId,
    branchId: scope.branchId as string | null,
    expectedDeliveryAt: null as Date | null,
  },
  goodsReceiptLines: [{ acceptedCanonicalUnits: 5 }, { acceptedCanonicalUnits: 3 }],
});
const transfer = () => ({
  id: 'transfer-line',
  organizationId: scope.organizationId,
  sourceBranchId: 'source-branch',
  sourceLotId: 'source-lot',
  sourceStockLocationId: 'source-shelf',
  destinationStockLocationId: 'destination-shelf',
  quantityUnits: 12,
  receivedUnits: 5,
  transfer: {
    id: 'transfer',
    organizationId: scope.organizationId,
    fromBranchId: 'source-branch',
    toBranchId: scope.branchId,
    dispatchedAt: new Date('2026-09-13T00:00:00Z'),
  },
  sourceLot: {
    id: 'source-lot',
    organizationId: scope.organizationId,
    branchId: 'source-branch',
    batch: {
      organizationId: scope.organizationId,
      medicineId: scope.medicineId,
      state: 'ACTIVE',
      expiresAt: expiry,
    },
  },
});

const recordedBalance = () => ({
  organizationId: scope.organizationId,
  branchId: scope.branchId,
  onHandUnits: 0,
  lot: {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    batch: { organizationId: scope.organizationId, medicineId: scope.medicineId },
  },
});

/** Only read methods exist. Any transaction, lock helper or mutation fails the test. */
function reader(
  stock: unknown[] = [],
  purchases: unknown[] = [],
  transfers: unknown[] = [],
  // Empty-stock fixtures explicitly have a recorded zero unless a case supplies null.
  balance: ReturnType<typeof recordedBalance> | null = recordedBalance()
) {
  const query = vi.fn<(sql: Prisma.Sql) => Promise<unknown[]>>().mockResolvedValue(stock);
  const stockBalance = vi.fn().mockResolvedValue(balance);
  const purchaseLines = vi.fn().mockResolvedValue(purchases);
  const transferLines = vi.fn().mockResolvedValue(transfers);
  const methods = {
    $queryRaw: query,
    pharmacyStockBalance: { findFirst: stockBalance },
    pharmacyPurchaseOrderLine: { findMany: purchaseLines },
    pharmacyInterbranchTransferLine: { findMany: transferLines },
  };
  const db = new Proxy(methods, {
    get(target, key) {
      if (!(key in target)) throw new Error(`Unexpected database operation: ${String(key)}`);
      return Reflect.get(target, key);
    },
  }) as unknown as ScopedDb;
  return { db, query, stockBalance, purchaseLines, transferLines };
}

afterEach(() => vi.useRealTimers());

describe('read-only forecasting supply inputs', () => {
  it('reuses ledger SQL with both reservations, bound scope and no row locks', async () => {
    const db = reader([candidate()]);
    const result = await loadStockCandidatesForRead(db.db, scope, scope.medicineId);
    expect(result[0]!.availableUnits).toBe(7);
    const sql = db.query.mock.calls[0]![0];
    expect(sql.values).toEqual([scope.organizationId, scope.branchId, scope.medicineId]);
    expect(sql.text).toContain('balance."organizationId" = $1');
    expect(sql.text).toContain('balance."branchId" = $2');
    expect(sql.text).toContain('batch."medicineId" = $3');
    for (const name of ['pharmacy_supplier_claims', 'pharmacy_restock_reservations']) {
      // Both projection and positive-availability predicate must net commitments.
      expect(sql.text.split(name)).toHaveLength(3);
    }
    expect(sql.text).toContain('claim."status" = \'RESERVED\'');
    expect(sql.text).toContain('reservation."status" = \'RESERVED\'');
    for (const key of ['organizationId', 'branchId', 'inventoryLotId', 'stockLocationId']) {
      expect(sql.text).toContain(`reservation."${key}" = balance."${key}"`);
    }
    expect(sql.text).not.toMatch(/FOR UPDATE|INSERT|UPDATE|DELETE/i);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('returns net safe stock with canonical expiry and receipt evidence, leaving constraints null', async () => {
    vi.useFakeTimers().setSystemTime(now);
    const row = candidate();
    const db = reader([row]);
    const result = await loadForecastingInputs(db.db, scope);
    expect(result.stock).toEqual([
      {
        inventoryLotId: 'lot',
        stockLocationId: 'shelf',
        ...scope,
        batchState: 'ACTIVE',
        disposition: 'AVAILABLE',
        expiresAt: expiry,
        receivedAt,
        availableUnits: 7,
      },
    ]);
    expect(row.availableUnits).toBe(BigInt(7));
    expect(result.inventorySource).toMatchObject({
      kind: 'OBSERVED_TRANSACTIONS',
      asOf: now.toISOString(),
    });
    expect(result.constraints).toEqual({ budgetMinor: null, storageLimitUnits: null });
    expect(result.excludedStock).toEqual([]);
    expect(result.inbound).toEqual([]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.stockBalance).not.toHaveBeenCalled();
    expect(db.purchaseLines).toHaveBeenCalledTimes(1);
    expect(db.transferLines).toHaveBeenCalledTimes(1);
  });

  it('refuses to label an empty unobserved scope as observed zero stock', async () => {
    const db = reader([], [], [], null);
    await expect(loadForecastingInputs(db.db, scope)).rejects.toThrow(
      'Stock evidence is unavailable for forecasting supply scope'
    );
    expect(db.stockBalance).toHaveBeenCalledTimes(1);
    expect(db.purchaseLines).not.toHaveBeenCalled();
    expect(db.transferLines).not.toHaveBeenCalled();
  });

  it('does not use inbound documents as evidence of current zero stock', async () => {
    const db = reader([], [purchase()], [transfer()], null);
    await expect(loadForecastingInputs(db.db, scope)).rejects.toThrow(
      'Stock evidence is unavailable'
    );
  });

  it.each([0, 10])(
    'preserves evidenced zero eligible stock with a recorded balance of %i (zero or fully reserved)',
    async (onHandUnits) => {
      const balance = { ...recordedBalance(), onHandUnits };
      const db = reader([], [], [], balance);
      const result = await loadForecastingInputs(db.db, scope);
      expect(result.stock).toEqual([]);
      expect(result.inventorySource.kind).toBe('OBSERVED_TRANSACTIONS');
      expect(db.stockBalance.mock.calls[0]![0].where).toEqual({
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        lot: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          batch: { organizationId: scope.organizationId, medicineId: scope.medicineId },
        },
      });
      expect(balance.onHandUnits).toBe(onHandUnits);
    }
  );

  it.each(['organizationId', 'branchId', 'medicineId'] as const)(
    'rejects empty-candidate evidence for another %s',
    async (key) => {
      const balance = recordedBalance();
      if (key === 'medicineId') balance.lot.batch.medicineId = 'foreign';
      else balance[key] = 'foreign';
      await expect(loadForecastingInputs(reader([], [], [], balance).db, scope)).rejects.toThrow(
        'Stock balance scope does not match forecasting supply scope'
      );
    }
  );

  it('propagates failed balance evidence reads instead of emitting observed zero', async () => {
    const db = reader();
    const failure = new Error('stock evidence read failed');
    db.stockBalance.mockRejectedValue(failure);
    await expect(loadForecastingInputs(db.db, scope)).rejects.toBe(failure);
    expect(db.purchaseLines).not.toHaveBeenCalled();
  });

  it.each([
    [{ batchState: 'RECALLED' }, 'RECALLED'],
    [{ batchState: 'QUARANTINED' }, 'QUARANTINED'],
    [{ disposition: 'QUARANTINE' }, 'QUARANTINED'],
    [{ disposition: 'DAMAGED' }, 'DAMAGED'],
    [{ disposition: 'IN_TRANSIT' }, 'IN_TRANSIT'],
    [{ expiresAt: now }, 'EXPIRED'],
    [{ expiresAt: null }, 'UNKNOWN_EXPIRY'],
    [{ receivedAt: null }, 'UNRECEIVED'],
    [{ receivedAt: expiry }, 'UNRECEIVED'],
    [{ availableUnits: 0 }, 'EMPTY'],
  ])('preserves excluded stock facts: %j', async (change, reason) => {
    vi.useFakeTimers().setSystemTime(now);
    const db = reader([{ ...candidate(), ...change }]);
    const result = await loadForecastingInputs(db.db, scope);
    expect(result.stock).toEqual([]);
    expect(result.excludedStock).toMatchObject([{ lot: { inventoryLotId: 'lot' }, reason }]);
  });

  it('keeps available and quarantined buckets of the same lot separate', async () => {
    const db = reader([candidate(), { ...candidate(), disposition: 'QUARANTINE' }]);
    const result = await loadForecastingInputs(db.db, scope);
    expect(result.stock).toHaveLength(1);
    expect(result.stock[0]!.availableUnits).toBe(7);
    expect(result.excludedStock).toHaveLength(1);
  });

  it('queries only scoped approved orders and POSTED accepted receipts, subtracting partial receipts and bonuses', async () => {
    const db = reader([], [purchase()]);
    const result = await loadForecastingInputs(db.db, scope);
    expect(result.inbound[0]).toMatchObject({
      confirmed: true,
      arrivalAt: null,
      lot: { ...scope, availableUnits: 16, expiresAt: null },
      evidence: { kind: 'PURCHASE_ORDER', orderedUnits: 24, postedAcceptedUnits: 8 },
    });
    const query = db.purchaseLines.mock.calls[0]![0];
    expect(query.where).toEqual({
      organizationId: 'org',
      medicineId: 'medicine',
      purchaseOrder: {
        organizationId: 'org',
        branchId: 'branch',
        status: { in: ['APPROVED', 'SENT', 'RECEIVING'] },
      },
    });
    expect(query.select.goodsReceiptLines).toEqual({
      where: {
        ...scope,
        goodsReceipt: { organizationId: 'org', branchId: 'branch', status: 'POSTED' },
      },
      select: { acceptedCanonicalUnits: true },
    });
    expect(query.select.purchaseOrder.select).not.toHaveProperty('quote');
  });

  it('preserves a recorded PO ETA without guessing expiry from already received batches', async () => {
    const line = purchase();
    line.purchaseOrder.expectedDeliveryAt = expiry;
    const result = await loadForecastingInputs(reader([], [line]).db, scope);
    expect(result.inbound[0]!.arrivalAt).toBe(expiry.toISOString());
    expect(result.inbound[0]!.lot.expiresAt).toBeNull();
  });

  it.each([24, 30])('omits fully received and over-received purchase lines: %i', async (units) => {
    const line = { ...purchase(), goodsReceiptLines: [{ acceptedCanonicalUnits: units }] };
    expect((await loadForecastingInputs(reader([], [line]).db, scope)).inbound).toEqual([]);
  });

  it('preserves transfer source-lot identity and partial receipt quantities without treating dispatch as ETA', async () => {
    const line = transfer();
    const db = reader([], [], [line]);
    const result = await loadForecastingInputs(db.db, scope);
    expect(result.inbound[0]).toMatchObject({
      id: 'forecast-transfer:transfer-line',
      arrivalAt: null,
      lot: { ...scope, stockLocationId: 'destination-shelf', availableUnits: 7, expiresAt: expiry },
      evidence: {
        kind: 'TRANSFER',
        sourceLotId: 'source-lot',
        sourceBranchId: 'source-branch',
        sourceStockLocationId: 'source-shelf',
        destinationStockLocationId: 'destination-shelf',
        quantityUnits: 12,
        receivedUnits: 5,
        dispatchedAt: '2026-09-13T00:00:00.000Z',
      },
    });
    expect(db.transferLines.mock.calls[0]![0].where).toEqual({
      organizationId: 'org',
      transfer: {
        organizationId: 'org',
        toBranchId: 'branch',
        status: { in: ['APPROVED', 'DISPATCHED', 'PARTIALLY_RECEIVED'] },
      },
      sourceLot: {
        organizationId: 'org',
        batch: { organizationId: 'org', medicineId: 'medicine' },
      },
    });
    expect(line.receivedUnits).toBe(5);
  });

  it('retains recalled transfer batch state and omits completed transfers', async () => {
    const line = transfer();
    line.sourceLot.batch.state = 'RECALLED';
    const result = await loadForecastingInputs(
      reader([], [], [line, { ...transfer(), id: 'complete', receivedUnits: 12 }]).db,
      scope
    );
    expect(result.inbound).toHaveLength(1);
    expect(result.inbound[0]!.lot.batchState).toBe('RECALLED');
  });

  it.each(['organizationId', 'branchId', 'medicineId'] as const)(
    'rejects missing %s before any query',
    async (key) => {
      const db = reader();
      await expect(loadForecastingInputs(db.db, { ...scope, [key]: ' ' })).rejects.toThrow(
        'scope is required'
      );
      expect(db.query).not.toHaveBeenCalled();
    }
  );

  it.each(['organizationId', 'branchId'] as const)(
    'fails closed on mismatched stock %s',
    async (key) => {
      await expect(
        loadForecastingInputs(reader([{ ...candidate(), [key]: 'foreign' }]).db, scope)
      ).rejects.toThrow('Stock scope');
    }
  );

  it('rejects unassigned central POs and cross-medicine purchase rows', async () => {
    const line = purchase();
    line.purchaseOrder.branchId = null;
    await expect(loadForecastingInputs(reader([], [line]).db, scope)).rejects.toThrow(
      'Purchase scope'
    );
    await expect(
      loadForecastingInputs(reader([], [{ ...purchase(), medicineId: 'foreign' }]).db, scope)
    ).rejects.toThrow('Purchase scope');
  });

  it('rejects mismatched transfer destinations and source-lot ownership', async () => {
    const destination = transfer();
    destination.transfer.toBranchId = 'foreign';
    const source = transfer();
    source.sourceLot.branchId = 'foreign';
    for (const line of [destination, source]) {
      await expect(loadForecastingInputs(reader([], [], [line]).db, scope)).rejects.toThrow(
        'Transfer scope'
      );
    }
  });

  it('fails on unsafe receipt arithmetic', async () => {
    const line = { ...purchase(), goodsReceiptLines: [{ acceptedCanonicalUnits: -1 }] };
    await expect(loadForecastingInputs(reader([], [line]).db, scope)).rejects.toThrow(
      'safe integers'
    );
  });

  it('propagates database failures without falling back to empty evidence or committing', async () => {
    const db = reader();
    const failure = new Error('receipt read failed');
    db.purchaseLines.mockRejectedValue(failure);
    await expect(loadForecastingInputs(db.db, scope)).rejects.toBe(failure);
    expect(db.transferLines).not.toHaveBeenCalled();
  });

  it('keeps concurrent reads independent and leaves supplied rows unchanged', async () => {
    const row = purchase();
    const before = structuredClone(row);
    const first = reader([candidate()], [row]);
    const second = reader();
    const [a, b] = await Promise.all([
      loadForecastingInputs(first.db, scope),
      loadForecastingInputs(second.db, scope),
    ]);
    expect(a.stock).toHaveLength(1);
    expect(b.stock).toEqual([]);
    expect(row).toEqual(before);
  });

  it('feeds the accepted engine without counting unknown inbound or unknown constraints as feasible', async () => {
    vi.useFakeTimers().setSystemTime(now);
    const supply = await loadForecastingInputs(
      reader([candidate()], [purchase()], [transfer()]).db,
      scope
    );
    const input: ReplenishmentDecisionInput = {
      ...supply,
      currency: 'PKR',
      demand: {
        scope,
        source: {
          kind: 'SYNTHETIC_FIXTURE',
          reference: 'unit-test-demand',
          asOf: now.toISOString(),
        },
        originDate: '2026-09-14',
        historyStartDate: '2026-09-13',
        horizonDays: 1,
        method: 'RECENT_MEAN',
        days: [
          { date: '2026-09-13', knownAt: '2026-09-13T23:00:00Z', state: 'OBSERVED', units: 10 },
        ],
      },
      policies: { source: 'MANUAL_SCENARIO', currentQuantityUnits: 5, proposedQuantityUnits: 10 },
      orderTerms: {
        source: { kind: 'MANUAL_SCENARIO', reference: 'unit-test-terms', asOf: now.toISOString() },
        packSize: 1,
        minimumOrderUnits: 0,
        unitCostMinor: null,
        ...supply.constraints,
        arrivalAt: null,
        expiresAt: null,
      },
    };
    const decision = simulateReplenishmentDecision(input);
    expect(decision.scenarios[0]!.outcome).toMatchObject({ fulfilledUnits: 7, shortageUnits: 3 });
    expect(decision.excludedInbound.map((row) => row.reason)).toEqual([
      'UNKNOWN_ARRIVAL',
      'UNKNOWN_ARRIVAL',
    ]);
    expect(decision.scenarios[1]!.order.status).toBe('UNKNOWN');
    expect(decision.scenarios[1]!.outcome).toBeNull();

    const zero = await loadForecastingInputs(reader([], [], [], recordedBalance()).db, scope);
    expect(
      simulateReplenishmentDecision({ ...input, ...zero }).scenarios[0]!.outcome
    ).toMatchObject({
      fulfilledUnits: 0,
      shortageUnits: 10,
    });
  });
});
