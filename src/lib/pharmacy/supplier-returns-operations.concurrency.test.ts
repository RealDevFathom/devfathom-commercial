/**
 * PUR-06 — two settlement allocations racing for the same remainder.
 *
 * A debit note (or a credit) has one remaining balance, and two finance users
 * can try to spend it at the same instant. Without a row lock both read
 * "nothing allocated yet", both pass `assertAllocatable` and both insert, so the
 * note ends up allocated twice its claim. These cases run two
 * `allocateSupplierCredit` calls concurrently against an in-memory store whose
 * `SELECT … FOR UPDATE` behaves like PostgreSQL's: a row lock is held until the
 * owning transaction finishes, and a second locker waits for it. Every store
 * call yields to the event loop first, so the two calls genuinely interleave.
 *
 * The database-backed twin of the single-caller cases lives in
 * `supplier-returns.db.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { allocateSupplierCredit } from './supplier-returns-operations';
import type { LedgerScope } from './stock-ledger';

const ORG = 'org_a';
const BRANCH = 'branch_a';
const SUPPLIER = 'supplier_1';
const AT = new Date('2026-09-02T09:00:00.000Z');

type Credit = { id: string; organizationId: string; supplierId: string; amountMinor: number };
type Allocation = {
  id: string;
  organizationId: string;
  supplierCreditId: string;
  debitNoteId: string;
  amountMinor: number;
  allocatedByUserId: string;
};
type Note = {
  id: string;
  organizationId: string;
  branchId: string;
  supplierId: string;
  purchaseReturnId: string;
  expectedCreditMinor: number;
  status: string;
};

type Store = {
  credits: Credit[];
  notes: Note[];
  allocations: Allocation[];
  returnStatus: Record<string, string>;
  locks: Map<string, Promise<void>>;
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeStore(credits: Credit[], notes: Note[]): Store {
  return {
    credits,
    notes,
    allocations: [],
    returnStatus: Object.fromEntries(notes.map((note) => [note.purchaseReturnId, 'DISPATCHED'])),
    locks: new Map(),
  };
}

/**
 * One transaction against the shared store. Row locks taken through
 * `$queryRaw … FOR UPDATE` are released only when `work` settles, exactly as a
 * PostgreSQL row lock is released only at COMMIT or ROLLBACK.
 */
async function inTransaction<T>(store: Store, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  const held: Array<() => void> = [];

  async function lockRow(key: string) {
    while (store.locks.has(key)) await store.locks.get(key);
    let release!: () => void;
    store.locks.set(
      key,
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    held.push(() => {
      store.locks.delete(key);
      release();
    });
  }

  const db = {
    async $queryRaw(query: { sql: string; values: unknown[] }) {
      await tick();
      if (!/FOR UPDATE/.test(query.sql)) throw new Error(`unexpected raw query: ${query.sql}`);
      const ids = query.values.filter((value): value is string => typeof value === 'string');
      if (query.sql.includes('"pharmacy_supplier_credits"')) {
        const row = store.credits.find((c) => ids.includes(c.id) && ids.includes(c.organizationId));
        if (row) await lockRow(`credit:${row.id}`);
        return row ? [{ id: row.id }] : [];
      }
      if (query.sql.includes('"pharmacy_debit_notes"')) {
        const row = store.notes.find(
          (n) => ids.includes(n.id) && ids.includes(n.organizationId) && ids.includes(n.branchId)
        );
        if (row) await lockRow(`note:${row.id}`);
        return row ? [{ id: row.id }] : [];
      }
      throw new Error(`unexpected locked table: ${query.sql}`);
    },
    pharmacySupplierCredit: {
      async findFirst({ where }: { where: { id: string; organizationId: string } }) {
        await tick();
        const row = store.credits.find(
          (c) => c.id === where.id && c.organizationId === where.organizationId
        );
        return row ? { ...row } : null;
      },
    },
    pharmacyDebitNote: {
      async findFirst({
        where,
      }: {
        where: { id: string; organizationId: string; branchId: string };
      }) {
        await tick();
        const row = store.notes.find(
          (n) =>
            n.id === where.id &&
            n.organizationId === where.organizationId &&
            n.branchId === where.branchId
        );
        if (!row) return null;
        return {
          ...row,
          allocations: store.allocations.filter((a) => a.debitNoteId === row.id),
          purchaseReturn: {
            id: row.purchaseReturnId,
            status: store.returnStatus[row.purchaseReturnId],
            submittedByUserId: 'user_clerk',
          },
        };
      },
      async update({ where, data }: { where: { id: string }; data: { status: string } }) {
        await tick();
        const row = store.notes.find((n) => n.id === where.id)!;
        row.status = data.status;
        return { ...row };
      },
    },
    pharmacySupplierCreditAllocation: {
      async aggregate({ where }: { where: { organizationId: string; supplierCreditId: string } }) {
        await tick();
        const rows = store.allocations.filter(
          (a) =>
            a.organizationId === where.organizationId &&
            a.supplierCreditId === where.supplierCreditId
        );
        return {
          _sum: { amountMinor: rows.length ? rows.reduce((t, a) => t + a.amountMinor, 0) : null },
        };
      },
      async create({ data }: { data: Omit<Allocation, 'id'> }) {
        await tick();
        if (
          store.allocations.some(
            (a) =>
              a.supplierCreditId === data.supplierCreditId && a.debitNoteId === data.debitNoteId
          )
        ) {
          throw new Error('unique violation on (supplierCreditId, debitNoteId)');
        }
        const row = { id: `alloc_${store.allocations.length + 1}`, ...data };
        store.allocations.push(row);
        return { ...row };
      },
    },
    pharmacyPurchaseReturn: {
      async update({ where, data }: { where: { id: string }; data: { status: string } }) {
        await tick();
        store.returnStatus[where.id] = data.status;
        return { id: where.id, ...data };
      },
    },
  } as unknown as ScopedDb;

  try {
    return await work(db);
  } finally {
    for (const release of held.splice(0)) release();
  }
}

function scope(actorId: string): LedgerScope {
  return { organizationId: ORG, branchId: BRANCH, actorId } as LedgerScope;
}

function credit(id: string, amountMinor: number): Credit {
  return { id, organizationId: ORG, supplierId: SUPPLIER, amountMinor };
}

function note(id: string, expectedCreditMinor: number): Note {
  return {
    id,
    organizationId: ORG,
    branchId: BRANCH,
    supplierId: SUPPLIER,
    purchaseReturnId: `return_${id}`,
    expectedCreditMinor,
    status: 'OPEN',
  };
}

function allocated(store: Store, by: (a: Allocation) => boolean) {
  return store.allocations.filter(by).reduce((total, a) => total + a.amountMinor, 0);
}

describe('PUR-06 — concurrent settlement allocation', () => {
  it('lets exactly one of two credits settle the same debit note', async () => {
    const store = makeStore(
      [credit('credit_1', 10_000), credit('credit_2', 10_000)],
      [note('note_1', 10_000)]
    );

    const results = await Promise.allSettled([
      inTransaction(store, (db) =>
        allocateSupplierCredit(db, scope('user_finance_a'), {
          supplierCreditId: 'credit_1',
          debitNoteId: 'note_1',
          amountMinor: 10_000,
          at: AT,
        })
      ),
      inTransaction(store, (db) =>
        allocateSupplierCredit(db, scope('user_finance_b'), {
          supplierCreditId: 'credit_2',
          debitNoteId: 'note_1',
          amountMinor: 10_000,
          at: AT,
        })
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      reason: 'OVER_ALLOCATION',
    });
    expect(allocated(store, (a) => a.debitNoteId === 'note_1')).toBe(10_000);
    expect(store.notes[0]!.status).toBe('SETTLED');
  });

  it('lets one credit settle only as many notes as it can cover', async () => {
    const store = makeStore(
      [credit('credit_1', 10_000)],
      [note('note_1', 10_000), note('note_2', 10_000)]
    );

    const results = await Promise.allSettled([
      inTransaction(store, (db) =>
        allocateSupplierCredit(db, scope('user_finance_a'), {
          supplierCreditId: 'credit_1',
          debitNoteId: 'note_1',
          amountMinor: 10_000,
          at: AT,
        })
      ),
      inTransaction(store, (db) =>
        allocateSupplierCredit(db, scope('user_finance_b'), {
          supplierCreditId: 'credit_1',
          debitNoteId: 'note_2',
          amountMinor: 10_000,
          at: AT,
        })
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      reason: 'OVER_ALLOCATION',
    });
    expect(allocated(store, (a) => a.supplierCreditId === 'credit_1')).toBe(10_000);
  });

  it('still lets two partial allocations that fit together both commit', async () => {
    const store = makeStore(
      [credit('credit_1', 4_000), credit('credit_2', 6_000)],
      [note('note_1', 10_000)]
    );

    const results = await Promise.all([
      inTransaction(store, (db) =>
        allocateSupplierCredit(db, scope('user_finance_a'), {
          supplierCreditId: 'credit_1',
          debitNoteId: 'note_1',
          amountMinor: 4_000,
          at: AT,
        })
      ),
      inTransaction(store, (db) =>
        allocateSupplierCredit(db, scope('user_finance_b'), {
          supplierCreditId: 'credit_2',
          debitNoteId: 'note_1',
          amountMinor: 6_000,
          at: AT,
        })
      ),
    ]);

    expect(results).toHaveLength(2);
    expect(allocated(store, (a) => a.debitNoteId === 'note_1')).toBe(10_000);
    // The second to take the note lock sees the first's allocation, so it — not a
    // stale read — moves the note to SETTLED.
    expect(store.notes[0]!.status).toBe('SETTLED');
    expect(store.returnStatus['return_note_1']).toBe('SETTLED');
  });
});
