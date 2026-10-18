import 'server-only';

import { z } from 'zod';

import type { RestaurantJobHandler } from '@/lib/restaurant/job-handlers-core';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export const LOYALTY_EXPIRY_JOB = 'loyalty.expirePoints';

type Entry = {
  id: string;
  kind: 'EARN' | 'REDEEM' | 'REVERSAL' | 'EXPIRY' | 'ADJUSTMENT';
  points: number;
  programVersionId: string;
  reversesEntryId: string | null;
  expiresAt: Date | null;
  occurredAt: Date;
};

/** Resolve expirable earned lots after FIFO consumption by unlinked negative entries. */
export function planLoyaltyExpiries(entries: readonly Entry[], at: Date) {
  const lots: (Entry & { remaining: number })[] = [];
  const byId = new Map<string, Entry & { remaining: number }>();
  for (const entry of [...entries].sort((a, b) => {
    const time = a.occurredAt.getTime() - b.occurredAt.getTime();
    return time || a.id.localeCompare(b.id);
  })) {
    if (entry.occurredAt > at) continue;
    if (entry.kind === 'EARN') {
      const lot = { ...entry, remaining: entry.points };
      lots.push(lot);
      byId.set(entry.id, lot);
      continue;
    }
    if (entry.points >= 0) continue;
    const linked = entry.reversesEntryId ? byId.get(entry.reversesEntryId) : undefined;
    if (linked) {
      linked.remaining = Math.max(0, linked.remaining + entry.points);
      continue;
    }
    let consume = -entry.points;
    for (const lot of lots) {
      const used = Math.min(lot.remaining, consume);
      lot.remaining -= used;
      consume -= used;
      if (consume === 0) break;
    }
  }
  return lots.filter(
    (lot) => lot.remaining > 0 && lot.expiresAt !== null && lot.expiresAt.getTime() <= at.getTime()
  );
}

/** Must run inside a tenant transaction; caller owns account-row locking. */
export async function expireAccountLoyaltyPoints(tx: ScopedDb, accountId: string, at: Date) {
  const entries = (await tx.loyaltyPointsEntry.findMany({
    where: { accountId, occurredAt: { lte: at } },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      kind: true,
      points: true,
      programVersionId: true,
      reversesEntryId: true,
      expiresAt: true,
      occurredAt: true,
    },
  })) as Entry[];
  const lots = planLoyaltyExpiries(entries, at);
  let points = 0;
  for (const lot of lots) {
    await tx.loyaltyPointsEntry.create({
      data: {
        accountId,
        programVersionId: lot.programVersionId,
        kind: 'EXPIRY',
        points: -lot.remaining,
        reversesEntryId: lot.id,
        occurredAt: at,
        idempotencyKey: `loyalty:expiry:${lot.id}`,
      },
    });
    points += lot.remaining;
  }
  return { entries: lots.length, points };
}

function runInTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

export async function expireLoyaltyPoints(db: ScopedDb, at = new Date()) {
  const accounts = await db.loyaltyAccount.findMany({ select: { id: true } });
  let entries = 0;
  let points = 0;
  for (const account of accounts) {
    const result = await runInTransaction(db, async (tx) => {
      await tx.$queryRaw`SELECT id FROM restaurant_loyalty_accounts WHERE id = ${account.id} FOR UPDATE`;
      return expireAccountLoyaltyPoints(tx, account.id, at);
    });
    entries += result.entries;
    points += result.points;
  }
  return { accounts: accounts.length, entries, points };
}

const PAYLOAD = z.object({ now: z.string().datetime().optional() }).strict();

/** Exported scheduler seam; registry intentionally unchanged in this lane. */
export const loyaltyExpiryHandler: RestaurantJobHandler = async ({ db, job }) => {
  const payload = PAYLOAD.parse(job.payload ?? {});
  await expireLoyaltyPoints(db, payload.now ? new Date(payload.now) : undefined);
};
