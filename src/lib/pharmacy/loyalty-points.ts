import 'server-only';

import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import {
  categoryEarnPoints,
  DEFAULT_LOYALTY_POINTS_RULES,
  type LoyaltyPointsRules,
} from '@/lib/commerce/loyalty-arithmetic';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import type { LedgerScope } from './stock-ledger';

export type PharmacyPointsPolicy = LoyaltyPointsRules & {
  pointsExpiryMonths: number;
  goldTierEnabled: boolean;
  goldTierThresholdMinor: number;
};

export const DEFAULT_PHARMACY_POINTS_POLICY: PharmacyPointsPolicy = {
  ...DEFAULT_LOYALTY_POINTS_RULES,
  pointsExpiryMonths: 6,
  goldTierEnabled: false,
  goldTierThresholdMinor: 5_000_000,
};

export class PharmacyPointsError extends Error {
  constructor(readonly reason: 'CUSTOMER_NOT_FOUND') {
    super(reason);
  }
}

export function expiryDate(earnedAt: Date, months: number) {
  if (!Number.isInteger(months) || months <= 0) throw new RangeError('INVALID_EXPIRY_MONTHS');
  const expiresAt = new Date(earnedAt);
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + months);
  return expiresAt;
}

export function allocateNetPaid(
  subtotals: { medicineMinor: number; nonDrugMinor: number },
  netPaidMinor: number
) {
  const totalMinor = subtotals.medicineMinor + subtotals.nonDrugMinor;
  if (
    [subtotals.medicineMinor, subtotals.nonDrugMinor, netPaidMinor, totalMinor].some(
      (value) => !Number.isSafeInteger(value) || value < 0
    )
  )
    throw new RangeError('INVALID_MONEY');
  if (totalMinor === 0 || netPaidMinor === 0) return { medicineMinor: 0, nonDrugMinor: 0 };
  const capped = Math.min(netPaidMinor, totalMinor);
  // BigInt keeps the proportional split integer-only; deterministic remainder goes to non-drug.
  const medicineMinor = Number(
    (BigInt(capped) * BigInt(subtotals.medicineMinor)) / BigInt(totalMinor)
  );
  return { medicineMinor, nonDrugMinor: capped - medicineMinor };
}

export type PointsEntryKind =
  'EARN' | 'REDEEM' | 'REFUND' | 'EARN_REVERSAL' | 'EXPIRE' | 'REVERSAL' | 'ADJUST';

/** One points-ledger row, as the expiry planner reads it. */
export type PointsLedgerEntry = {
  id: string;
  kind: PointsEntryKind;
  points: number;
  occurredAt: Date;
  expiresAt: Date | null;
  saleId: string;
  tenderId: string | null;
  sourceEntryId: string | null;
};

/** An EXPIRE debit to write: `points` is negative; `expiredTotal` is the lot's running total. */
export type PointsExpiry = {
  sourceEntryId: string;
  saleId: string;
  points: number;
  expiredTotal: number;
};

type Lot = {
  id: string;
  saleId: string;
  expiresAt: Date | null;
  order: number;
  remaining: number;
  expired: number;
};

function never(expiresAt: Date | null) {
  return expiresAt === null ? Number.POSITIVE_INFINITY : expiresAt.getTime();
}

/**
 * Plan the EXPIRE debits for one customer's branch ledger at `at`, replaying every
 * balance-changing entry in order (docs/loyalty-3.md, "Source lots"):
 *
 * - A lot is an EARN, or a positive ADJUST, with its own expiry (`null` only on awards
 *   earned before expiry existed: they never expire).
 * - REDEEM and a negative ADJUST consume lots earliest-expiry first, skipping lots already
 *   expired at the entry's time. A REDEEM remembers which lots it consumed.
 * - REFUND restores a refunded redemption into the lots that redemption consumed, most
 *   recently consumed first, so restored points keep their original earning's expiry.
 * - EARN_REVERSAL debits the EARN of its sale (or the lot it names); EXPIRE and REVERSAL
 *   debit the lot they name. What a named lot cannot cover is consumed like a redemption.
 * - A debit nothing can cover becomes debt, repaid by the next credit before anything
 *   else, so no lot looks spendable while the balance is negative.
 *
 * Every remaining point of a lot whose expiry is at or before `at` expires, and the total
 * is capped at the balance: expiry never takes the balance below zero.
 */
export function planPointsExpiry(entries: readonly PointsLedgerEntry[], at: Date): PointsExpiry[] {
  const lots: Lot[] = [];
  const lotById = new Map<string, Lot>();
  const earnBySale = new Map<string, Lot>();
  const consumedByTender = new Map<string, Array<{ lot: Lot; points: number }>>();
  let debt = 0;
  let balance = 0;

  const repay = (points: number) => {
    const paid = Math.min(debt, points);
    debt -= paid;
    return points - paid;
  };
  const addLot = (entry: PointsLedgerEntry, expiresAt: Date | null, points: number) => {
    const lot: Lot = {
      id: entry.id,
      saleId: entry.saleId,
      expiresAt,
      order: lots.length,
      remaining: repay(points),
      expired: 0,
    };
    lots.push(lot);
    lotById.set(lot.id, lot);
    return lot;
  };
  // Earliest expiry first; lots expired by `when` only after every live one, so a debit
  // that live points cannot cover uses points that were due to expire before borrowing.
  const consume = (points: number, when: Date) => {
    const taken: Array<{ lot: Lot; points: number }> = [];
    let left = points;
    const live = (lot: Lot) => lot.expiresAt === null || lot.expiresAt.getTime() > when.getTime();
    const ordered = lots
      .filter((lot) => lot.remaining > 0)
      .sort(
        (a, b) =>
          Number(live(b)) - Number(live(a)) ||
          never(a.expiresAt) - never(b.expiresAt) ||
          a.order - b.order
      );
    for (const lot of ordered) {
      if (left === 0) break;
      const take = Math.min(lot.remaining, left);
      lot.remaining -= take;
      left -= take;
      taken.push({ lot, points: take });
    }
    debt += left;
    return taken;
  };
  const consumeLot = (lot: Lot | undefined, points: number, when: Date) => {
    const take = lot ? Math.min(lot.remaining, points) : 0;
    if (lot) lot.remaining -= take;
    if (points > take) consume(points - take, when);
  };

  // Entries of the same instant: credits first, so a debit written alongside a credit can
  // never show as debt (earliest-expiry consumption still spends older lots first).
  const ordered = [...entries].sort(
    (a, b) =>
      a.occurredAt.getTime() - b.occurredAt.getTime() ||
      Number(a.points < 0) - Number(b.points < 0) ||
      a.id.localeCompare(b.id)
  );
  for (const entry of ordered) {
    if (!Number.isSafeInteger(entry.points)) throw new RangeError('INVALID_POINTS_ENTRY');
    balance += entry.points;
    const debit = -entry.points;
    switch (entry.kind) {
      case 'EARN':
        earnBySale.set(entry.saleId, addLot(entry, entry.expiresAt, entry.points));
        break;
      case 'ADJUST':
        if (entry.points > 0) addLot(entry, entry.expiresAt, entry.points);
        else consume(debit, entry.occurredAt);
        break;
      case 'REDEEM': {
        const taken = consume(debit, entry.occurredAt);
        if (entry.tenderId) consumedByTender.set(entry.tenderId, taken);
        break;
      }
      case 'REFUND': {
        let left = repay(entry.points);
        const taken = (entry.tenderId && consumedByTender.get(entry.tenderId)) || [];
        for (let index = taken.length - 1; index >= 0 && left > 0; index -= 1) {
          const back = Math.min(taken[index]!.points, left);
          taken[index]!.points -= back;
          taken[index]!.lot.remaining += back;
          left -= back;
        }
        // A restoration with no recorded redemption behind it is not written by this
        // codebase; keep it in the balance without letting it expire anything else.
        if (left > 0) addLot(entry, null, left);
        break;
      }
      case 'EARN_REVERSAL':
        consumeLot(
          (entry.sourceEntryId && lotById.get(entry.sourceEntryId)) || earnBySale.get(entry.saleId),
          debit,
          entry.occurredAt
        );
        break;
      case 'EXPIRE':
      case 'REVERSAL': {
        const lot = entry.sourceEntryId ? lotById.get(entry.sourceEntryId) : undefined;
        if (lot && entry.kind === 'EXPIRE') lot.expired += debit;
        consumeLot(lot, debit, entry.occurredAt);
        break;
      }
    }
  }

  let budget = Math.max(0, balance);
  const plan: PointsExpiry[] = [];
  for (const lot of [...lots].sort(
    (a, b) => never(a.expiresAt) - never(b.expiresAt) || a.order - b.order
  )) {
    if (lot.expiresAt === null || lot.expiresAt.getTime() > at.getTime()) break;
    const points = Math.min(lot.remaining, budget);
    if (points <= 0) continue;
    budget -= points;
    plan.push({
      sourceEntryId: lot.id,
      saleId: lot.saleId,
      points: -points,
      expiredTotal: lot.expired + points,
    });
  }
  return plan;
}

export async function readPointsPolicy(db: ScopedDb, organizationId: string) {
  const rows = await db.$queryRaw<PharmacyPointsPolicy[]>(Prisma.sql`
    SELECT "medicineEarnPoints", "nonDrugEarnPoints", "earnBlockMinor", "pointValueMinor",
      "minimumRedemptionPoints", "pointsExpiryMonths", "goldTierEnabled",
      "goldTierThresholdMinor", "goldTierMultiplier"
    FROM pharmacy_loyalty_settings WHERE "organizationId"=${organizationId} LIMIT 1`);
  return rows[0] ?? DEFAULT_PHARMACY_POINTS_POLICY;
}

/**
 * Run `work` in one transaction: a tenant client opens one, a request transaction reuses
 * its own (`exposeNestedTransaction`), and a bare interactive-transaction client, which
 * has no `$transaction`, already is one.
 */
export function inPointsTransaction<T>(
  db: ScopedDb,
  work: (tx: ScopedDb) => Promise<T>
): Promise<T> {
  const open = (db as unknown as { $transaction?: unknown }).$transaction;
  return typeof open === 'function'
    ? (open as (run: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work)
    : work(db);
}

/**
 * Lock the customer's points account (the tenant-scoped `pharmacy_customers` row) for the
 * rest of the transaction. Every writer of the points balance takes this lock, so expiry,
 * earning, redemption, restoration and reversal of one customer run one at a time.
 */
export async function lockPointsAccount(
  tx: ScopedDb,
  organizationId: string,
  customerId: string
): Promise<void> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM pharmacy_customers
    WHERE "organizationId" = ${organizationId} AND id = ${customerId}
    FOR UPDATE`);
  if (locked.length !== 1) throw new PharmacyPointsError('CUSTOMER_NOT_FOUND');
}

/**
 * Append the EXPIRE debits due at `at` for one customer in one branch, atomically: the
 * account lock, the ledger read, the plan and the inserts share one transaction, so two
 * callers can never both act on the same plan, and a caller queued behind another plans
 * from its committed debits (and so writes nothing twice). Each debit's key names the
 * lot and its running expired total, so an exact replay of a plan cannot write twice.
 */
export async function expireCustomerPoints(
  db: ScopedDb,
  scope: LedgerScope,
  customerId: string,
  at = new Date()
): Promise<PointsExpiry[]> {
  return inPointsTransaction(db, async (tx) => {
    await lockPointsAccount(tx, scope.organizationId, customerId);
    const entries = await tx.$queryRaw<PointsLedgerEntry[]>(Prisma.sql`
      SELECT id, kind::text AS kind, points, "occurredAt", "expiresAt", "saleId", "tenderId",
        "sourceEntryId"
      FROM pharmacy_loyalty_points_entries
      WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
        AND "customerId" = ${customerId}
      ORDER BY "occurredAt", id`);
    const plan = planPointsExpiry(entries, at);
    for (const item of plan) {
      await tx.$executeRaw(Prisma.sql`INSERT INTO pharmacy_loyalty_points_entries
        (id, "organizationId", "branchId", "customerId", "saleId", kind, points, "sourceEntryId",
         "actorId", "idempotencyKey", "occurredAt")
        VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${customerId},
          ${item.saleId}, 'EXPIRE', ${item.points}, ${item.sourceEntryId}, ${scope.actorId},
          ${`loyalty:expire:${item.sourceEntryId}:${item.expiredTotal}`}, ${at})`);
    }
    return plan;
  });
}

export { categoryEarnPoints };
