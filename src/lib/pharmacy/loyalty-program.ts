import 'server-only';
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { earnedPoints, type LoyaltyRate } from './loyalty-rate';

export async function currentLoyaltyProgram(db: ScopedDb, organizationId: string) {
  return db.pharmacyLoyaltyProgramVersion.findFirst({
    where: { organizationId },
    orderBy: { version: 'desc' },
  });
}

export async function loyaltyReconciliation(db: ScopedDb, organizationId: string) {
  // Owner settings run in the existing organization-wide tenant context. Never clear a branch scope.
  const context = await db.$queryRaw<Array<{ branch: string | null }>>`
    SELECT NULLIF(current_setting('app.current_branch_id', true), '') AS branch`;
  if (context[0]?.branch)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Organization context required.' });
  const totals = await db.$queryRaw<
    Array<{ branchId: string; customerId: string; count: number; points: string }>
  >`
    SELECT "branchId", "customerId", count(*)::integer AS count, sum(points)::text AS points
    FROM pharmacy_loyalty_points_entries WHERE "organizationId"=${organizationId}
    GROUP BY "branchId", "customerId" ORDER BY "branchId", "customerId"`;
  return { totals, digest: createHash('sha256').update(JSON.stringify(totals)).digest('hex') };
}

/** Caller is the audited owner procedure, inside its tenant transaction. */
export async function configureLoyaltyProgram(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  input: LoyaltyRate & { khataEnabled: boolean; reconciliationDigest: string }
) {
  earnedPoints(0, input);
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'pharmacy-loyalty:' + organizationId}, 0))`
  );
  const migration = await db.pharmacyLoyaltyMigration.findUnique({ where: { organizationId } });
  if (!migration) {
    const snapshot = await loyaltyReconciliation(db, organizationId);
    if (snapshot.digest !== input.reconciliationDigest)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Balances changed. Review reconciliation again.',
      });
    await db.pharmacyLoyaltyWallet.createMany({
      data: [
        ...snapshot.totals.reduce((map, row) => {
          map.set(row.customerId, (map.get(row.customerId) ?? BigInt(0)) + BigInt(row.points));
          return map;
        }, new Map<string, bigint>()),
      ].map(([customerId, points]) => ({ organizationId, customerId, points })),
    });
    await db.pharmacyLoyaltyMigration.create({
      data: {
        organizationId,
        actorId,
        sourceCount: snapshot.totals.reduce((sum, row) => sum + row.count, 0),
        sourcePoints: snapshot.totals.reduce((sum, row) => sum + BigInt(row.points), BigInt(0)),
        branchTotals: snapshot.totals,
      },
    });
  }
  const prior = await currentLoyaltyProgram(db, organizationId);
  return db.pharmacyLoyaltyProgramVersion.create({
    data: {
      organizationId,
      actorId,
      version: (prior?.version ?? 0) + 1,
      mode: input.mode,
      rewardPoints: input.rewardPoints,
      spendMinor: input.spendMinor,
      khataEnabled: input.khataEnabled,
    },
  });
}

export async function loyaltyBalance(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  customerId: string
) {
  const migration = await db.pharmacyLoyaltyMigration.findUnique({ where: { organizationId } });
  if (migration) {
    const wallet = await db.pharmacyLoyaltyWallet.findUnique({
      where: { organizationId_customerId: { organizationId, customerId } },
    });
    const points = wallet?.points ?? BigInt(0);
    if (points > BigInt(Number.MAX_SAFE_INTEGER) || points < BigInt(Number.MIN_SAFE_INTEGER))
      throw new RangeError('LOYALTY_BALANCE_OVERFLOW');
    return Number(points);
  }
  const balance = await db.pharmacyLoyaltyPointsEntry.aggregate({
    where: { organizationId, branchId, customerId },
    _sum: { points: true },
  });
  return balance._sum.points ?? 0;
}

export async function lockLoyaltyOrganization(db: ScopedDb, organizationId: string) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'pharmacy-loyalty:' + organizationId}, 0))`
  );
}
