import 'server-only';

/**
 * WHA-288 / promotions Lane A — §6, caps and concurrency.
 *
 * Per-order limits are settled inside the evaluator and need no ledger. The
 * GLOBAL, per-CUSTOMER and BUDGET caps do, because two checkouts can race for
 * the last application. §6 forbids the three easy implementations outright:
 * no read-then-write counter, no client-reported remaining cap, no asynchronous
 * decrement. What is left is a reservation ledger under a row lock:
 *
 *   1. lock the counter rows in stable `(promotionVersionId, scopeKind,
 *      scopeKey)` order — a fixed order is what makes two concurrent
 *      checkouts queue instead of deadlock;
 *   2. compute committed consumption PLUS live reservations;
 *   3. insert reservations and the checkout snapshot atomically, or reject them
 *      ALL with `PROMOTION_CAP_EXHAUSTED`;
 *   4. settlement converts each reservation to consumed in the OWNING
 *      transaction; cancellation appends a release.
 *
 * The arithmetic in step 2 is {@link planCapReservations} — a pure function, so
 * the interesting decisions are unit-testable without a database, and the
 * database test can concentrate on proving the LOCK actually serializes.
 *
 * Defence in depth: the migration also carries a CHECK
 * (`consumed <= cap`), so even a caller that bypassed this module cannot
 * commit an over-cap consumption — the transaction aborts instead.
 */

import { Prisma } from '@/generated/prisma/client';
import {
  PROMOTION_ERROR,
  PromotionError,
  type PromotionApplication,
  type PromotionCapScopeKind,
  type PromotionRule,
} from '@/lib/restaurant/promotion-contracts';
import { ZERO, add, compare, sub, sum } from '@/lib/restaurant/money';

/** The minimal Prisma surface this module needs — satisfied by both the client
 * and an interactive transaction handle, so callers pass their own `tx` and the
 * reservation shares the checkout's transaction boundary (§6). */
export type PromotionCapExecutor = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
};

/** One `(version, scope)` counter as read under the lock. */
export type PromotionCapCounterState = {
  promotionVersionId: string;
  scopeKind: PromotionCapScopeKind;
  scopeKey: string;
  capCount: number | null;
  capAmount: Prisma.Decimal | null;
  consumedCount: number;
  consumedAmount: Prisma.Decimal;
  /** Reservations still in RESERVED state — held but not yet consumed. */
  reservedCount: number;
  reservedAmount: Prisma.Decimal;
};

/** What one accepted application wants to take from one scope. */
export type PromotionCapRequest = {
  promotionVersionId: string;
  scopeKind: PromotionCapScopeKind;
  scopeKey: string;
  applicationOrdinal: number;
  count: number;
  amount: Prisma.Decimal;
};

export type PromotionCapPlan =
  | { granted: true; reservations: readonly PromotionCapRequest[] }
  | {
      granted: false;
      /** The first scope that could not satisfy the request, for the audit
       * event and the typed error. */
      exhausted: { promotionVersionId: string; scopeKind: PromotionCapScopeKind; scopeKey: string };
    };

function scopeKeyOf(scope: {
  promotionVersionId: string;
  scopeKind: PromotionCapScopeKind;
  scopeKey: string;
}): string {
  // JSON, not string concatenation: a separator character could in principle
  // appear inside a scopeKey (a customer identifier), and two different scopes
  // must never collapse onto one key.
  return JSON.stringify([scope.promotionVersionId, scope.scopeKind, scope.scopeKey]);
}

/**
 * §6 stable lock ordering. Sorting requests and counters the same way is what
 * turns a potential deadlock between two checkouts into one of them simply
 * waiting.
 *
 * This ordering is ALPHABETICAL on `scopeKind`. The locking statement in
 * {@link lockCapCounters} therefore casts the enum to text before ordering —
 * PostgreSQL would otherwise sort it by DECLARATION order (GLOBAL, CUSTOMER,
 * BUDGET) and the two would silently disagree.
 */
export function sortCapScopes<
  T extends { promotionVersionId: string; scopeKind: PromotionCapScopeKind; scopeKey: string },
>(scopes: readonly T[]): T[] {
  return [...scopes]
    .map((scope) => ({ scope, key: scopeKeyOf(scope) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.scope);
}

/**
 * §6 step 2 — decide, from the locked counter state, whether EVERY request
 * fits. All-or-nothing: a partial grant would leave a checkout holding some
 * benefits it cannot display and is explicitly not allowed ("insert
 * reservations and the checkout snapshot atomically or reject all").
 *
 * Available headroom counts committed consumption AND live reservations, so a
 * concurrent checkout that has reserved but not yet settled still blocks this
 * one.
 */
export function planCapReservations(
  counters: readonly PromotionCapCounterState[],
  requests: readonly PromotionCapRequest[]
): PromotionCapPlan {
  const byScope = new Map(counters.map((counter) => [scopeKeyOf(counter), counter]));
  // Running totals, so several applications of the SAME promotion in one order
  // are checked against the cap cumulatively rather than each in isolation.
  const takenCount = new Map<string, number>();
  const takenAmount = new Map<string, Prisma.Decimal>();

  for (const request of sortCapScopes(requests)) {
    const key = scopeKeyOf(request);
    const counter = byScope.get(key);
    if (counter === undefined) {
      // No counter row means no cap is configured for that scope; nothing to
      // reserve against, and the caller creates the row on first use.
      continue;
    }
    const priorCount = takenCount.get(key) ?? 0;
    const priorAmount = takenAmount.get(key) ?? ZERO;

    if (counter.capCount !== null) {
      const used = counter.consumedCount + counter.reservedCount + priorCount + request.count;
      if (used > counter.capCount) {
        return {
          granted: false,
          exhausted: {
            promotionVersionId: request.promotionVersionId,
            scopeKind: request.scopeKind,
            scopeKey: request.scopeKey,
          },
        };
      }
    }
    if (counter.capAmount !== null) {
      const used = sum([
        counter.consumedAmount,
        counter.reservedAmount,
        priorAmount,
        request.amount,
      ]);
      if (compare(used, counter.capAmount) > 0) {
        return {
          granted: false,
          exhausted: {
            promotionVersionId: request.promotionVersionId,
            scopeKind: request.scopeKind,
            scopeKey: request.scopeKey,
          },
        };
      }
    }
    takenCount.set(key, priorCount + request.count);
    takenAmount.set(key, add(priorAmount, request.amount));
  }

  return { granted: true, reservations: sortCapScopes(requests) };
}

/**
 * §6 — which scopes an accepted application must reserve against. A rule with
 * no global/per-customer/budget cap reserves nothing and stays offline-eligible
 * (§7); that is why this returns an empty list rather than a zero request.
 */
export function capRequestsFor(
  rule: PromotionRule,
  applications: readonly PromotionApplication[],
  customerId: string | null
): PromotionCapRequest[] {
  const mine = applications.filter(
    (application) => application.promotionVersionId === rule.versionId
  );
  const requests: PromotionCapRequest[] = [];
  for (const application of mine) {
    if (rule.globalCap !== null) {
      requests.push({
        promotionVersionId: rule.versionId,
        scopeKind: 'GLOBAL',
        scopeKey: '',
        applicationOrdinal: application.applicationOrdinal,
        count: 1,
        amount: application.roundedBenefit,
      });
    }
    if (rule.perCustomerCap !== null && customerId !== null) {
      requests.push({
        promotionVersionId: rule.versionId,
        scopeKind: 'CUSTOMER',
        scopeKey: customerId,
        applicationOrdinal: application.applicationOrdinal,
        count: 1,
        amount: application.roundedBenefit,
      });
    }
    if (rule.budgetAmount !== null) {
      requests.push({
        promotionVersionId: rule.versionId,
        scopeKind: 'BUDGET',
        scopeKey: '',
        applicationOrdinal: application.applicationOrdinal,
        count: 1,
        amount: application.roundedBenefit,
      });
    }
  }
  return requests;
}

/**
 * §6 step 1 — lock the counter rows and read committed + reserved totals.
 *
 * `FOR UPDATE` on the counters is the serialization point. The reservation
 * totals are read in the same statement, inside the same lock, so no
 * reservation can appear between the read and the decision.
 *
 * Must be called inside the caller's transaction; `executor` is that `tx`.
 */
export async function lockCapCounters(
  executor: PromotionCapExecutor,
  organizationId: string,
  scopes: readonly {
    promotionVersionId: string;
    scopeKind: PromotionCapScopeKind;
    scopeKey: string;
  }[],
  options: { excludeEvaluationId?: string } = {}
): Promise<PromotionCapCounterState[]> {
  if (scopes.length === 0) return [];
  const ordered = sortCapScopes(scopes);
  const versionIds = [...new Set(ordered.map((scope) => scope.promotionVersionId))];
  const scopeKeys = [...new Set(ordered.map((scope) => scope.scopeKey))];
  // §6 replay: an evaluation must not count its OWN live reservations against
  // itself. Without this, re-running the same evaluation sees the slot it
  // already holds as somebody else's and reports the cap exhausted, instead of
  // returning the original reservation.
  const excludeEvaluationId = options.excludeEvaluationId ?? '';

  // The lock itself. ORDER BY inside FOR UPDATE fixes the acquisition order.
  const locked = await executor.$queryRaw<
    {
      promotionVersionId: string;
      scopeKind: PromotionCapScopeKind;
      scopeKey: string;
      capCount: number | null;
      capAmount: Prisma.Decimal | null;
      consumedCount: number;
      consumedAmount: Prisma.Decimal;
    }[]
  >`
    SELECT "promotionVersionId", "scopeKind", "scopeKey", "capCount", "capAmount",
           "consumedCount", "consumedAmount"
      FROM "restaurant_promotion_cap_counters"
     WHERE "organizationId" = ${organizationId}
       AND "promotionVersionId" = ANY(${versionIds}::text[])
       AND "scopeKey" = ANY(${scopeKeys}::text[])
     ORDER BY "promotionVersionId", "scopeKind"::text, "scopeKey"
       FOR UPDATE
  `;

  const live = await executor.$queryRaw<
    {
      promotionVersionId: string;
      scopeKind: PromotionCapScopeKind;
      scopeKey: string;
      reservedCount: bigint | number;
      reservedAmount: Prisma.Decimal | null;
    }[]
  >`
    SELECT "promotionVersionId", "scopeKind", "scopeKey",
           COALESCE(SUM("reservedCount"), 0) AS "reservedCount",
           COALESCE(SUM("reservedAmount"), 0) AS "reservedAmount"
      FROM "restaurant_promotion_cap_reservations"
     WHERE "organizationId" = ${organizationId}
       AND "promotionVersionId" = ANY(${versionIds}::text[])
       AND "scopeKey" = ANY(${scopeKeys}::text[])
       AND "state" = 'RESERVED'
       AND "evaluationId" <> ${excludeEvaluationId}
     GROUP BY "promotionVersionId", "scopeKind", "scopeKey"
  `;

  const liveByScope = new Map(live.map((row) => [scopeKeyOf(row), row]));
  return locked.map((counter) => {
    const reserved = liveByScope.get(scopeKeyOf(counter));
    return {
      ...counter,
      consumedCount: Number(counter.consumedCount),
      reservedCount: reserved === undefined ? 0 : Number(reserved.reservedCount),
      reservedAmount:
        reserved?.reservedAmount === undefined || reserved.reservedAmount === null
          ? ZERO
          : new Prisma.Decimal(reserved.reservedAmount),
    };
  });
}

/**
 * §6 steps 1-3 — reserve every scope an evaluation needs, or throw.
 *
 * Throwing is deliberate (§11): the owning transaction rolls back, so a partial
 * application can never commit. The caller writes the evaluation snapshot in
 * the SAME transaction, which is what makes "insert reservations and the
 * checkout snapshot atomically" true rather than aspirational.
 *
 * Replay: the ledger's unique key is `(version, scope, evaluationId,
 * applicationOrdinal)`, so re-running the same evaluation is a no-op insert
 * that returns the ORIGINAL reservation instead of taking a second slot.
 */
export async function reserveCaps(
  executor: PromotionCapExecutor,
  params: {
    organizationId: string;
    evaluationId: string;
    requests: readonly PromotionCapRequest[];
  }
): Promise<readonly PromotionCapRequest[]> {
  const { organizationId, evaluationId, requests } = params;
  if (requests.length === 0) return [];

  const counters = await lockCapCounters(executor, organizationId, requests, {
    excludeEvaluationId: evaluationId,
  });
  const plan = planCapReservations(counters, requests);
  if (!plan.granted) {
    throw new PromotionError(
      PROMOTION_ERROR.CAP_EXHAUSTED,
      `Promotion cap exhausted for version ${plan.exhausted.promotionVersionId} scope ${plan.exhausted.scopeKind}.`
    );
  }

  for (const reservation of plan.reservations) {
    await executor.$executeRaw`
      INSERT INTO "restaurant_promotion_cap_reservations"
        ("id", "organizationId", "counterId", "promotionVersionId", "scopeKind", "scopeKey",
         "evaluationId", "applicationOrdinal", "reservedCount", "reservedAmount", "state")
      SELECT gen_random_uuid()::text, ${organizationId}, c."id", ${reservation.promotionVersionId},
             ${reservation.scopeKind}::"RestaurantPromotionCapScopeKind", ${reservation.scopeKey},
             ${evaluationId}, ${reservation.applicationOrdinal}, ${reservation.count},
             ${reservation.amount}::decimal, 'RESERVED'
        FROM "restaurant_promotion_cap_counters" c
       WHERE c."organizationId" = ${organizationId}
         AND c."promotionVersionId" = ${reservation.promotionVersionId}
         AND c."scopeKind" = ${reservation.scopeKind}::"RestaurantPromotionCapScopeKind"
         AND c."scopeKey" = ${reservation.scopeKey}
      ON CONFLICT ("organizationId", "promotionVersionId", "scopeKind", "scopeKey",
                   "evaluationId", "applicationOrdinal") DO NOTHING
    `;
  }
  return plan.reservations;
}

/**
 * §6 step 4 — settlement. Converts this evaluation's RESERVED rows to CONSUMED
 * and moves the same quantities onto the counter, in the owning transaction.
 *
 * The counter update and the state change are one statement pair inside one
 * transaction, so the `consumed <= cap` CHECK is evaluated against the final
 * state; if a bug ever let two checkouts through, the second COMMIT fails
 * rather than silently oversubscribing.
 */
export async function consumeReservations(
  executor: PromotionCapExecutor,
  params: { organizationId: string; evaluationId: string; settledAt: Date }
): Promise<number> {
  const { organizationId, evaluationId, settledAt } = params;
  await executor.$executeRaw`
    UPDATE "restaurant_promotion_cap_counters" c
       SET "consumedCount" = c."consumedCount" + r."count",
           "consumedAmount" = c."consumedAmount" + r."amount",
           "updatedAt" = ${settledAt}
      FROM (
        SELECT "counterId", SUM("reservedCount")::int AS "count",
               SUM("reservedAmount") AS "amount"
          FROM "restaurant_promotion_cap_reservations"
         WHERE "organizationId" = ${organizationId}
           AND "evaluationId" = ${evaluationId}
           AND "state" = 'RESERVED'
         GROUP BY "counterId"
      ) r
     WHERE c."organizationId" = ${organizationId} AND c."id" = r."counterId"
  `;
  return executor.$executeRaw`
    UPDATE "restaurant_promotion_cap_reservations"
       SET "state" = 'CONSUMED', "settledAt" = ${settledAt}
     WHERE "organizationId" = ${organizationId}
       AND "evaluationId" = ${evaluationId}
       AND "state" = 'RESERVED'
  `;
}

/**
 * §6 — cancellation or expiry appends a release. The counter is untouched
 * because a reservation never reached it; only the held headroom is returned.
 */
export async function releaseReservations(
  executor: PromotionCapExecutor,
  params: { organizationId: string; evaluationId: string; releasedAt: Date }
): Promise<number> {
  const { organizationId, evaluationId, releasedAt } = params;
  return executor.$executeRaw`
    UPDATE "restaurant_promotion_cap_reservations"
       SET "state" = 'RELEASED', "releasedAt" = ${releasedAt}
     WHERE "organizationId" = ${organizationId}
       AND "evaluationId" = ${evaluationId}
       AND "state" = 'RESERVED'
  `;
}

/** Remaining headroom for one scope, for display and for the offline
 * eligibility decision. Never authoritative on its own (§6 forbids a
 * client-reported remaining cap authorizing a benefit). */
export function remainingCapacity(counter: PromotionCapCounterState): {
  count: number | null;
  amount: Prisma.Decimal | null;
} {
  return {
    count:
      counter.capCount === null
        ? null
        : Math.max(0, counter.capCount - counter.consumedCount - counter.reservedCount),
    amount:
      counter.capAmount === null
        ? null
        : (() => {
            const left = sub(
              counter.capAmount,
              add(counter.consumedAmount, counter.reservedAmount)
            );
            return compare(left, ZERO) < 0 ? ZERO : left;
          })(),
  };
}
