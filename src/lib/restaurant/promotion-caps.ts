import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * WHA-288 Promotions Lane A — redemption CAP enforcement.
 *
 * A cap ("first 100 guests", "once per customer", "once per check") is the one
 * part of this layer that two terminals can race for, and the one part where a
 * read-then-write check is simply wrong. Counting rows and comparing to the
 * limit is a TOCTOU bug: both registers read 99, both decide there is room, both
 * insert, and the hundred-and-first guest gets a discount that was promised to
 * a hundred.
 *
 * So the cap is enforced by a UNIQUE INDEX, not by a count. Each redemption
 * claims an explicit `ordinal` — slot 1, slot 2, ... — under the key
 * (promotionVersionId, capScope, capKey), and the unique index on that tuple is
 * the arbiter. The claim is a single atomic statement:
 *
 *     INSERT ... SELECT COALESCE(MAX(ordinal), 0) + 1 ... HAVING that <= max
 *
 * which yields exactly three outcomes, all of them safe:
 *   - one row inserted  -> the slot is ours;
 *   - zero rows         -> the HAVING failed, the cap is genuinely full;
 *   - 23505             -> another writer took this ordinal between our MAX and
 *                          our INSERT. Nobody over-claimed; we simply retry and
 *                          compute the next ordinal from the new maximum.
 *
 * No lock is taken, no counter is trusted, and no interleaving can exceed the
 * cap — the index would have to accept a duplicate for that to happen.
 *
 * A 23505 aborts the enclosing transaction in PostgreSQL, so the retry must
 * restart the transaction. `claimCapSlots` therefore takes a client and owns its
 * own attempts; it is not safe to retry inside a caller's open transaction.
 */

/** Mirrors the Prisma `RestaurantPromotionCapScope` enum. */
export type PromotionCapScope = 'PER_ORDER' | 'PER_GUEST' | 'TOTAL';

/** The literal key for a TOTAL cap — one shared slot pool for the whole
 * tenant's use of the version. */
export const TOTAL_CAP_KEY = '*';

/** A cap as configured on a promotion version. */
export type PromotionCap = {
  scope: PromotionCapScope;
  maxRedemptions: number;
};

/** The check coordinates a cap key is derived from. */
export type PromotionCapSubject = {
  orderId: string;
  customerId: string | null;
};

/** Raised when a cap is full — the promotion may not be applied. */
export class PromotionCapExhaustedError extends Error {
  readonly scope: PromotionCapScope;
  readonly promotionVersionId: string;
  constructor(promotionVersionId: string, scope: PromotionCapScope) {
    super(`Promotion version ${promotionVersionId} has exhausted its ${scope} redemption cap.`);
    this.name = 'PromotionCapExhaustedError';
    this.scope = scope;
    this.promotionVersionId = promotionVersionId;
  }
}

/** Raised when concurrent writers kept taking the slot this claim aimed at and
 * the bounded retry budget ran out. The cap is intact; the caller may retry. */
export class PromotionCapContentionError extends Error {
  constructor(promotionVersionId: string, attempts: number) {
    super(
      `Could not claim a redemption slot for promotion version ${promotionVersionId} after ${attempts} attempts.`
    );
    this.name = 'PromotionCapContentionError';
  }
}

/**
 * The key a cap counts within.
 *
 * PER_ORDER counts per check, PER_GUEST per customer, TOTAL across the tenant.
 * A PER_GUEST cap on a walk-in with no customer record returns `null` — the cap
 * has nothing to count against, so it CANNOT be enforced and the promotion is
 * therefore not offered. Falling back to "unlimited" here would turn an
 * anonymous guest into the way to defeat a per-guest cap.
 */
export function capKeyFor(scope: PromotionCapScope, subject: PromotionCapSubject): string | null {
  switch (scope) {
    case 'PER_ORDER':
      return subject.orderId;
    case 'PER_GUEST':
      return subject.customerId;
    case 'TOTAL':
      return TOTAL_CAP_KEY;
  }
}

export type PromotionCapClaim = {
  scope: PromotionCapScope;
  capKey: string;
  maxRedemptions: number;
};

/**
 * The slots one application must claim, in a deterministic order (PER_ORDER,
 * then PER_GUEST, then TOTAL). The order matters: every writer takes the caps in
 * the same sequence, so two applications can never deadlock by grabbing two caps
 * in opposite orders.
 *
 * Every authority is capped, including MANAGER_OVERRIDE: a cap is a commercial
 * commitment, and an override changes WHO authorized a discount, not how many of
 * them the promotion promised to honour.
 *
 * Throws `PromotionCapExhaustedError` for a PER_GUEST cap that cannot be keyed
 * — an unenforceable cap is a refusal, never a pass.
 */
export function planCapClaims(
  promotionVersionId: string,
  caps: readonly PromotionCap[],
  subject: PromotionCapSubject
): PromotionCapClaim[] {
  const order: PromotionCapScope[] = ['PER_ORDER', 'PER_GUEST', 'TOTAL'];
  const claims: PromotionCapClaim[] = [];
  for (const scope of order) {
    const cap = caps.find((candidate) => candidate.scope === scope);
    if (!cap) continue;
    const capKey = capKeyFor(scope, subject);
    if (capKey === null) throw new PromotionCapExhaustedError(promotionVersionId, scope);
    claims.push({ scope, capKey, maxRedemptions: cap.maxRedemptions });
  }
  return claims;
}

/** PostgreSQL unique-violation SQLSTATE — the signal that another writer took
 * the ordinal we aimed at. */
const UNIQUE_VIOLATION = '23505';

/**
 * True iff the error is the ordinal race this module expects and retries.
 *
 * The same violation reaches us in three different shapes and all three must be
 * recognised, because treating a race as a hard failure would refuse a discount
 * the guest is actually entitled to:
 *   - the raw driver error, `code: '23505'`;
 *   - Prisma's typed unique-constraint error, `code: 'P2002'`;
 *   - a raw query through the driver adapter, which reports `code: 'P2010'` and
 *     buries the real SQLSTATE at
 *     `meta.driverAdapterError.cause.originalCode`.
 *
 * Nothing else is retried: a foreign-key violation or a dropped connection is a
 * real failure and propagates.
 */
export function isCapSlotConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === UNIQUE_VIOLATION || code === 'P2002') return true;

  const meta = (error as { meta?: Record<string, unknown> }).meta;
  if (!meta) return false;
  if (meta.code === UNIQUE_VIOLATION) return true;

  const adapterError = meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined;
  const cause = adapterError?.cause;
  if (!cause) return false;
  return cause.originalCode === UNIQUE_VIOLATION || cause.kind === 'UniqueConstraintViolation';
}

export type ClaimedCapSlot = {
  scope: PromotionCapScope;
  capKey: string;
  ordinal: number;
  redemptionId: string;
};

/**
 * Claim ONE slot atomically. Returns the ordinal taken, or `null` when the cap
 * is genuinely full. Throws the unique-violation error unchanged when another
 * writer won this ordinal — that is the caller's signal to retry the whole
 * transaction, since a 23505 has aborted it.
 *
 * The ordinal is computed inside the INSERT so there is no window between
 * reading the maximum and writing the row.
 */
export async function claimCapSlot(
  tx: ScopedDb,
  params: {
    redemptionId: string;
    organizationId: string;
    promotionVersionId: string;
    applicationId: string;
    claim: PromotionCapClaim;
  }
): Promise<number | null> {
  const rows = await tx.$queryRawUnsafe<{ ordinal: number }[]>(
    `INSERT INTO "restaurant_promotion_redemptions"
       ("id", "organizationId", "promotionVersionId", "capScope", "capKey", "ordinal", "applicationId")
     SELECT $1, $2, $3, $4::"RestaurantPromotionCapScope", $5,
            COALESCE(MAX(r."ordinal"), 0) + 1, $6
       FROM "restaurant_promotion_redemptions" r
      WHERE r."promotionVersionId" = $3
        AND r."capScope" = $4::"RestaurantPromotionCapScope"
        AND r."capKey" = $5
     HAVING COALESCE(MAX(r."ordinal"), 0) + 1 <= $7
     RETURNING "ordinal"`,
    params.redemptionId,
    params.organizationId,
    params.promotionVersionId,
    params.claim.scope,
    params.claim.capKey,
    params.applicationId,
    params.claim.maxRedemptions
  );
  return rows.length === 0 ? null : Number(rows[0]!.ordinal);
}

/**
 * Claim every slot an application needs, inside the caller's transaction.
 *
 * All-or-nothing by construction: a full cap throws
 * `PromotionCapExhaustedError`, which rolls the caller's transaction back and
 * releases the slots already claimed in it. A 23505 propagates unchanged so the
 * caller can restart — see `claimCapSlotsWithRetry`, which owns that loop.
 */
export async function claimCapSlots(
  tx: ScopedDb,
  params: {
    organizationId: string;
    promotionVersionId: string;
    applicationId: string;
    claims: readonly PromotionCapClaim[];
    /** Injected id factory — the caller owns id generation (and tests pin it). */
    newId: (claim: PromotionCapClaim) => string;
  }
): Promise<ClaimedCapSlot[]> {
  const claimed: ClaimedCapSlot[] = [];
  for (const claim of params.claims) {
    const redemptionId = params.newId(claim);
    const ordinal = await claimCapSlot(tx, {
      redemptionId,
      organizationId: params.organizationId,
      promotionVersionId: params.promotionVersionId,
      applicationId: params.applicationId,
      claim,
    });
    if (ordinal === null) {
      throw new PromotionCapExhaustedError(params.promotionVersionId, claim.scope);
    }
    claimed.push({ scope: claim.scope, capKey: claim.capKey, ordinal, redemptionId });
  }
  return claimed;
}

/**
 * Run `attempt` until it does not lose an ordinal race, up to `maxAttempts`.
 *
 * `attempt` must open its OWN transaction: a unique violation aborts the
 * PostgreSQL transaction it happened in, so retrying inside it would only
 * produce "current transaction is aborted". Contention is bounded by the number
 * of concurrent writers, so a small attempt budget is sufficient in practice;
 * exhausting it raises `PromotionCapContentionError` rather than silently
 * dropping the claim.
 */
export async function claimCapSlotsWithRetry<T>(
  promotionVersionId: string,
  attempt: () => Promise<T>,
  options: { maxAttempts?: number } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 8;
  for (let tries = 1; tries <= maxAttempts; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isCapSlotConflict(error)) throw error;
    }
  }
  throw new PromotionCapContentionError(promotionVersionId, maxAttempts);
}

/**
 * Remaining redemptions per cap scope for a version — the HINT the evaluator
 * uses to avoid offering a discount that is certain to be refused. It is a read
 * of a moving target and is NEVER the enforcement: only the ordinal claim is.
 */
export async function remainingRedemptions(
  tx: ScopedDb,
  params: {
    promotionVersionId: string;
    caps: readonly PromotionCap[];
    subject: PromotionCapSubject;
  }
): Promise<Map<PromotionCapScope, number>> {
  const remaining = new Map<PromotionCapScope, number>();
  for (const cap of params.caps) {
    const capKey = capKeyFor(cap.scope, params.subject);
    if (capKey === null) {
      remaining.set(cap.scope, 0);
      continue;
    }
    const rows = await tx.$queryRawUnsafe<{ used: bigint | number }[]>(
      `SELECT COALESCE(MAX(r."ordinal"), 0) AS used
         FROM "restaurant_promotion_redemptions" r
        WHERE r."promotionVersionId" = $1
          AND r."capScope" = $2::"RestaurantPromotionCapScope"
          AND r."capKey" = $3`,
      params.promotionVersionId,
      cap.scope,
      capKey
    );
    const used = Number(rows[0]?.used ?? 0);
    remaining.set(cap.scope, Math.max(0, cap.maxRedemptions - used));
  }
  return remaining;
}

/** The tightest remaining allowance across a version's caps — what the
 * evaluator's `remainingRedemptions` map wants. */
export function tightestRemaining(remaining: ReadonlyMap<PromotionCapScope, number>): number {
  let tightest = Number.POSITIVE_INFINITY;
  for (const value of remaining.values()) tightest = Math.min(tightest, value);
  return tightest;
}
