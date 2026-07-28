import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import type { PlatformIdentity } from '@/lib/platform/auth';
import { parseCookie, PlatformSecurityError } from '@/lib/platform/security';
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

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

export async function createSupportSession(input: {
  actor: PlatformIdentity;
  organizationId: string;
  tenantUserId?: string;
  reason: string;
  durationMinutes?: number;
}) {
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
  if (!tenantUser || !['ACTIVE', 'ON_LEAVE'].includes(tenantUser.status)) {
    throw new PlatformSecurityError('No active tenant administrator is available.', 400);
  }

  const token = randomBytes(32).toString('base64url');
  const launchToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + duration * 60_000);
  const session = await withPlatformDb(async (platformDb) => {
    await platformDb.platformSupportSession.updateMany({
      where: {
        platformUserId: input.actor.id,
        organizationId: organization.id,
        status: 'ACTIVE',
      },
      data: { status: 'ENDED', endedAt: new Date() },
    });
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
      !session.tokenCiphertext
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
  const session = await withPlatformDb((platformDb) =>
    platformDb.platformSupportSession.findUnique({
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
    })
  );
  if (
    !session ||
    session.status !== 'ACTIVE' ||
    session.expiresAt <= new Date() ||
    !session.tenantUserId
  ) {
    return null;
  }
  const tenantUser = await withTenantDb(session.organizationId, (tenantDb) =>
    tenantDb.user.findUnique({
      where: { id: session.tenantUserId! },
      select: { id: true, role: true, status: true },
    })
  );
  if (!tenantUser || !['ACTIVE', 'ON_LEAVE'].includes(tenantUser.status)) return null;
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
    const session = await platformDb.platformSupportSession.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!session || session.status !== 'ACTIVE') return;
    await platformDb.platformSupportSession.update({
      where: { id: session.id },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    await platformDb.platformAuditLog.create({
      data: {
        organizationId: session.organizationId,
        actorPlatformUserId: session.platformUserId,
        actorTenantUserId: session.tenantUserId,
        action: 'support.session.ended',
        targetType: 'PlatformSupportSession',
        targetId: session.id,
        reason: session.reason,
      },
    });
  });
}
