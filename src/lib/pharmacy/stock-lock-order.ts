/**
 * DEV-825 — the one global order in which pharmacy stock locks are taken.
 *
 * Goods-in, the controlled-drug register, sales (counter, reserved and
 * customer-order handoff), voids, returns and reversals all lock some subset of
 * the same rows. Two transactions only deadlock when they take two of those
 * locks in opposite orders, so every path takes them in this order and never
 * goes back to an earlier class once it holds a later one:
 *
 *   0. document rows and request-scoped advisory locks (sale, receipt, purchase
 *      order, prescription line, idempotency key) — these never span stock;
 *   1. `register` — the branch controlled-register advisory lock
 *      (`lockRegister`), taken BEFORE any stock row whenever the transaction
 *      will write a controlled-register row;
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
 * Inserting a lot or a stock movement makes Postgres take FOR KEY SHARE on the
 * referenced batch, medicine and lot rows after the balances are already held.
 * Those implicit locks would invert the order against an explicit FOR UPDATE,
 * so explicit batch, medicine and lot locks are FOR NO KEY UPDATE: they still
 * serialize every explicit locker but never wait on, or block, a foreign-key
 * check.
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

/**
 * Lock the balance rows for `keys`, in the global in-class order, in one
 * statement. Must run inside the caller's transaction.
 */
export async function lockStockBalances(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
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
      AND "balance"."branchId" = ${scope.branchId}
      AND ("balance"."inventoryLotId", "balance"."stockLocationId", "balance"."disposition"::text) IN (${Prisma.join(
        sorted.map(
          (key) => Prisma.sql`(${key.inventoryLotId}, ${key.stockLocationId}, ${key.disposition})`
        )
      )})
    ${balanceLockOrderBy('balance')}
    FOR UPDATE`);
}

/**
 * Lock every batch, medicine, lot and balance row a stock query touches, one
 * class at a time in the global order, each class in ascending key order.
 *
 * `source` is a SELECT (it may carry its own joins, filters and ORDER BY) that
 * returns the columns "batchId", "medicineId", "branchId", "inventoryLotId",
 * "stockLocationId" and "disposition" (text) for each balance it touches.
 * Locking the joined query in one FOR UPDATE OF statement would interleave the
 * classes row by row (balance 1 before batch 2), which is exactly the inversion
 * this module exists to remove.
 */
export async function lockStockRowsFrom(db: ScopedDb, organizationId: string, source: Prisma.Sql) {
  await db.$queryRaw(Prisma.sql`
    /* stock_lock:batch */
    SELECT "id" FROM "pharmacy_manufacturing_batches"
    WHERE "organizationId" = ${organizationId}
      AND "id" IN (SELECT "source"."batchId" FROM (${source}) "source")
    ORDER BY "id" COLLATE "C"
    FOR NO KEY UPDATE`);
  await db.$queryRaw(Prisma.sql`
    /* stock_lock:medicine */
    SELECT "id" FROM "pharmacy_medicines"
    WHERE "organizationId" = ${organizationId}
      AND "id" IN (SELECT "source"."medicineId" FROM (${source}) "source")
    ORDER BY "id" COLLATE "C"
    FOR NO KEY UPDATE`);
  await db.$queryRaw(Prisma.sql`
    /* stock_lock:lot */
    SELECT "id" FROM "pharmacy_inventory_lots"
    WHERE "organizationId" = ${organizationId}
      AND "id" IN (SELECT "source"."inventoryLotId" FROM (${source}) "source")
    ORDER BY "id" COLLATE "C"
    FOR NO KEY UPDATE`);
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
