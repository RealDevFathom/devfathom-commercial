import { z } from 'zod';
import { NextResponse } from 'next/server';
import { readBoundedJson } from '@/lib/http/read-bounded-body';
import {
  requirePlatformMfaSession,
  platformRoleRequiresMfa,
  promotePlatformEnrollment,
  PLATFORM_SESSION_COOKIE,
  platformCookieOptions,
} from '@/lib/platform/auth';
import { rateLimit } from '@/lib/rate-limit';
import { assertPlatformMutationOrigin, PlatformSecurityError } from '@/lib/platform/security';
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto';
import { generateRecoveryCodes, generateTotpSecret, totpAuthUri, verifyTotp } from '@/lib/totp';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('begin') }),
  z.object({ action: z.literal('confirm'), code: z.string().trim().min(6).max(20) }),
  z.object({ action: z.literal('regenerate'), code: z.string().trim().min(6).max(20) }),
  z.object({ action: z.literal('disable'), code: z.string().trim().min(6).max(20) }),
]);

function failure(error: unknown) {
  if (error instanceof PlatformSecurityError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: 'Review the MFA request.' }, { status: 400 });
  }
  console.error('Platform MFA error:', error);
  return NextResponse.json({ error: 'Unable to update platform MFA.' }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const actor = await requirePlatformMfaSession(request);
    const status = await withPlatformDb(async (db) => {
      const [user, recoveryCodes] = await Promise.all([
        db.platformUser.findUnique({
          where: { id: actor.id },
          select: { mfaRequired: true, mfaEnabledAt: true, role: true },
        }),
        db.platformRecoveryCode.count({
          where: { platformUserId: actor.id, usedAt: null },
        }),
      ]);
      return {
        enabled: Boolean(user?.mfaEnabledAt),
        required: Boolean(user && (user.mfaRequired || platformRoleRequiresMfa(user.role))),
        enrollmentOnly: Boolean(actor.enrollmentOnly),
        recoveryCodes,
      };
    });
    return NextResponse.json(status, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertPlatformMutationOrigin(request);
    const actor = await requirePlatformMfaSession(request);
    const requestBody = await readBoundedJson(request, 1024);
    if (requestBody.tooLarge)
      return NextResponse.json({ error: 'Request body is too large.' }, { status: 413 });
    const input = actionSchema.parse(requestBody.value);
    if (actor.enrollmentOnly && !['begin', 'confirm'].includes(input.action)) {
      throw new PlatformSecurityError('Complete MFA enrollment first.', 403);
    }
    if (!(await rateLimit(`platform-mfa:${actor.id}`, 12, 15 * 60_000)).ok) {
      throw new PlatformSecurityError('Too many MFA attempts. Try again later.', 429);
    }
    const result = await withPlatformDb(async (db) => {
      await db.$queryRawUnsafe('SELECT id FROM platform_users WHERE id = $1 FOR UPDATE', actor.id);
      const session = await db.platformSession.findUnique({ where: { id: actor.sessionId } });
      if (!session || session.revokedAt || session.expiresAt <= new Date()) {
        throw new PlatformSecurityError('Sign in again before updating MFA.', 401);
      }
      const user = await db.platformUser.findUnique({
        where: { id: actor.id },
        select: {
          id: true,
          email: true,
          active: true,
          role: true,
          encryptedTotpSecret: true,
          mfaEnabledAt: true,
          mfaRequired: true,
        },
      });
      if (!user?.active) throw new PlatformSecurityError('Operator not found.', 401);

      if (input.action === 'begin') {
        if (user.mfaEnabledAt) {
          throw new PlatformSecurityError('MFA is already enabled.', 400);
        }
        const secret = generateTotpSecret();
        await db.platformUser.update({
          where: { id: user.id },
          data: { encryptedTotpSecret: encryptSecret(secret) },
        });
        await db.platformAuditLog.create({
          data: {
            actorPlatformUserId: user.id,
            action: 'platform.mfa.enrollment.started',
            targetType: 'PlatformUser',
            targetId: user.id,
          },
        });
        return {
          action: input.action,
          secret,
          otpauthUri: totpAuthUri(user.email, secret, 'DevFathom Control'),
        };
      }

      if (!user.encryptedTotpSecret) {
        throw new PlatformSecurityError('Start MFA enrollment first.', 400);
      }
      const valid = verifyTotp(decryptSecret(user.encryptedTotpSecret), input.code);
      if (!valid) throw new PlatformSecurityError('The authentication code is invalid.', 400);

      if (input.action === 'confirm') {
        if (user.mfaEnabledAt) {
          throw new PlatformSecurityError('MFA is already enabled.', 400);
        }
        const recovery = generateRecoveryCodes();
        await db.platformRecoveryCode.deleteMany({ where: { platformUserId: user.id } });
        await db.platformRecoveryCode.createMany({
          data: recovery.hashes.map((codeHash) => ({ platformUserId: user.id, codeHash })),
        });
        await db.platformUser.update({
          where: { id: user.id },
          data: { mfaEnabledAt: new Date(), mfaRequired: true },
        });
        await db.platformSession.updateMany({
          where: { platformUserId: user.id, id: { not: actor.sessionId }, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await db.platformAuditLog.create({
          data: {
            actorPlatformUserId: user.id,
            action: 'platform.mfa.enabled',
            targetType: 'PlatformUser',
            targetId: user.id,
          },
        });
        return {
          action: input.action,
          recoveryCodes: recovery.codes,
          ...(actor.enrollmentOnly
            ? { session: await promotePlatformEnrollment(db, actor, request) }
            : {}),
        };
      }

      if (input.action === 'regenerate') {
        if (!user.mfaEnabledAt) {
          throw new PlatformSecurityError('MFA is not enabled.', 400);
        }
        const recovery = generateRecoveryCodes();
        await db.platformRecoveryCode.deleteMany({ where: { platformUserId: user.id } });
        await db.platformRecoveryCode.createMany({
          data: recovery.hashes.map((codeHash) => ({ platformUserId: user.id, codeHash })),
        });
        await db.platformAuditLog.create({
          data: {
            actorPlatformUserId: user.id,
            action: 'platform.mfa.recovery.regenerated',
            targetType: 'PlatformUser',
            targetId: user.id,
          },
        });
        return { action: input.action, recoveryCodes: recovery.codes };
      }

      if (user.mfaRequired || platformRoleRequiresMfa(user.role)) {
        throw new PlatformSecurityError(
          'MFA is required by policy. A super administrator must remove the requirement first.',
          403
        );
      }
      await db.platformRecoveryCode.deleteMany({ where: { platformUserId: user.id } });
      await db.platformUser.update({
        where: { id: user.id },
        data: { encryptedTotpSecret: null, mfaEnabledAt: null },
      });
      await db.platformAuditLog.create({
        data: {
          actorPlatformUserId: user.id,
          action: 'platform.mfa.disabled',
          targetType: 'PlatformUser',
          targetId: user.id,
        },
      });
      return { action: input.action, success: true };
    });
    const { session, ...body } = result as typeof result & {
      session?: { token: string; expiresAt: Date };
    };
    const response = NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
    if (session)
      response.cookies.set(
        PLATFORM_SESSION_COOKIE,
        session.token,
        platformCookieOptions(session.expiresAt)
      );
    return response;
  } catch (error) {
    return failure(error);
  }
}
