import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';

/**
 * DEV-825: the inventory paths (transfers out and in, count approval, the
 * release reserve, supplier claims and returns, recall quarantine reversal) take
 * every stock lock in the one global order of stock-lock-order.ts, with all keys
 * sorted before the first lock and before the first stock write. Each test feeds
 * the path keys in REVERSE key order, so a path that locked or wrote in its own
 * business order would fail.
 */

// DEV-957 phase 2: set-asides hold stock only while offline cash selling is in force; it
// is forced on here so the lock order of that read is checked.
vi.mock('./offline-cash-selling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./offline-cash-selling')>()),
  counterSetAsidesInForce: vi.fn(async () => true),
}));
vi.mock('./finance-postings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./finance-postings')>()),
  postCountAdjustmentEntry: vi.fn(async () => undefined),
  postInterbranchTransferEntry: vi.fn(async () => undefined),
  postSupplierClaimEntry: vi.fn(async () => undefined),
}));

import { reverseRecallQuarantine } from './drap-monitoring';
import {
  approveCount,
  dispatchTransfer,
  quarantinePart,
  releaseQuarantinedPart,
  reserveSupplierClaim,
  writeOff,
} from './inventory-operations';
import { transferStock } from './stock-ledger';
import { STOCK_LOCK_ORDER, type StockLockClass } from './stock-lock-order';
import { dispatchPurchaseReturn, submitPurchaseReturn } from './supplier-returns-operations';

type Event = { kind: StockLockClass | 'write' | 'read'; values: unknown[]; text: string };

function sqlOf(args: unknown[]) {
  const [first, ...rest] = args;
  const sql = Array.isArray(first)
    ? Prisma.sql(first as unknown as TemplateStringsArray, ...rest)
    : (first as Prisma.Sql);
  return { text: sql.strings.join('?'), values: sql.values };
}

function classify(text: string): Event['kind'] {
  if (text.includes('pg_advisory_xact_lock')) return 'read';
  if (!/FOR (NO KEY )?UPDATE|FOR SHARE/.test(text)) return 'read';
  if (text.includes('stock_lock:batch')) return 'batch';
  if (text.includes('stock_lock:medicine')) return 'medicine';
  if (text.includes('stock_lock:lot')) return 'lot';
  if (text.includes('stock_lock:balance')) return 'balance';
  return 'read';
}

/** Records every lock statement and stock write, in order; `reads` answers plain reads. */
function recorder(reads: (text: string) => unknown[] = () => []) {
  const events: Event[] = [];
  const $queryRaw = vi.fn(async (...args: unknown[]) => {
    const { text, values } = sqlOf(args);
    const kind = classify(text);
    events.push({ kind, values, text });
    // DEV-957: no counter holds units in these paths (the device-quota read finds none).
    if (text.includes('"counterName"')) return [];
    return kind === 'read' ? reads(text) : [];
  });
  const write = (values: Record<string, unknown>) =>
    events.push({ kind: 'write', values: [values], text: '' });
  return {
    events,
    $queryRaw,
    write,
    locks: () => events.filter((event) => event.kind !== 'write' && event.kind !== 'read'),
    /** The (lot, location, disposition) values of the balance lock statements. */
    balanceKeys: () =>
      events
        .filter((event) => event.kind === 'balance')
        .flatMap((event) => {
          const keys: string[] = [];
          const values = event.values.map(String);
          for (let index = 0; index + 2 < values.length; index++) {
            if (values[index]!.startsWith('lot-'))
              keys.push(values.slice(index, index + 3).join('/'));
          }
          return keys;
        }),
    firstWrite: () => events.findIndex((event) => event.kind === 'write'),
    lastLock: () =>
      events.reduce(
        (last, event, index) => (event.kind !== 'write' && event.kind !== 'read' ? index : last),
        -1
      ),
    /** Every stock-row lock statement, i.e. any FOR UPDATE / FOR SHARE that is not ours. */
    strayLocks: () =>
      events.filter(
        (event) =>
          event.kind === 'read' &&
          /FOR (NO KEY )?UPDATE|FOR SHARE/.test(event.text) &&
          /pharmacy_stock_balances|pharmacy_inventory_lots|pharmacy_manufacturing_batches/.test(
            event.text
          )
      ),
  };
}

function expectGlobalOrder(locks: Event[]) {
  const ranks = locks.map((event) => STOCK_LOCK_ORDER.indexOf(event.kind as StockLockClass));
  expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
}

function expectLockedBeforeWrites(trace: ReturnType<typeof recorder>) {
  expect(trace.firstWrite()).toBeGreaterThan(-1);
  expect(trace.lastLock()).toBeLessThan(trace.firstWrite());
  expect(trace.strayLocks()).toEqual([]);
  expectGlobalOrder(trace.locks());
}

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };
const movementCreate = (trace: ReturnType<typeof recorder>) =>
  vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    trace.write(data);
    return { id: `movement-${trace.events.length}`, ...data, occurredAt: new Date() };
  });

beforeEach(() => vi.clearAllMocks());

describe('transfers take stock locks in the global order', () => {
  it('locks both balances of a stock transfer, sorted, before either write', async () => {
    const trace = recorder(() => [
      {
        ...scope,
        inventoryLotId: 'lot-a',
        stockLocationId: 'shelf-z',
        batchState: 'ACTIVE',
        disposition: 'AVAILABLE',
        expiresAt: new Date('2100-01-01'),
        receivedAt: new Date('2020-01-01'),
        availableUnits: 10,
        unitsPerPack: 1,
        sealedPacks: 0,
        looseUnits: 10,
      },
    ]);
    const db = {
      $queryRaw: trace.$queryRaw,
      pharmacyStockLocation: {
        findFirst: vi.fn(async () => ({ id: 'shelf-a', kind: 'RACK_BIN', coldChain: false })),
      },
      pharmacyInventoryLot: {
        findFirst: vi.fn(async () => ({ batch: { medicine: { coldChain: false } } })),
      },
      pharmacyStockMovement: { findMany: vi.fn(async () => []), create: movementCreate(trace) },
    };
    await transferStock(db as never, scope, {
      inventoryLotId: 'lot-a',
      fromStockLocationId: 'shelf-z',
      toStockLocationId: 'shelf-a',
      units: 2,
      at: new Date(),
      idempotencyKeyPrefix: 'move',
    });
    expect(trace.balanceKeys()).toEqual(['lot-a/shelf-a/AVAILABLE', 'lot-a/shelf-z/AVAILABLE']);
    expectLockedBeforeWrites(trace);
  });

  it('locks every dispatched line, sorted, before the first line is read or written', async () => {
    const trace = recorder(() => [
      { onHandUnits: 10, unitsPerPack: 1, state: 'ACTIVE', expiresAt: new Date('2100-01-01') },
    ]);
    const db = {
      $queryRaw: trace.$queryRaw,
      pharmacyInterbranchTransfer: {
        findFirst: vi.fn(async () => ({
          id: 'transfer',
          status: 'APPROVED',
          lines: [
            {
              id: 'line-2',
              sourceLotId: 'lot-b',
              sourceStockLocationId: 'shelf',
              quantityUnits: 1,
            },
            {
              id: 'line-1',
              sourceLotId: 'lot-a',
              sourceStockLocationId: 'shelf',
              quantityUnits: 1,
            },
          ],
        })),
        update: vi.fn(async () => ({ id: 'transfer', dispatchedAt: new Date() })),
      },
      pharmacyStockMovement: { create: movementCreate(trace) },
    };
    await dispatchTransfer(db as never, scope, 'transfer', 'dispatch');
    expect(trace.balanceKeys()).toEqual([
      'lot-a/shelf/AVAILABLE',
      'lot-a/shelf/IN_TRANSIT',
      'lot-b/shelf/AVAILABLE',
      'lot-b/shelf/IN_TRANSIT',
    ]);
    expectLockedBeforeWrites(trace);
  });
});

describe('count approval and quarantine release take stock locks in the global order', () => {
  it('locks every variance balance, sorted, before the first adjustment', async () => {
    const trace = recorder();
    const line = (id: string, lot: string) => ({
      id,
      inventoryLotId: lot,
      stockLocationId: 'shelf',
      varianceUnits: -1,
      countedSealedPacks: 0,
      expectedSealedPacks: 0,
      countedLooseUnits: 0,
      expectedLooseUnits: 1,
    });
    const db = {
      $queryRaw: trace.$queryRaw,
      pharmacyInventoryCount: {
        findFirst: vi.fn(async () => ({
          id: 'count',
          status: 'AWAITING_COAUTH',
          createdById: 'counter',
          lines: [line('line-2', 'lot-b'), line('line-1', 'lot-a')],
        })),
        update: vi.fn(async () => ({ id: 'count', approvedAt: new Date() })),
      },
      pharmacyStockMovement: { create: movementCreate(trace) },
    };
    await approveCount(db as never, scope, 'count', 'approve', 'Broken strip');
    expect(trace.balanceKeys()).toEqual(['lot-a/shelf/AVAILABLE', 'lot-b/shelf/AVAILABLE']);
    expectLockedBeforeWrites(trace);
  });

  it.each([
    ['QUARANTINE', false],
    ['DAMAGED', true],
  ])('locks AVAILABLE then %s through the helper before quarantining', async (target, damaged) => {
    const trace = recorder();
    const db = {
      $queryRaw: trace.$queryRaw,
      pharmacyInventoryLot: {
        findFirst: vi.fn(async () => ({ id: 'lot-a', unitsPerPack: 1 })),
      },
      pharmacyStockBalance: {
        findFirst: vi.fn(async () => ({ onHandUnits: 5, sealedPacks: 0, looseUnits: 5 })),
      },
      // DEV-1052: the hold's owner is recorded after the movements, under the same locks.
      pharmacyRecallQuarantineAction: {
        aggregate: vi.fn(async () => ({ _sum: { quantityUnits: null } })),
      },
      pharmacyQuarantineHoldEntry: {
        groupBy: vi.fn(async () => [{ authority: 'SAFETY', _sum: { quantityUnits: 5 } }]),
        create: vi.fn(async () => ({})),
      },
      pharmacyStockMovement: { create: movementCreate(trace) },
    };
    await quarantinePart(db as never, scope, {
      inventoryLotId: 'lot-a',
      stockLocationId: 'shelf',
      units: 1,
      damaged,
      reason: 'Damaged on the shelf',
      idempotencyKeyPrefix: 'quarantine',
    });
    expect(trace.balanceKeys()).toEqual(['lot-a/shelf/AVAILABLE', `lot-a/shelf/${target}`]);
    expectLockedBeforeWrites(trace);
  });

  it('locks AVAILABLE before QUARANTINE before releasing quarantined stock', async () => {
    const trace = recorder();
    const db = {
      $queryRaw: trace.$queryRaw,
      pharmacyInventoryLot: {
        findFirst: vi.fn(async () => ({ id: 'lot-a', unitsPerPack: 1 })),
      },
      pharmacyStockBalance: {
        findFirst: vi.fn(async () => ({ onHandUnits: 5, sealedPacks: 0, looseUnits: 5 })),
      },
      pharmacyRecallQuarantineAction: {
        findMany: vi.fn(async () => []),
        aggregate: vi.fn(async () => ({ _sum: { quantityUnits: null } })),
      },
      // DEV-1052: five units held under safety authority, released by safety.
      pharmacyQuarantineHoldEntry: {
        groupBy: vi.fn(async () => [{ authority: 'SAFETY', _sum: { quantityUnits: 5 } }]),
        create: vi.fn(async () => ({})),
      },
      pharmacyStockMovement: { findMany: vi.fn(async () => []), create: movementCreate(trace) },
    };
    await releaseQuarantinedPart(db as never, scope, {
      inventoryLotId: 'lot-a',
      stockLocationId: 'shelf',
      units: 1,
      reason: 'Inspected',
      idempotencyKeyPrefix: 'release',
      rights: { safety: true, inventory: false },
    });
    expect(trace.balanceKeys()).toEqual(['lot-a/shelf/AVAILABLE', 'lot-a/shelf/QUARANTINE']);
    expectLockedBeforeWrites(trace);
  });
});

describe('write-off takes stock locks in the global order', () => {
  it.each([
    ['a second-person witness', 'witness', false],
    ['the solo self-witness (DEV-628)', 'actor', true],
  ])(
    'locks the written-off balance before reading or writing it, with %s',
    async (_label, witnessId, solo) => {
      const trace = recorder();
      const db = {
        $queryRaw: trace.$queryRaw,
        user: { findFirst: vi.fn(async () => ({ id: witnessId })) },
        pharmacyInventoryLot: {
          findFirst: vi.fn(async () => ({
            id: 'lot-a',
            unitsPerPack: 1,
            manufacturingBatchId: 'batch-a',
          })),
        },
        pharmacyManufacturingBatch: {
          findFirst: vi.fn(async () => ({ state: 'ACTIVE', expiresAt: new Date('2100-01-01') })),
        },
        pharmacyStockBalance: {
          findFirst: vi.fn(async () => {
            trace.events.push({ kind: 'read', values: [], text: 'balance read' });
            return { onHandUnits: 5, sealedPacks: 0, looseUnits: 5 };
          }),
        },
        pharmacyStockMovement: { create: movementCreate(trace) },
        pharmacyCustodyRecord: { create: vi.fn(async () => ({ id: 'custody' })) },
      };
      await writeOff(
        db as never,
        scope,
        {
          inventoryLotId: 'lot-a',
          stockLocationId: 'shelf',
          units: 1,
          witnessId,
          reason: 'Damaged',
          evidenceRef: 'PHOTO-1',
          idempotencyKey: 'write-off',
        },
        { soloSelfWitness: solo }
      );
      expect(trace.balanceKeys()).toEqual(['lot-a/shelf/AVAILABLE']);
      const lockAt = trace.events.findIndex((event) => event.kind === 'balance');
      const readAt = trace.events.findIndex((event) => event.text === 'balance read');
      expect(lockAt).toBeLessThan(readAt);
      // DEV-957: the counter holds are read after the balance is locked, never before.
      const holdsAt = trace.events.findIndex((event) => event.text.includes('"counterName"'));
      expect(holdsAt).toBeGreaterThan(lockAt);
      expectLockedBeforeWrites(trace);
    }
  );
});

describe('supplier claims and returns take stock locks in the global order', () => {
  it('shares the batch, then locks the lot balances, before reading a claim', async () => {
    const trace = recorder(() => [{ onHandUnits: 10, state: 'ACTIVE' }]);
    const db = {
      $queryRaw: trace.$queryRaw,
      pharmacySupplierClaim: {
        aggregate: vi.fn(async () => ({ _sum: { reservedUnits: 0 } })),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          trace.write(data);
          return data;
        }),
      },
    };
    await reserveSupplierClaim(db as never, scope, {
      inventoryLotId: 'lot-a',
      reservedUnits: 1,
      returnBy: new Date('2100-01-01'),
    });
    expect(trace.locks().map((event) => event.kind)).toEqual(['batch', 'balance']);
    expect(trace.locks()[0]!.text).toContain('FOR SHARE');
    expectLockedBeforeWrites(trace);
  });

  function purchaseReturnDb(trace: ReturnType<typeof recorder>, status: string) {
    const line = (id: string, lot: string) => ({
      id,
      inventoryLotId: lot,
      stockLocationId: 'shelf',
      quantityUnits: 1,
      reason: 'Damaged',
      returnWindowEndsAt: new Date('2100-01-01'),
      lot: { unitsPerPack: 1, batch: { medicine: { controlled: false } } },
      supplierClaimId: null,
    });
    return {
      $queryRaw: trace.$queryRaw,
      pharmacyPurchaseReturn: {
        findFirst: vi.fn(async () => ({
          id: 'return',
          status,
          lines: [line('line-2', 'lot-b'), line('line-1', 'lot-a')],
        })),
        update: vi.fn(async () => ({ id: 'return' })),
      },
      pharmacyInventoryLot: { findFirst: vi.fn(async () => ({ unitsPerPack: 1 })) },
      pharmacyStockBalance: {
        findFirst: vi.fn(async () => ({ onHandUnits: 5, sealedPacks: 0, looseUnits: 5 })),
      },
      pharmacySupplierClaim: {
        aggregate: vi.fn(async () => ({ _sum: { reservedUnits: 0 } })),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          trace.write(data);
          return { id: `claim-${String(data.inventoryLotId)}` };
        }),
      },
      pharmacyPurchaseReturnLine: { update: vi.fn(async () => ({})) },
      pharmacyStockMovement: { create: movementCreate(trace) },
    };
  }

  it('locks every returned lot up front; the per-line claim checks only re-enter it', async () => {
    const trace = recorder(() => [{ onHandUnits: 5, unitsPerPack: 1 }]);
    await submitPurchaseReturn(purchaseReturnDb(trace, 'DRAFT') as never, scope, {
      purchaseReturnId: 'return',
      at: new Date(),
    });
    const [first, ...later] = trace.locks();
    expect(first?.kind).toBe('balance');
    const lotsIn = (event: Event) =>
      event.values.map(String).filter((value) => value.startsWith('lot-'));
    expect(lotsIn(first!).sort()).toEqual(['lot-a', 'lot-b']);
    // The first claim is written only after every lot is locked.
    const firstClaim = trace.events.findIndex((event) => event.kind === 'write');
    expect(trace.events.indexOf(first!)).toBeLessThan(firstClaim);
    for (const event of later) {
      expect(event.kind).toBe('balance');
      for (const lot of lotsIn(event)) expect(lotsIn(first!)).toContain(lot);
    }
    expect(trace.strayLocks()).toEqual([]);
  });

  it('locks every dispatched return balance, sorted, before the first write', async () => {
    const trace = recorder();
    await dispatchPurchaseReturn(purchaseReturnDb(trace, 'SUBMITTED') as never, scope, {
      purchaseReturnId: 'return',
      at: new Date(),
      idempotencyKeyPrefix: 'return',
    });
    expect(trace.balanceKeys()).toEqual([
      'lot-a/shelf/AVAILABLE',
      'lot-a/shelf/RETURN_TO_SUPPLIER',
      'lot-b/shelf/AVAILABLE',
      'lot-b/shelf/RETURN_TO_SUPPLIER',
    ]);
    expectLockedBeforeWrites(trace);
  });
});

describe('recall quarantine reversal takes stock locks in the global order', () => {
  it('locks the batches, then every balance sorted, before reversing, then releases', async () => {
    const trace = recorder(() => [{ id: 'batch', medicineId: 'medicine' }]);
    const movement = (id: string, lot: string, disposition: string) => ({
      id,
      branchId: 'branch',
      inventoryLotId: lot,
      stockLocationId: 'shelf',
      kind: 'ADJUSTMENT',
      disposition,
      quantityUnits: disposition === 'AVAILABLE' ? -1 : 1,
      sealedPackDelta: 0,
      looseUnitDelta: disposition === 'AVAILABLE' ? -1 : 1,
    });
    const movements: Record<string, ReturnType<typeof movement>[]> = {
      'action-b': [
        movement('b-out', 'lot-b', 'AVAILABLE'),
        movement('b-in', 'lot-b', 'QUARANTINE'),
      ],
      'action-a': [
        movement('a-out', 'lot-a', 'AVAILABLE'),
        movement('a-in', 'lot-a', 'QUARANTINE'),
      ],
    };
    const db = {
      $queryRaw: trace.$queryRaw,
      $executeRaw: vi.fn(async (sql: Prisma.Sql) => {
        trace.events.push({ kind: 'write', values: [], text: sql.strings.join('?') });
        return 1;
      }),
      pharmacyRecallQuarantineAction: {
        findMany: vi.fn(async () => [
          { id: 'action-b', removedMovementId: 'b-out', heldMovementId: 'b-in' },
          { id: 'action-a', removedMovementId: 'a-out', heldMovementId: 'a-in' },
        ]),
        update: vi.fn(async () => ({})),
      },
      pharmacyRecallNotice: {
        findFirstOrThrow: vi.fn(async () => ({ id: 'recall', batchId: 'batch', medicineId: null })),
        update: vi.fn(async () => ({})),
      },
      pharmacyStockMovement: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          Object.values(movements)
            .flat()
            .filter((one) => where.id.in.includes(one.id))
        ),
        create: movementCreate(trace),
      },
    };
    await reverseRecallQuarantine(db as never, scope, 'recall', 'Recall withdrawn');
    expect(
      trace
        .locks()
        .map((event) => event.kind)
        .slice(0, 2)
    ).toEqual(['batch', 'balance']);
    expect(trace.balanceKeys()).toEqual([
      'lot-a/shelf/AVAILABLE',
      'lot-a/shelf/QUARANTINE',
      'lot-b/shelf/AVAILABLE',
      'lot-b/shelf/QUARANTINE',
    ]);
    // The batch release re-enters the batch lock it already holds; no new class follows a write.
    const firstWrite = trace.firstWrite();
    const newLocksAfterWrites = trace.events
      .slice(firstWrite)
      .filter(
        (event) => event.kind === 'balance' || event.kind === 'lot' || event.kind === 'medicine'
      );
    expect(newLocksAfterWrites).toEqual([]);
    expect(trace.strayLocks()).toEqual([]);
  });
});
