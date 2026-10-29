import 'server-only';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';
import { isPharmacyOwner } from './owner';

export const pointsPolicySchema = z
  .object({
    pointsEnabled: z.boolean(),
    earnEveryMinor: z.number().int().min(1).max(100_000_000),
    pointValueMinor: z.number().int().min(1).max(1_000_000),
    minimumRedeemPoints: z.number().int().min(1).max(1_000_000),
  })
  .strict();
export type PointsPolicy = z.infer<typeof pointsPolicySchema>;
export const DEFAULT_POINTS_POLICY: PointsPolicy = {
  pointsEnabled: false,
  earnEveryMinor: 100,
  pointValueMinor: 100,
  minimumRedeemPoints: 1,
};
export async function readPointsPolicy(
  db: ScopedDb,
  organizationId: string
): Promise<PointsPolicy> {
  const row = await db.pharmacyLoyaltySettings.findUnique({
    where: { organizationId },
    select: {
      pointsEnabled: true,
      earnEveryMinor: true,
      pointValueMinor: true,
      minimumRedeemPoints: true,
    },
  });
  return row ?? DEFAULT_POINTS_POLICY;
}
export async function requirePointsManager(ctx: TRPCContext) {
  const user = ctx.session?.user;
  const organizationId = ctx.entitlements.organizationId;
  if (
    !user ||
    user.organizationId !== organizationId ||
    ctx.organization?.vertical !== 'PHARMACY' ||
    (user.role !== 'ADMIN' && !(await isPharmacyOwner(ctx.db, organizationId, user.id))) ||
    !(await can(subjectFromSession(user), 'pharmacy:loyalty-manage', undefined, { db: ctx.db }))
  )
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Owner or administrator loyalty permission required.',
    });
  return { organizationId, actorId: user.id };
}
export async function savePointsPolicy(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  input: PointsPolicy
) {
  const policy = pointsPolicySchema.parse(input);
  // Serialize first-time creation too; a row lock alone cannot lock a missing policy.
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`points-policy:${organizationId}`}, 0))::text`
  );
  const oldValue = await readPointsPolicy(db, organizationId);
  await db.pharmacyLoyaltySettingsAudit.create({
    data: {
      organizationId,
      actorId,
      oldValue,
      newValue: policy,
    },
  });
  return db.pharmacyLoyaltySettings.upsert({
    where: { organizationId },
    create: { organizationId, ...policy },
    update: policy,
  });
}
