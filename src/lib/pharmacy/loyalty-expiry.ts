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
const chronological = (a: PharmacyPointsEntryForExpiry, b: PharmacyPointsEntryForExpiry) =>
  a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id);

/**
 * The lots a negative entry takes from first. An expiry closes exactly its lot. An earn
 * reversal takes back the lots it reverses: a khata (CREDIT) refund the KHATA_EARN lots of
 * that tender, newest collection first (the tranches no longer owed); any other refund the
 * EARN lot of its sale.
 */
function linkedLots(entry: PharmacyPointsEntryForExpiry, lots: readonly Lot[]): Lot[] {
  if (entry.kind === 'EXPIRY') return lots.filter((lot) => lot.id === entry.reversesEntryId);
  if (entry.kind !== 'EARN_REVERSAL') return [];
  const khata = lots.filter((lot) => lot.kind === 'KHATA_EARN' && lot.tenderId === entry.tenderId);
  if (khata.length) return [...khata].reverse();
  return lots.filter((lot) => lot.kind === 'EARN' && lot.saleId === entry.saleId);
}

/**
 * DEV-764: which earned lots of one customer at one branch are due to expire at `at`, and how
 * many points each still holds. Same lot model as the restaurant planner (earned lots are
 * consumed oldest first by spending; points given back by refunds, void releases and positive
 * adjustments never expire), with two pharmacy rules: a khata refund's reversal takes back
 * its own khata collection lots, and a reversal larger than what is left of its own lots
 * (the points were already spent) takes the rest from other lots, oldest first, so expiry
 * never deducts those points a second time. A due lot already spent in full is returned with
 * 0 points, so it can be closed and is never planned again.
 */
export function planPharmacyLotExpiries(
  entries: readonly PharmacyPointsEntryForExpiry[],
  at: Date
) {
  const lots: Lot[] = [];
  const closed = new Set<string>();
  for (const entry of [...entries].sort(chronological)) {
    if (entry.occurredAt.getTime() > at.getTime()) continue;
    if (isLot(entry)) {
      lots.push({ ...entry, remaining: entry.points });
      continue;
    }
    if (entry.kind === 'EXPIRY' && entry.reversesEntryId) closed.add(entry.reversesEntryId);
    if (entry.points >= 0) continue;
    let consume = -entry.points;
    for (const lot of [...linkedLots(entry, lots), ...lots]) {
      if (consume === 0) break;
      const used = Math.min(lot.remaining, consume);
      lot.remaining -= used;
      consume -= used;
    }
  }
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

/**
 * DEV-764: closes every due lot of one customer at one branch with one EXPIRY entry each,
 * taking the points the lot still holds. Runs in the caller's tenant transaction. Takes the
 * same per-customer lock as redemption and manual adjustment, so a lot cannot be both spent
 * and expired. Idempotent: each lot has one expiry key and a unique closing entry.
 */
export async function expireCustomerLoyaltyPoints(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; customerId: string },
  at: Date
) {
  await lockCustomerConsent(db, scope.organizationId, scope.customerId);
  const entries = await db.pharmacyLoyaltyPointsEntry.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: scope.customerId,
      occurredAt: { lte: at },
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      kind: true,
      points: true,
      saleId: true,
      tenderId: true,
      programVersionId: true,
      reversesEntryId: true,
      expiresAt: true,
      occurredAt: true,
    },
  });
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
