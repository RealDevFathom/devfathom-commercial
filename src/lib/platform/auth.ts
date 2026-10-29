import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { compare } from 'bcryptjs';
import { cookies } from 'next/headers';
import type { PlatformRole } from '@/generated/prisma/client';
import { clearRateLimit, clientIp, rateLimit } from '@/lib/rate-limit';
import { parseCookie, PlatformSecurityError } from '@/lib/platform/security';
import { type ScopedDb, withPlatformDb } from '@/lib/tenancy/scoped-db';
import { decryptSecret } from '@/lib/secret-crypto';
import { hashRecoveryCode, verifyTotp } from '@/lib/totp';
import { canPlatformRole } from '@/lib/platform/capabilities';

export const PLATFORM_SESSION_COOKIE = 'df_platform_session';
const PLATFORM_SESSION_HOURS = 8;
const ENROLLMENT_PREFIX = 'enroll_';

export function platformRoleRequiresMfa(role: PlatformRole): boolean {
  return (
    process.env.PLATFORM_MFA_ENFORCE !== 'false' &&
    ['SUPER_ADMIN', 'OPERATIONS', 'SUPPORT'].includes(role)
  );
}
const DUMMY_PASSWORD_HASH = '$2b$10$7QJYoH3B/paYYQ5XzE5H0.u6cN6S6dJ0o.W3Xf/ObKZxrZTpTI46S';

export type PlatformIdentity = {
  sessionId: string;
  id: string;
  name: string;
  email: string;
  role: PlatformRole;
  expiresAt: Date;
  mfaEnabled: boolean;
  enrollmentOnly?: boolean;
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

export function canPlatform(
  identity: Pick<PlatformIdentity, 'role' | 'enrollmentOnly'>,
  capability: string
): boolean {
  return !identity.enrollmentOnly && canPlatformRole(identity.role, capability);
}

export function assertPlatformCapability(
  identity: Pick<PlatformIdentity, 'role' | 'enrollmentOnly'>,
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
  const rateLimitKey = `platform-login:${ip}:${email}`;
  const gate = await rateLimit(rateLimitKey, 8, 15 * 60_000);
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
  const enrollmentOnly = !mfaEnabled && (user.mfaRequired || platformRoleRequiresMfa(user.role));
  if (mfaEnabled) {
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

  // Successful authentication must not consume the failure budget. Otherwise
  // normal serial control-plane workflows lock out the same authorized user.
  await clearRateLimit(rateLimitKey);

  const token = (enrollmentOnly ? ENROLLMENT_PREFIX : '') + randomBytes(32).toString('base64url');
  const expiresAt = new Date(
    Date.now() + (enrollmentOnly ? 10 * 60_000 : PLATFORM_SESSION_HOURS * 60 * 60 * 1000)
  );
  const session = await withPlatformDb(async (platformDb) => {
    // Serialize session issuance with enrollment/reset and recheck the snapshot
    // whose password and second factor were verified above.
    await platformDb.$queryRawUnsafe(
      'SELECT id FROM platform_users WHERE id = $1 FOR UPDATE',
      user.id
    );
    const current = await platformDb.platformUser.findUnique({ where: { id: user.id } });
    if (
      !current?.active ||
      current.passwordHash !== user.passwordHash ||
      current.role !== user.role ||
      current.mfaRequired !== user.mfaRequired ||
      current.encryptedTotpSecret !== user.encryptedTotpSecret ||
      Boolean(current.mfaEnabledAt) !== Boolean(user.mfaEnabledAt)
    ) {
      throw new PlatformSecurityError('Your account changed. Sign in again.', 401);
    }
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
        action: enrollmentOnly ? 'platform.session.enrollment.created' : 'platform.session.created',
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
      enrollmentOnly,
    },
  };
}

async function readPlatformSession(
  request?: Request,
  allowEnrollment = false
): Promise<PlatformIdentity | null> {
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
            encryptedTotpSecret: true,
            mfaRequired: true,
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

  const enrollmentOnly = token.startsWith(ENROLLMENT_PREFIX);
  const mfaEnabled = Boolean(
    session.platformUser.mfaEnabledAt && session.platformUser.encryptedTotpSecret
  );
  if (enrollmentOnly && !allowEnrollment) return null;
  if (
    !enrollmentOnly &&
    !mfaEnabled &&
    (session.platformUser.mfaRequired || platformRoleRequiresMfa(session.platformUser.role))
  )
    return null;
  return {
    sessionId: session.id,
    id: session.platformUser.id,
    name: session.platformUser.name,
    email: session.platformUser.email,
    role: session.platformUser.role,
    expiresAt: session.expiresAt,
    mfaEnabled,
    enrollmentOnly,
  };
}

export async function getPlatformSession(request?: Request): Promise<PlatformIdentity | null> {
  return readPlatformSession(request);
}

/** The login page needs only enrollment state, never an enrollment identity's privileges. */
export async function platformLoginNeedsEnrollment(request?: Request): Promise<boolean> {
  return Boolean((await readPlatformSession(request, true))?.enrollmentOnly);
}

// Only the MFA endpoint may use this accessor. Enrollment tokens never pass
// getPlatformSession/requirePlatformSession, including after another enrollment.
export async function requirePlatformMfaSession(request: Request): Promise<PlatformIdentity> {
  const identity = await readPlatformSession(request, true);
  if (!identity) throw new PlatformSecurityError('Platform authentication is required.', 401);
  return identity;
}

export async function promotePlatformEnrollment(
  db: ScopedDb,
  actor: PlatformIdentity,
  request: Request
) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PLATFORM_SESSION_HOURS * 60 * 60 * 1000);
  await db.platformSession.updateMany({
    where: { platformUserId: actor.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const session = await db.platformSession.create({
    data: {
      platformUserId: actor.id,
      tokenHash: hashToken(token),
      expiresAt,
      ip: clientIp(request),
      userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
    },
  });
  await db.platformAuditLog.create({
    data: {
      actorPlatformUserId: actor.id,
      action: 'platform.session.created',
      targetType: 'PlatformSession',
      targetId: session.id,
    },
  });
  return { token, expiresAt };
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
