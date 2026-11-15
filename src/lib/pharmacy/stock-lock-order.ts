/**
 * DEV-825 — the one global order in which pharmacy stock locks are taken.
 *
 * Every path that touches stock locks some subset of the same rows. Two
 * transactions only deadlock when they take two of those locks in opposite
 * orders, so every path takes them in this order and never goes back to an
 * earlier class once it holds a later one:
 *
 *   0. non-stock locks — document rows (sale, sale line, receipt, purchase
 *      order, transfer, count, order, prescription line), PIN credential rows of
 *      the people approving the action, and request-scoped advisory keys
 *      (idempotency, emergency supply, recall authority, owner import). Every
 *      one of them is taken before any register or stock lock. Where two paths
 *      lock the same pair of these rows they agree on its order: the receipt,
 *      purchase order, transfer, count or sale line an action is on comes before
 *      the PIN credential approving it (goods-in, receipt reversal, return,
 *      transfer receipt), while the credential comes before the sale row
 *      (controlled dispensing, void) and before dispensing's own prescription
 *      line and emergency-supply key;
 *   1. `register` — the branch controlled-register advisory lock
 *      (`lockControlledRegister`), taken BEFORE any stock row whenever the
 *      transaction will write a controlled-register row;
 *   2. `batch`    — `pharmacy_manufacturing_batches` rows;
 *   3. `medicine` — `pharmacy_medicines` rows;
 *   4. `lot`      — `pharmacy_inventory_lots` rows;
 *   5. `balance`  — `pharmacy_stock_balances` rows.
 *
 * Inside a class, rows are locked in ascending key order under the "C"
 * collation, which is the same order JavaScript's code-unit string comparison
 * gives (`compareBalanceLockKeys`). A balance key is
 * (inventoryLotId, stockLocationId, disposition).
 *
 * Rules every path follows:
 * - Every explicit stock-row lock and the register lock is taken through this
 *   module (`lockStockBalances`, `lockStockRowsFrom`, `lockControlledRegister`),
 *   which sorts the keys and takes the classes in order. A guard test fails on
 *   a stock-row locking clause anywhere else.
 * - A movement write locks its balance through the projection trigger, so a
 *   transaction that writes several balances locks all of them first, in one
 *   sorted statement, before the first write.
 * - Inserting a lot or a movement makes Postgres take FOR KEY SHARE on the
 *   referenced batch, medicine and lot rows after the balances are held. Those
 *   implicit locks would invert the order against an explicit FOR UPDATE, so
 *   explicit batch, medicine and lot locks are FOR NO KEY UPDATE (or FOR SHARE):
 *   they serialize every explicit locker but never wait on a foreign-key check.
 *
 * Paths (multi-row ones have a lock-order test; single-row ones rely on the
 * guard and on locking through this module): counter sale and FEFO override
 * (`allocateForSale`), reserved sale and customer-order handoff, reservation
 * candidates (customer orders, refills), offline replay, checkout batch safety,
 * controlled dispensing, void, return, goods-in posting and reversal, the
 * controlled register, location moves (`transferStock`), transfers out
 * (`dispatchTransfer`) and in (`receiveTransferWithVariance`), count approval,
 * quarantine and its
 * release, expiry write-off and quarantine, recall creation, close, DRAP recall
 * confirmation and its reversal, supplier claims and purchase returns (submit,
 * dispatch), customer-delivery physical returns and the opening owner import.
 */
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export const STOCK_LOCK_ORDER = ['register', 'batch', 'medicine', 'lot', 'balance'] as const;
export type StockLockClass = (typeof STOCK_LOCK_ORDER)[number];

export type BalanceLockKey = {
  inventoryLotId: string;
  stockLocationId: string;
  disposition: string;
};

function byCodeUnit(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The in-class order for balance rows; matches `balanceLockOrderBy` in SQL. */
export function compareBalanceLockKeys(left: BalanceLockKey, right: BalanceLockKey) {
  return (
    byCodeUnit(left.inventoryLotId, right.inventoryLotId) ||
    byCodeUnit(left.stockLocationId, right.stockLocationId) ||
    byCodeUnit(left.disposition, right.disposition)
  );
}

/** `ORDER BY` for locking balance rows aliased `alias`, in the global in-class order. */
export function balanceLockOrderBy(alias: string) {
  const table = Prisma.raw(`"${alias.replace(/"/g, '')}"`);
  return Prisma.sql`ORDER BY ${table}."inventoryLotId" COLLATE "C", ${table}."stockLocationId" COLLATE "C", ${table}."disposition"::text COLLATE "C"`;
}

/** Lock rows of one organization; with `branchId`, only that branch's balances. */
export type StockLockScope = { organizationId: string; branchId?: string | null };

/**
 * Lock the balance rows for `keys`, in the global in-class order, in one
 * statement. Must run inside the caller's transaction. Lock every balance a
 * transaction will write BEFORE the first write: a movement write locks its
 * balance through the projection trigger, so writing several balances in
 * business order (line order, movement order) would lock them out of order.
 */
export async function lockStockBalances(
  db: ScopedDb,
  scope: StockLockScope,
  keys: readonly BalanceLockKey[]
) {
  const unique = new Map<string, BalanceLockKey>();
  for (const key of keys) {
    unique.set(`${key.inventoryLotId}\u0000${key.stockLocationId}\u0000${key.disposition}`, key);
  }
  const sorted = [...unique.values()].sort(compareBalanceLockKeys);
  if (sorted.length === 0) return;
  await db.$queryRaw(Prisma.sql`
    /* stock_lock:balance */
    SELECT "balance"."inventoryLotId" FROM "pharmacy_stock_balances" "balance"
    WHERE "balance"."organizationId" = ${scope.organizationId}
      ${scope.branchId ? Prisma.sql`AND "balance"."branchId" = ${scope.branchId}` : Prisma.empty}
      AND ("balance"."inventoryLotId", "balance"."stockLocationId", "balance"."disposition"::text) IN (${Prisma.join(
        sorted.map(
          (key) => Prisma.sql`(${key.inventoryLotId}, ${key.stockLocationId}, ${key.disposition})`
        )
      )})
    ${balanceLockOrderBy('balance')}
    FOR UPDATE`);
}

/**
 * Which classes `lockStockRowsFrom` locks, and how. `update` is FOR NO KEY
 * UPDATE; `share` is FOR SHARE (a reader that must exclude recall updates but
 * not other readers); `exclusive` is FOR UPDATE, which also blocks foreign-key
 * checks, so use it only on rows no path writes after holding a later class
 * (the opening import fencing off first movements into existing lots).
 * Balances are always FOR UPDATE.
 */
export type RowLockMode = 'update' | 'share' | 'exclusive';
export type StockRowLocks = {
  batch?: RowLockMode;
  medicine?: RowLockMode;
  lot?: RowLockMode;
  balance?: boolean;
};

const EVERY_CLASS: StockRowLocks = {
  batch: 'update',
  medicine: 'update',
  lot: 'update',
  balance: true,
};

function rowLock(mode: RowLockMode) {
  if (mode === 'share') return Prisma.sql`FOR SHARE`;
  if (mode === 'exclusive') return Prisma.sql`FOR UPDATE`;
  return Prisma.sql`FOR NO KEY UPDATE`;
}

/**
 * Lock the batch, medicine, lot and balance rows a stock query touches, one
 * class at a time in the global order, each class in ascending key order.
 *
 * `source` is a SELECT (it may carry its own joins, filters and ORDER BY, but
 * no locking clause) returning, for each row it touches, the columns the
 * requested classes need: "batchId" (batch), "medicineId" (medicine),
 * "inventoryLotId" (lot), and "branchId", "inventoryLotId", "stockLocationId",
 * "disposition" as text (balance). Locking a joined query in one FOR UPDATE OF
 * statement would interleave the classes row by row (balance 1 before batch 2),
 * which is exactly the inversion this module exists to remove.
 */
export async function lockStockRowsFrom(
  db: ScopedDb,
  organizationId: string,
  source: Prisma.Sql,
  locks: StockRowLocks = EVERY_CLASS
) {
  if (locks.batch)
    await db.$queryRaw(Prisma.sql`
    /* stock_lock:batch */
    SELECT "id" FROM "pharmacy_manufacturing_batches"
    WHERE "organizationId" = ${organizationId}
      AND "id" IN (SELECT "source"."batchId" FROM (${source}) "source")
    ORDER BY "id" COLLATE "C"
    ${rowLock(locks.batch)}`);
  if (locks.medicine)
    await db.$queryRaw(Prisma.sql`
    /* stock_lock:medicine */
    SELECT "id" FROM "pharmacy_medicines"
    WHERE "organizationId" = ${organizationId}
      AND "id" IN (SELECT "source"."medicineId" FROM (${source}) "source")
    ORDER BY "id" COLLATE "C"
    ${rowLock(locks.medicine)}`);
  if (locks.lot)
    await db.$queryRaw(Prisma.sql`
    /* stock_lock:lot */
    SELECT "id" FROM "pharmacy_inventory_lots"
    WHERE "organizationId" = ${organizationId}
      AND "id" IN (SELECT "source"."inventoryLotId" FROM (${source}) "source")
    ORDER BY "id" COLLATE "C"
    ${rowLock(locks.lot)}`);
  if (locks.balance)
    await db.$queryRaw(Prisma.sql`
    /* stock_lock:balance */
    SELECT "balance"."inventoryLotId" FROM "pharmacy_stock_balances" "balance"
    WHERE "balance"."organizationId" = ${organizationId}
      AND ("balance"."branchId", "balance"."inventoryLotId", "balance"."stockLocationId", "balance"."disposition"::text) IN (
        SELECT "source"."branchId", "source"."inventoryLotId", "source"."stockLocationId", "source"."disposition"
        FROM (${source}) "source"
      )
    ${balanceLockOrderBy('balance')}
    FOR UPDATE`);
}

/**
 * The `register` class: the branch controlled-register advisory lock. Every
 * transaction that writes the register takes it before any stock row.
 */
export async function lockControlledRegister(
  db: ScopedDb,
  organizationId: string,
  branchId: string
) {
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId + ':' + branchId}, 0))`;
}
