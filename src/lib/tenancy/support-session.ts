import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import {
  assertPlatformCapability,
  platformRoleRequiresMfa,
  type PlatformIdentity,
} from '@/lib/platform/auth';
import { parseCookie, PlatformSecurityError } from '@/lib/platform/security';
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto';
import { canPlatformRole } from '@/lib/platform/capabilities';
import { endSupportSessions } from '@/lib/tenancy/end-support-sessions';
import { type ScopedDb, withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

export const SUPPORT_SESSION_COOKIE = 'df_support_session';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenFromRequest(request?: Request): Promise<string | null> | string | null {
  if (request) return parseCookie(request.headers.get('cookie'), SUPPORT_SESSION_COOKIE);
  return cookies().then((store) => store.get(SUPPORT_SESSION_COOKIE)?.value ?? null);
}

export function supportCookieOptions(expiresAt: Date) {
  const baseDomain = process.env.PLATFORM_BASE_DOMAIN?.trim().toLowerCase();
  return {
    httpOnly: true,
    // The one-use launch starts on the platform host and immediately redirects
    // on the tenant host. Lax is required for that top-level redirect to carry
    // the newly set cookie; mutation routes still enforce exact-origin checks.
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
    ...(baseDomain && !baseDomain.includes('localhost') ? { domain: `.${baseDomain}` } : {}),
  };
}

export type SupportIdentity = {
  supportSessionId: string;
  organizationId: string;
  platformUserId: string;
  tenantUserId: string;
  tenantUserRole: 'ADMIN' | 'EMPLOYEE' | 'HR';
  expiresAt: Date;
  reason: string;
};

async function operatorCanSupport(db: ScopedDb, id: string): Promise<boolean> {
  const operator = await db.platformUser.findUnique({
    where: { id },
    select: {
      active: true,
      role: true,
      mfaRequired: true,
      mfaEnabledAt: true,
      encryptedTotpSecret: true,
    },
  });
  if (!operator?.active || !canPlatformRole(operator.role, 'support:write')) return false;
  return (
    Boolean(operator.mfaEnabledAt && operator.encryptedTotpSecret) ||
    !(operator.mfaRequired || platformRoleRequiresMfa(operator.role))
  );
}

export async function createSupportSession(input: {
  actor: PlatformIdentity;
  organizationId: string;
  tenantUserId?: string;
  reason: string;
  durationMinutes?: number;
}) {
  assertPlatformCapability(input.actor, 'support:write');
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new PlatformSecurityError('Support access requires a 10–500 character reason.', 400);
  }
  const duration = Math.min(Math.max(input.durationMinutes ?? 30, 5), 60);
  const organization = await withPlatformDb((platformDb) =>
    platformDb.organization.findUnique({
      where: { id: input.organizationId },
      select: {
        id: true,
        slug: true,
        status: true,
        deployments: {
          where: { environment: 'PRODUCTION', status: 'READY' },
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { url: true },
        },
      },
    })
  );
  if (!organization || !['ONBOARDING', 'ACTIVE', 'GRACE'].includes(organization.status)) {
    throw new PlatformSecurityError('The organization is not available for support access.', 400);
  }

  const tenantUser = await withTenantDb(organization.id, (tenantDb) =>
    input.tenantUserId
      ? tenantDb.user.findUnique({
          where: { id: input.tenantUserId },
          select: { id: true, role: true, status: true },
        })
      : tenantDb.user.findFirst({
          where: { role: 'ADMIN', status: { in: ['ACTIVE', 'ON_LEAVE'] } },
          orderBy: { createdAt: 'asc' },
          select: { id: true, role: true, status: true },
        })
  );
  if (
    !tenantUser ||
    tenantUser.role !== 'ADMIN' ||
    !['ACTIVE', 'ON_LEAVE'].includes(tenantUser.status)
  ) {
    throw new PlatformSecurityError('No active tenant administrator is available.', 400);
  }

  const token = randomBytes(32).toString('base64url');
  const launchToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + duration * 60_000);
  const session = await withPlatformDb(async (platformDb) => {
    // Operator updates hold this same row lock until their session revocations commit.
    // A password or MFA reset can leave the role unchanged, so check the sign-in too.
    await platformDb.$queryRaw`SELECT id FROM platform_users WHERE id = ${input.actor.id} FOR UPDATE`;
    const signIn = await platformDb.platformSession.findFirst({
      where: {
        id: input.actor.sessionId,
        platformUserId: input.actor.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!signIn || !(await operatorCanSupport(platformDb, input.actor.id))) {
      throw new PlatformSecurityError('Support access is no longer authorized.', 403);
    }
    await endSupportSessions(
      platformDb,
      { platformUserId: input.actor.id, organizationId: organization.id },
      'Replaced by a new support session.'
    );
    const created = await platformDb.platformSupportSession.create({
      data: {
        organizationId: organization.id,
        platformUserId: input.actor.id,
        tenantUserId: tenantUser.id,
        tokenHash: hashToken(token),
        tokenCiphertext: encryptSecret(token),
        launchTokenHash: hashToken(launchToken),
        reason,
        expiresAt,
      },
    });
    await platformDb.platformAuditLog.create({
      data: {
        organizationId: organization.id,
        actorPlatformUserId: input.actor.id,
        actorTenantUserId: tenantUser.id,
        action: 'support.session.started',
        targetType: 'PlatformSupportSession',
        targetId: created.id,
        reason,
        metadata: { durationMinutes: duration },
      },
    });
    // Notification delivery is part of the session transaction: do not grant
    // access if the tenant's in-app notification cannot be persisted.
    const administrators = await platformDb.user.findMany({
      where: {
        organizationId: organization.id,
        role: 'ADMIN',
        status: { in: ['ACTIVE', 'ON_LEAVE'] },
      },
      select: { id: true },
    });
    await platformDb.notification.createMany({
      data: administrators.map(({ id }) => ({
        organizationId: organization.id,
        userId: id,
        type: 'support_session_started',
        title: 'Support access started',
        message: `${input.actor.name} opened support access until ${expiresAt.toISOString()}. Reason: ${reason}`,
        entityType: 'PlatformSupportSession',
        entityId: created.id,
      })),
    });
    return created;
  });

  return {
    launchToken,
    expiresAt,
    organizationSlug: organization.slug,
    deploymentUrl: organization.deployments[0]?.url ?? null,
    supportSessionId: session.id,
  };
}

export async function consumeSupportLaunchTicket(input: {
  launchToken: string;
  organizationId: string;
}): Promise<{ token: string; expiresAt: Date }> {
  if (input.launchToken.length < 32 || input.launchToken.length > 128) {
    throw new PlatformSecurityError('Support access ticket is invalid.', 401);
  }

  return withPlatformDb(async (platformDb) => {
    const session = await platformDb.platformSupportSession.findUnique({
      where: { launchTokenHash: hashToken(input.launchToken) },
      select: {
        id: true,
        organizationId: true,
        status: true,
        expiresAt: true,
        platformUserId: true,
        tenantUserId: true,
        launchUsedAt: true,
        tokenCiphertext: true,
      },
    });
    if (
      !session ||
      session.organizationId !== input.organizationId ||
      session.status !== 'ACTIVE' ||
      session.expiresAt <= new Date() ||
      session.launchUsedAt ||
      !session.tokenCiphertext ||
      !(await operatorCanSupport(platformDb, session.platformUserId))
    ) {
      throw new PlatformSecurityError('Support access ticket is invalid or expired.', 401);
    }

    const consumed = await platformDb.platformSupportSession.updateMany({
      where: {
        id: session.id,
        status: 'ACTIVE',
        launchUsedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { launchUsedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new PlatformSecurityError('Support access ticket was already used.', 401);
    }

    await platformDb.platformAuditLog.create({
      data: {
        organizationId: session.organizationId,
        actorPlatformUserId: session.platformUserId,
        actorTenantUserId: session.tenantUserId,
        action: 'support.session.launched',
        targetType: 'PlatformSupportSession',
        targetId: session.id,
      },
    });

    return {
      token: decryptSecret(session.tokenCiphertext),
      expiresAt: session.expiresAt,
    };
  });
}

export async function getSupportSession(request?: Request): Promise<SupportIdentity | null> {
  const token = await tokenFromRequest(request);
  if (!token || token.length < 32 || token.length > 128) return null;
  const session = await withPlatformDb(async (platformDb) => {
    const candidate = await platformDb.platformSupportSession.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        organizationId: true,
        platformUserId: true,
        tenantUserId: true,
        reason: true,
        status: true,
        expiresAt: true,
      },
    });
    if (
      !candidate ||
      candidate.status !== 'ACTIVE' ||
      candidate.expiresAt <= new Date() ||
      !(await operatorCanSupport(platformDb, candidate.platformUserId))
    )
      return null;
    return candidate;
  });
  if (!session?.tenantUserId) return null;
  const tenantUser = await withTenantDb(session.organizationId, (tenantDb) =>
    tenantDb.user.findUnique({
      where: { id: session.tenantUserId! },
      select: { id: true, role: true, status: true },
    })
  );
  if (
    !tenantUser ||
    tenantUser.role !== 'ADMIN' ||
    !['ACTIVE', 'ON_LEAVE'].includes(tenantUser.status)
  )
    return null;
  return {
    supportSessionId: session.id,
    organizationId: session.organizationId,
    platformUserId: session.platformUserId,
    tenantUserId: tenantUser.id,
    tenantUserRole: tenantUser.role,
    expiresAt: session.expiresAt,
    reason: session.reason,
  };
}

export async function endSupportSession(request?: Request): Promise<void> {
  const token = await tokenFromRequest(request);
  if (!token) return;
  await withPlatformDb(async (platformDb) => {
    await endSupportSessions(
      platformDb,
      { tokenHash: hashToken(token) },
      'Operator ended support access.'
    );
  });
}

/** Global operator view. Never return bearer tokens, hashes, or ciphertext. */
export async function listActiveSupportSessions(actor: PlatformIdentity) {
  assertPlatformCapability(actor, 'support:write');
  return withPlatformDb(async (db) => {
    const sessions = await db.platformSupportSession.findMany({
      where: { status: 'ACTIVE', expiresAt: { gt: new Date() } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        platformUserId: true,
        reason: true,
        expiresAt: true,
        createdAt: true,
        launchUsedAt: true,
        organization: { select: { displayName: true } },
      },
    });
    const operators = await db.platformUser.findMany({
      where: { id: { in: [...new Set(sessions.map((session) => session.platformUserId))] } },
      select: { id: true, name: true },
    });
    return sessions.map(({ platformUserId, ...session }) => ({
      ...session,
      operatorName:
        operators.find((operator) => operator.id === platformUserId)?.name ?? 'Former operator',
    }));
  });
}

/** Ending by ID is separately authorized; the caller need not own the cookie. */
export async function forceEndSupportSession(input: {
  actor: PlatformIdentity;
  supportSessionId: string;
  reason: string;
}): Promise<void> {
  assertPlatformCapability(input.actor, 'support:write');
  const reason = input.reason.trim();
  if (
    !/^[a-zA-Z0-9_-]{3,128}$/.test(input.supportSessionId) ||
    reason.length < 10 ||
    reason.length > 500
  ) {
    throw new PlatformSecurityError('A session and 10–500 character reason are required.', 400);
  }
  await withPlatformDb(async (db) => {
    const session = await db.platformSupportSession.findUnique({
      where: { id: input.supportSessionId },
      select: { id: true, organizationId: true, platformUserId: true, tenantUserId: true },
    });
    if (!session) throw new PlatformSecurityError('Support session was not found.', 400);
    const ended = await db.platformSupportSession.updateMany({
      where: { id: session.id, status: 'ACTIVE' },
      data: { status: 'ENDED', endedAt: new Date(), tokenCiphertext: null, launchTokenHash: null },
    });
    if (ended.count === 0) return;
    await db.platformAuditLog.create({
      data: {
        organizationId: session.organizationId,
        actorPlatformUserId: input.actor.id,
        actorTenantUserId: session.tenantUserId,
        action: 'support.session.force_ended',
        targetType: 'PlatformSupportSession',
        targetId: session.id,
        reason,
        metadata: { sessionPlatformUserId: session.platformUserId },
      },
    });
  });
}
