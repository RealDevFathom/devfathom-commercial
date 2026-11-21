import type { Prisma } from '@/generated/prisma/client';

/** Audit exactly the rows transitioned by this transaction, including unused launches. */
export async function endSupportSessions(
  db: Prisma.TransactionClient,
  where: Prisma.PlatformSupportSessionWhereInput,
  reason: string,
  actorPlatformUserId?: string | null
) {
  const ended = await db.platformSupportSession.updateManyAndReturn({
    where: { ...where, status: 'ACTIVE' },
    data: { status: 'ENDED', endedAt: new Date(), tokenCiphertext: null, launchTokenHash: null },
    select: { id: true, platformUserId: true, organizationId: true, tenantUserId: true },
  });
  if (ended.length === 0) return;
  await db.platformAuditLog.createMany({
    data: ended.map((session) => ({
      organizationId: session.organizationId,
      actorPlatformUserId:
        actorPlatformUserId === undefined ? session.platformUserId : actorPlatformUserId,
      actorTenantUserId: session.tenantUserId,
      action: 'support.session.ended',
      targetType: 'PlatformSupportSession',
      targetId: session.id,
      reason,
      metadata: { sessionPlatformUserId: session.platformUserId },
    })),
  });
}

/** Called after updating the operator row, before releasing its lock at commit. */
export async function revokeOperatorSessions(
  db: Prisma.TransactionClient,
  platformUserId: string,
  reason: string,
  actorPlatformUserId: string | null
) {
  await db.platformSession.updateMany({
    where: { platformUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await endSupportSessions(db, { platformUserId }, reason, actorPlatformUserId);
}
