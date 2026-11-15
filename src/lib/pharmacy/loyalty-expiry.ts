import 'server-only';

import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import { lockCustomerConsent } from './consent-writer';

/** Recorded as the actor of expiry entries: the scheduled job, not a person. */
export const LOYALTY_EXPIRY_ACTOR = 'system:pharmacy-loyalty-expiry';

const LOT_KINDS = ['EARN', 'KHATA_EARN'] as const;

export type PharmacyPointsEntryForExpiry = {
  id: string;
  kind: string;
  points: number;
  saleId: string | null;
  tenderId: string | null;
  programVersionId: string | null;
  reversesEntryId: string | null;
  expiresAt: Date | null;
  occurredAt: Date;
};

type Lot = PharmacyPointsEntryForExpiry & { remaining: number };

const isLot = (entry: { kind: string }) => (LOT_KINDS as readonly string[]).includes(entry.kind);
const isPastExpiry = (lot: { expiresAt: Date | null }, at: Date) =>
  lot.expiresAt !== null && lot.expiresAt.getTime() <= at.getTime();
const chronological = (a: PharmacyPointsEntryForExpiry, b: PharmacyPointsEntryForExpiry) =>
  a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id);
/** Points that come back from a points tender: a refund restoration or a void release. */
const RESTORING_KINDS: readonly string[] = ['REFUND', 'REDEMPTION_RELEASE'];

/**
 * The lots a negative entry takes from first. An earn reversal takes back the lots it
 * reverses: a khata (CREDIT) refund the KHATA_EARN lots of that tender, newest collection
 * first (the tranches no longer owed); any other refund the EARN lot of its sale.
 */
function linkedLots(entry: PharmacyPointsEntryForExpiry, lots: readonly Lot[]): Lot[] {
  if (entry.kind !== 'EARN_REVERSAL') return [];
  const khata = lots.filter((lot) => lot.kind === 'KHATA_EARN' && lot.tenderId === entry.tenderId);
  if (khata.length) return [...khata].reverse();
  return lots.filter((lot) => lot.kind === 'EARN' && lot.saleId === entry.saleId);
}

/**
 * DEV-764: replays one customer's ledger at one branch up to `at`, tracking what is left of
 * each earned lot. Same lot model as the restaurant planner (spending consumes the oldest lots
 * first; points given back by a positive adjustment never expire), with pharmacy rules:
 * - an expiry closes exactly its lot, and a spend never takes from a lot already past its
 *   expiry date at the time of the spend (only an earn reversal takes back its own lot);
 * - a khata refund's reversal takes back its own khata collection lots, and a reversal larger
 *   than what is left of its own lots takes the rest from other lots, oldest first, so expiry
 *   never deducts reclaimed points a second time;
 * - points a redemption took come back (refund restoration or void release) into the lots
 *   they were taken from, with those lots' expiry dates. Points that come back into a lot
 *   already closed by expiry are stranded: they are past expiry and must be expired at once.
 */
function replayLots(entries: readonly PharmacyPointsEntryForExpiry[], at: Date) {
  const lots: Lot[] = [];
  const byId = new Map<string, Lot>();
  const closed = new Set<string>();
  const taken = new Map<string, Array<{ lot: Lot; used: number }>>();
  const stranded = new Map<string, number>();
  const expiredStranded = new Map<string, number>();
  for (const entry of [...entries].sort(chronological)) {
    if (entry.occurredAt.getTime() > at.getTime()) continue;
    if (isLot(entry)) {
      const lot = { ...entry, remaining: entry.points };
      lots.push(lot);
      byId.set(lot.id, lot);
      continue;
    }
    if (entry.kind === 'EXPIRY') {
      const lot = entry.reversesEntryId ? byId.get(entry.reversesEntryId) : undefined;
      if (lot) {
        closed.add(lot.id);
        lot.remaining = Math.max(0, lot.remaining + entry.points);
      } else if (entry.reversesEntryId) {
        // The immediate expiry of points that came back into a closed lot; settled below,
        // whatever its order against the restoring entry.
        expiredStranded.set(
          entry.reversesEntryId,
          (expiredStranded.get(entry.reversesEntryId) ?? 0) - entry.points
        );
      }
      continue;
    }
    if (entry.points > 0 && RESTORING_KINDS.includes(entry.kind) && entry.tenderId) {
      let give = entry.points;
      const portions = taken.get(entry.tenderId) ?? [];
      for (let index = portions.length - 1; index >= 0 && give > 0; index -= 1) {
        const portion = portions[index]!;
        const back = Math.min(portion.used, give);
        portion.used -= back;
        give -= back;
        if (closed.has(portion.lot.id))
          stranded.set(entry.id, (stranded.get(entry.id) ?? 0) + back);
        else portion.lot.remaining += back;
      }
      continue;
    }
    if (entry.points >= 0) continue;
    let consume = -entry.points;
    const portions: Array<{ lot: Lot; used: number }> = [];
    const own = linkedLots(entry, lots);
    for (const lot of [...own, ...lots]) {
      if (consume === 0) break;
      // A spend never comes out of a lot already past its expiry date: those points are gone
      // even before the sweep closes the lot. Only an earn reversal may take back its own lot.
      if (!own.includes(lot) && isPastExpiry(lot, entry.occurredAt)) continue;
      const used = Math.min(lot.remaining, consume);
      if (used === 0) continue;
      lot.remaining -= used;
      consume -= used;
      portions.push({ lot, used });
    }
    if (entry.kind === 'REDEEM' && entry.tenderId) taken.set(entry.tenderId, portions);
  }
  for (const [entryId, points] of stranded)
    stranded.set(entryId, Math.max(0, points - (expiredStranded.get(entryId) ?? 0)));
  return { lots, closed, stranded };
}

/**
 * DEV-764: which earned lots of one customer at one branch are due to expire at `at`, and how
 * many points each still holds (see replayLots). A due lot already spent in full is returned
 * with 0 points, so it can be closed and is never planned again.
 */
export function planPharmacyLotExpiries(
  entries: readonly PharmacyPointsEntryForExpiry[],
  at: Date
) {
  const { lots, closed } = replayLots(entries, at);
  return lots
    .filter(
      (lot) =>
        lot.expiresAt !== null && lot.expiresAt.getTime() <= at.getTime() && !closed.has(lot.id)
    )
    .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime() || a.id.localeCompare(b.id))
    .map((lot) => ({
      lotId: lot.id,
      programVersionId: lot.programVersionId,
      points: Math.max(0, lot.remaining),
    }));
}

/** DEV-764: points of a restoring entry that came back into lots already closed by expiry. */
export function strandedRestoredPoints(
  entries: readonly PharmacyPointsEntryForExpiry[],
  entryId: string,
  at: Date
) {
  return replayLots(entries, at).stranded.get(entryId) ?? 0;
}

const ENTRY_FOR_EXPIRY = {
  id: true,
  kind: true,
  points: true,
  saleId: true,
  tenderId: true,
  programVersionId: true,
  reversesEntryId: true,
  expiresAt: true,
  occurredAt: true,
} as const;

type CustomerAtBranch = { organizationId: string; branchId: string; customerId: string };

function readEntriesForExpiry(db: ScopedDb, scope: CustomerAtBranch, at: Date) {
  return db.pharmacyLoyaltyPointsEntry.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: scope.customerId,
      occurredAt: { lte: at },
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: ENTRY_FOR_EXPIRY,
  });
}

/**
 * DEV-764: points in the balance that are already past their expiry date but not yet swept.
 * They cannot be spent: redemption and manual removal subtract this from the balance. The
 * caller holds the customer lock. Reads the ledger only when such a lot exists.
 */
export async function pointsPastExpiry(db: ScopedDb, scope: CustomerAtBranch, at: Date) {
  const due = await db.pharmacyLoyaltyPointsEntry.count({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: scope.customerId,
      kind: { in: [...LOT_KINDS] },
      expiresAt: { lte: at },
      closedBy: { none: { kind: 'EXPIRY' } },
    },
  });
  if (!due) return 0;
  const entries = await readEntriesForExpiry(db, scope, at);
  return planPharmacyLotExpiries(entries, at).reduce((sum, lot) => sum + lot.points, 0);
}

/**
 * DEV-764: after points come back from a points tender (refund restoration or void release),
 * expires at once any of them that went back into a lot already closed by expiry, so points
 * past their date never return as points that do not expire. Runs in the caller's
 * transaction, under its customer lock.
 */
export async function expireStrandedRestoration(
  db: ScopedDb,
  scope: CustomerAtBranch,
  entry: { id: string; programVersionId?: string | null },
  at: Date
) {
  const entries = await readEntriesForExpiry(db, scope, at);
  const points = strandedRestoredPoints(entries, entry.id, at);
  if (points <= 0) return null;
  return db.pharmacyLoyaltyPointsEntry.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: scope.customerId,
      kind: 'EXPIRY',
      points: -points,
      reversesEntryId: entry.id,
      occurredAt: at,
      actorId: LOYALTY_EXPIRY_ACTOR,
      idempotencyKey: `loyalty:expiry:${entry.id}`,
    },
  });
}

/**
 * DEV-764: closes every due lot of one customer at one branch with one EXPIRY entry each,
 * taking the points the lot still holds. Runs in the caller's tenant transaction. Takes the
 * same per-customer lock as redemption and manual adjustment, so a lot cannot be both spent
 * and expired. Idempotent: each lot has one expiry key and a unique closing entry.
 */
export async function expireCustomerLoyaltyPoints(db: ScopedDb, scope: CustomerAtBranch, at: Date) {
  await lockCustomerConsent(db, scope.organizationId, scope.customerId);
  const entries = await readEntriesForExpiry(db, scope, at);
  let expiredPoints = 0;
  const due = planPharmacyLotExpiries(entries, at);
  for (const lot of due) {
    await db.pharmacyLoyaltyPointsEntry.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        customerId: scope.customerId,
        kind: 'EXPIRY',
        points: lot.points > 0 ? -lot.points : 0,
        programVersionId: lot.programVersionId,
        reversesEntryId: lot.lotId,
        occurredAt: at,
        actorId: LOYALTY_EXPIRY_ACTOR,
        idempotencyKey: `loyalty:expiry:${lot.lotId}`,
      },
    });
    expiredPoints += lot.points;
  }
  return { lots: due.length, points: expiredPoints };
}

/**
 * DEV-764: the scheduled sweep. Finds customers with due lots not yet closed, across tenants,
 * then expires each customer in its own tenant transaction. Every due lot gets its closing
 * entry, so a customer never comes back once swept.
 */
export async function processDuePharmacyLoyaltyExpiries(now = new Date(), limit = 25) {
  const take = Math.max(1, Math.min(500, Math.floor(limit) * 10));
  const candidates = await withPlatformDb((db) =>
    db.pharmacyLoyaltyPointsEntry.findMany({
      where: {
        kind: { in: [...LOT_KINDS] },
        expiresAt: { lte: now },
        closedBy: { none: { kind: 'EXPIRY' } },
      },
      distinct: ['organizationId', 'branchId', 'customerId'],
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      select: { organizationId: true, branchId: true, customerId: true },
      take,
    })
  );
  let customers = 0;
  let lots = 0;
  let points = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const result = await withTenantDb(candidate.organizationId, (db) =>
        expireCustomerLoyaltyPoints(db, candidate, now)
      );
      customers += 1;
      lots += result.lots;
      points += result.points;
    } catch (error) {
      failed += 1;
      console.error('[pharmacy-loyalty-expiry] customer sweep failed', {
        organizationId: candidate.organizationId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
  return { customers, lots, points, failed };
}
