import type { PlatformRole, Prisma } from '@/generated/prisma/client';

export const PLATFORM_ROLE_CAPABILITIES: Record<PlatformRole, readonly string[]> = {
  SUPER_ADMIN: ['*', 'organizations:security:write'],
  OPERATIONS: [
    'organizations:read',
    'organizations:write',
    'deployments:read',
    'deployments:write',
    'jobs:read',
    'jobs:write',
    'support:write',
    'catalog:read',
  ],
  SALES: [
    'organizations:read',
    'crm:read',
    'crm:write',
    'commercial:read',
    'commercial:write',
    'catalog:read',
  ],
  FINANCE: [
    'organizations:read',
    'commercial:read',
    'commercial:write',
    'crm:read',
    'catalog:read',
  ],
  SUPPORT: ['organizations:read', 'deployments:read', 'jobs:read', 'support:write', 'catalog:read'],
  AUDITOR: [
    'organizations:read',
    'crm:read',
    'commercial:read',
    'deployments:read',
    'jobs:read',
    'catalog:read',
    'audit:read',
  ],
};

export function canPlatformRole(role: PlatformRole, capability: string): boolean {
  const capabilities = PLATFORM_ROLE_CAPABILITIES[role];
  return capabilities.includes('*') || capabilities.includes(capability);
}

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
