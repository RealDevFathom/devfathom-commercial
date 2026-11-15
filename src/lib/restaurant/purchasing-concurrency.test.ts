/**
 * DEV-775 — concurrent receive and cancel on one purchase order must admit
 * exactly ONE valid lifecycle result.
 *
 * A small in-memory database models the parts of PostgreSQL that matter here:
 * READ COMMITTED transactions (writes are staged and become visible on commit,
 * discarded on rollback) and `SELECT … FOR UPDATE` row locks held until the
 * transaction ends. An observer pauses the first command right after it reads
 * the PO status and lets the second command run until it either finishes or
 * blocks on the row lock, then resumes the first — the exact interleaving from
 * the QA reproduction. The real `cancelPurchaseOrder` / `receivePurchaseOrder`
 * run against it; only the stock-ledger primitive is stubbed (it records the
 * movements it would post into the same transaction).
 */
import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('./inventory-ledger', () => ({
  runStockTransaction: <T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>) =>
    (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work),
  postStockMovements: async (tx: FakeTx, input: { movements: readonly unknown[] }) => {
    tx.stage((state) => {
      state.movements += input.movements.length;
    });
    return { movements: [], replayed: false };
  },
}));

import { cancelPurchaseOrder, receivePurchaseOrder } from './purchasing';

type State = {
  status: string;
  cancelledAt: Date | null;
  receipts: string[];
  receiptLines: { purchaseOrderLineId: string; receivedQuantity: Prisma.Decimal }[];
  movements: number;
};

const PO = 'po_1';
const LINE = 'po_line_1';
const ITEM = 'stock_item_1';
const UNIT = 'unit_each';

const clone = (state: State): State => ({
  ...state,
  receipts: [...state.receipts],
  receiptLines: [...state.receiptLines],
});

class Mutex {
  private holder: object | null = null;
  private queue: Array<() => void> = [];
  waiting = 0;

  async acquire(owner: object, onWait: () => void) {
    if (this.holder === owner) return;
    while (this.holder) {
      this.waiting += 1;
      onWait();
      await new Promise<void>((resolve) => this.queue.push(resolve));
      this.waiting -= 1;
    }
    this.holder = owner;
  }

  release(owner: object) {
    if (this.holder !== owner) return;
    this.holder = null;
    this.queue.shift()?.();
  }
}

type Observer = (session: string) => Promise<void>;

class FakeDatabase {
  committed: State = {
    status: 'APPROVED',
    cancelledAt: null,
    receipts: [],
    receiptLines: [],
    movements: 0,
  };
  readonly rowLock = new Mutex();
  private blockedListeners = new Map<string, () => void>();
  private observers = new Map<string, Observer>();

  onStatusRead(session: string, observer: Observer) {
    this.observers.set(session, observer);
  }

  /** Resolves once `session` is waiting on the PO row lock. */
  blocked(session: string): Promise<'blocked'> {
    return new Promise((resolve) => this.blockedListeners.set(session, () => resolve('blocked')));
  }

  notifyBlocked(session: string) {
    this.blockedListeners.get(session)?.();
  }

  async statusRead(session: string) {
    const observer = this.observers.get(session);
    if (!observer) return;
    this.observers.delete(session);
    await observer(session);
  }

  client(session: string): ScopedDb {
    return clientFor(this, session);
  }
}

/** A per-session client: model calls auto-commit; `$transaction` opens one. */
function clientFor(database: FakeDatabase, session: string): ScopedDb {
  const autocommit = (pick: (tx: FakeTx) => unknown) =>
    new Proxy(
      {},
      {
        get(_target, operation) {
          return async (...args: unknown[]) => {
            const tx = new FakeTx(database, session);
            try {
              const delegate = pick(tx) as Record<string, (...values: unknown[]) => unknown>;
              const result = await delegate[operation as string]!(...args);
              tx.commit();
              return result;
            } catch (error) {
              tx.rollback();
              throw error;
            }
          };
        },
      }
    );
  return new Proxy({} as ScopedDb, {
    get(_target, key) {
      if (key === '$transaction') {
        return async (work: (tx: FakeTx) => Promise<unknown>) => {
          const tx = new FakeTx(database, session);
          try {
            const result = await work(tx);
            tx.commit();
            return result;
          } catch (error) {
            tx.rollback();
            throw error;
          }
        };
      }
      return autocommit((tx) => (tx as unknown as Record<string, unknown>)[key as string]);
    },
  });
}

class FakeTx {
  private staged: Array<(state: State) => void> = [];

  constructor(
    private readonly database: FakeDatabase,
    private readonly session: string
  ) {}

  /** Committed state plus this transaction's own staged writes. */
  private view(): State {
    const state = clone(this.database.committed);
    for (const write of this.staged) write(state);
    return state;
  }

  stage(write: (state: State) => void) {
    this.staged.push(write);
  }

  commit() {
    for (const write of this.staged) write(this.database.committed);
    this.staged = [];
    this.database.rowLock.release(this);
  }

  rollback() {
    this.staged = [];
    this.database.rowLock.release(this);
  }

  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join('?');
    if (!/FROM restaurant_purchase_orders/.test(sql) || !/FOR UPDATE/.test(sql)) {
      throw new Error(`Unexpected raw SQL: ${sql}`);
    }
    if (values[0] !== PO) return [];
    await this.database.rowLock.acquire(this, () => this.database.notifyBlocked(this.session));
    const rows = [{ id: PO, status: this.view().status }];
    await this.database.statusRead(this.session);
    return rows;
  }

  restaurantPurchaseOrder = {
    findUnique: async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
      if (args.where.id !== PO) return null;
      const state = this.view();
      const row = {
        id: PO,
        status: state.status,
        supplierId: 'supplier_1',
        supplier: { name: 'Acme Foods' },
        branchId: 'branch_1',
        locationId: 'location_1',
        reference: null,
        expectedDate: null,
        submittedAt: null,
        approvedAt: null,
        closedAt: null,
        cancelledAt: state.cancelledAt,
        createdByStaffProfileId: null,
        approvedByStaffProfileId: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        lines: [
          {
            id: LINE,
            stockItemId: ITEM,
            orderedQuantity: new Prisma.Decimal(10),
            unitId: UNIT,
            unitCost: new Prisma.Decimal('2.00'),
          },
        ],
        receipts: state.receipts.map((id) => ({
          id,
          locationId: 'location_1',
          reference: null,
          receivedAt: new Date(0),
          staffProfileId: null,
          _count: { lines: 1, discrepancies: 0 },
        })),
      };
      // The pre-fix commands read the status with a plain (unlocked) read.
      if (args.select?.status && !args.select?.supplier) {
        await this.database.statusRead(this.session);
      }
      return row;
    },
    update: async (args: { where: { id: string }; data: Partial<State> }) => {
      this.stage((state) => Object.assign(state, args.data));
      return { id: args.where.id };
    },
    updateMany: async (args: {
      where: { id: string; status?: { in: string[] } };
      data: Partial<State>;
    }) => {
      // Mirrors PostgreSQL: an UPDATE waits for the row lock, then re-checks.
      await this.database.rowLock.acquire(this, () => this.database.notifyBlocked(this.session));
      const state = this.view();
      const matches =
        args.where.id === PO && (!args.where.status || args.where.status.in.includes(state.status));
      if (matches) this.stage((target) => Object.assign(target, args.data));
      return { count: matches ? 1 : 0 };
    },
  };

  restaurantPurchaseReceipt = {
    create: async () => {
      const id = `receipt_${this.session}`;
      this.stage((state) => state.receipts.push(id));
      return { id };
    },
    findUnique: async (args: { where: { id: string } }) => {
      const state = this.view();
      if (!state.receipts.includes(args.where.id)) return null;
      return {
        id: args.where.id,
        purchaseOrderId: PO,
        purchaseOrder: { status: state.status },
        movements: [],
        discrepancies: [],
      };
    },
  };

  restaurantPurchaseReceiptLine = {
    create: async (args: {
      data: { purchaseOrderLineId: string; receivedQuantity: Prisma.Decimal };
    }) => {
      this.stage((state) =>
        state.receiptLines.push({
          purchaseOrderLineId: args.data.purchaseOrderLineId,
          receivedQuantity: args.data.receivedQuantity,
        })
      );
      return { id: `receipt_line_${this.session}` };
    },
    findMany: async () =>
      this.view().receiptLines.map((line) => ({
        purchaseOrderLineId: line.purchaseOrderLineId,
        stockItemId: ITEM,
        receivedQuantity: line.receivedQuantity,
        unitId: UNIT,
      })),
  };

  restaurantPurchaseOrderLine = {
    findMany: async () => [
      { id: LINE, stockItemId: ITEM, orderedQuantity: new Prisma.Decimal(10), unitId: UNIT },
    ],
  };

  restaurantStockItem = {
    findMany: async () => [{ id: ITEM, canonicalUnitId: UNIT }],
  };
}

const receiveAll = (db: ScopedDb) =>
  receivePurchaseOrder(db, {
    purchaseOrderId: PO,
    lines: [{ purchaseOrderLineId: LINE, receivedQuantity: '10' }],
    now: new Date('2026-11-15T06:00:00.000Z'),
  });

const cancel = (db: ScopedDb) => cancelPurchaseOrder(db, PO, new Date('2026-11-15T06:00:00.000Z'));

/**
 * Run `first` until it reads the PO status, then run `second` until it either
 * settles or blocks on the PO row lock, then let `first` continue.
 */
async function interleave(
  database: FakeDatabase,
  first: { session: string; run: (db: ScopedDb) => Promise<unknown> },
  second: { session: string; run: (db: ScopedDb) => Promise<unknown> }
) {
  let secondRun: Promise<unknown> | undefined;
  database.onStatusRead(first.session, async () => {
    const blocked = database.blocked(second.session);
    secondRun = second.run(database.client(second.session));
    await Promise.race([secondRun.then(noop, noop), blocked]);
  });
  const firstRun = first.run(database.client(first.session));
  const firstResult = await Promise.allSettled([firstRun]);
  const secondResult = await Promise.allSettled([secondRun!]);
  return { first: firstResult[0]!, second: secondResult[0]! };
}

function noop() {}

function expectSingleValidOutcome(
  database: FakeDatabase,
  results: PromiseSettledResult<unknown>[]
) {
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.reason).toMatchObject({ name: 'PurchasingError', reason: 'INVALID_STATE' });

  const state = database.committed;
  if (state.status === 'CANCELLED') {
    // Cancellation won: no receipt and no stock posting may survive.
    expect(state.receipts).toHaveLength(0);
    expect(state.receiptLines).toHaveLength(0);
    expect(state.movements).toBe(0);
  } else {
    // Receiving won: the order is RECEIVED with its one receipt, never cancelled.
    expect(state.status).toBe('RECEIVED');
    expect(state.cancelledAt).toBeNull();
    expect(state.receipts).toHaveLength(1);
    expect(state.movements).toBe(1);
  }
}

describe('DEV-775 purchase order receive vs cancel concurrency', () => {
  it('rejects a stale cancel once a concurrent receipt has committed (cancel reads first)', async () => {
    const database = new FakeDatabase();
    const { first, second } = await interleave(
      database,
      { session: 'cancel', run: cancel },
      { session: 'receive', run: receiveAll }
    );
    expectSingleValidOutcome(database, [first, second]);
  });

  it('rejects a receipt against an order cancelled while it waited (receive reads first)', async () => {
    const database = new FakeDatabase();
    const { first, second } = await interleave(
      database,
      { session: 'receive', run: receiveAll },
      { session: 'cancel', run: cancel }
    );
    expectSingleValidOutcome(database, [first, second]);
  });

  it('still cancels an untouched APPROVED order and receives an uncontended one', async () => {
    const cancelDb = new FakeDatabase();
    const cancelled = await cancel(cancelDb.client('cancel'));
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelDb.committed.status).toBe('CANCELLED');

    const receiveDb = new FakeDatabase();
    const received = await receiveAll(receiveDb.client('receive'));
    expect(received.purchaseOrderStatus).toBe('RECEIVED');
    expect(receiveDb.committed.receipts).toHaveLength(1);

    await expect(cancel(receiveDb.client('cancel'))).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
    expect(receiveDb.committed.status).toBe('RECEIVED');
  });
});
