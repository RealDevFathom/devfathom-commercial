import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { compare } from 'bcryptjs';
import { cookies } from 'next/headers';
import type { PlatformRole } from '@/generated/prisma/client';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { parseCookie, PlatformSecurityError } from '@/lib/platform/security';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { decryptSecret } from '@/lib/secret-crypto';
import { hashRecoveryCode, verifyTotp } from '@/lib/totp';
import { canPlatformRole } from '@/lib/platform/capabilities';

export const PLATFORM_SESSION_COOKIE = 'df_platform_session';
const PLATFORM_SESSION_HOURS = 8;
const DUMMY_PASSWORD_HASH = '$2b$10$7QJYoH3B/paYYQ5XzE5H0.u6cN6S6dJ0o.W3Xf/ObKZxrZTpTI46S';

export type PlatformIdentity = {
  sessionId: string;
  id: string;
  name: string;
  email: string;
  role: PlatformRole;
  expiresAt: Date;
  mfaEnabled: boolean;
};

export type PlatformSessionToken = {
  token: string;
  expiresAt: Date;
  identity: PlatformIdentity;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenFromRequest(request?: Request): Promise<string | null> | string | null {
  if (request) return parseCookie(request.headers.get('cookie'), PLATFORM_SESSION_COOKIE);
  return cookies().then((store) => store.get(PLATFORM_SESSION_COOKIE)?.value ?? null);
}

export function platformCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  };
}

export function canPlatform(identity: Pick<PlatformIdentity, 'role'>, capability: string): boolean {
  return canPlatformRole(identity.role, capability);
}

export function assertPlatformCapability(
  identity: Pick<PlatformIdentity, 'role'>,
  capability: string
) {
  if (!canPlatform(identity, capability)) {
    throw new PlatformSecurityError('You do not have permission for this action.', 403);
  }
}

export async function createPlatformSession(
  emailInput: string,
  password: string,
  authenticationCode: string | undefined,
  request: Request
): Promise<PlatformSessionToken> {
  const email = emailInput.trim().toLowerCase();
  const ip = clientIp(request);
  const gate = rateLimit(`platform-login:${ip}:${email}`, 8, 15 * 60_000);
  if (!gate.ok) {
    throw new PlatformSecurityError('Too many sign-in attempts. Try again later.', 429);
  }

  const user = await withPlatformDb((platformDb) =>
    platformDb.platformUser.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        role: true,
        active: true,
        mfaRequired: true,
        encryptedTotpSecret: true,
        mfaEnabledAt: true,
      },
    })
  );
  const passwordValid = await compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !passwordValid || !user.active) {
    throw new PlatformSecurityError('Email or password is incorrect.', 401);
  }

  const mfaEnabled = Boolean(user.mfaEnabledAt && user.encryptedTotpSecret);
  if (user.mfaRequired || mfaEnabled) {
    const code = authenticationCode?.trim() ?? '';
    let valid = false;
    if (mfaEnabled && /^\d{6}$/.test(code)) {
      try {
        valid = verifyTotp(decryptSecret(user.encryptedTotpSecret!), code);
      } catch {
        valid = false;
      }
    }
    if (!valid && code) {
      const codeHash = hashRecoveryCode(code);
      valid = await withPlatformDb(async (platformDb) => {
        const recovery = await platformDb.platformRecoveryCode.findUnique({
          where: {
            platformUserId_codeHash: {
              platformUserId: user.id,
              codeHash,
            },
          },
          select: { id: true, usedAt: true },
        });
        if (!recovery || recovery.usedAt) return false;
        const consumed = await platformDb.platformRecoveryCode.updateMany({
          where: { id: recovery.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        return consumed.count === 1;
      });
    }
    if (!valid) {
      throw new PlatformSecurityError('Email, password, or authentication code is incorrect.', 401);
    }
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PLATFORM_SESSION_HOURS * 60 * 60 * 1000);
  const session = await withPlatformDb(async (platformDb) => {
    const created = await platformDb.platformSession.create({
      data: {
        platformUserId: user.id,
        tokenHash: hashToken(token),
        expiresAt,
        ip,
        userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
      },
    });
    await platformDb.platformUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await platformDb.platformAuditLog.create({
      data: {
        actorPlatformUserId: user.id,
        action: 'platform.session.created',
        targetType: 'PlatformSession',
        targetId: created.id,
        ip,
        userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
      },
    });
    return created;
  });

  return {
    token,
    expiresAt,
    identity: {
      sessionId: session.id,
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      expiresAt,
      mfaEnabled,
    },
  };
}

export async function getPlatformSession(request?: Request): Promise<PlatformIdentity | null> {
  const token = await tokenFromRequest(request);
  if (!token || token.length < 32 || token.length > 128) return null;

  const session = await withPlatformDb((platformDb) =>
    platformDb.platformSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        platformUser: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            active: true,
            mfaEnabledAt: true,
          },
        },
      },
    })
  );
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= new Date() ||
    !session.platformUser.active
  ) {
    return null;
  }

  return {
    sessionId: session.id,
    id: session.platformUser.id,
    name: session.platformUser.name,
    email: session.platformUser.email,
    role: session.platformUser.role,
    expiresAt: session.expiresAt,
    mfaEnabled: Boolean(session.platformUser.mfaEnabledAt),
  };
}

export async function requirePlatformSession(
  request?: Request,
  capability?: string
): Promise<PlatformIdentity> {
  const identity = await getPlatformSession(request);
  if (!identity) throw new PlatformSecurityError('Platform authentication is required.', 401);
  if (capability) assertPlatformCapability(identity, capability);
  return identity;
}

export async function revokePlatformSession(request?: Request): Promise<void> {
  const token = await tokenFromRequest(request);
  if (!token) return;
  const tokenHash = hashToken(token);
  await withPlatformDb(async (platformDb) => {
    const session = await platformDb.platformSession.findUnique({
      where: { tokenHash },
      select: { id: true, platformUserId: true, revokedAt: true },
    });
    if (!session || session.revokedAt) return;
    await platformDb.platformSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    await platformDb.platformAuditLog.create({
      data: {
        actorPlatformUserId: session.platformUserId,
        action: 'platform.session.revoked',
        targetType: 'PlatformSession',
        targetId: session.id,
      },
    });
  });
}
