import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { annotateAudit } from '../audit';
import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import {
  APPROVAL_TOTP_WINDOW,
  approvalAuthenticatorPartySelect,
  approvalAuthenticatorResetDenial,
  consumeMemberApprovalCode,
} from '@/lib/approval-authenticator';
import {
  currentPasswordInput,
  requirePasswordReauthentication as requireAccountPassword,
} from '@/lib/password-reauthentication';
import { approvalAuthenticatorGate } from '@/lib/approval-authenticator-gate';
import { rateLimit } from '@/lib/rate-limit';
import { decryptSecret, encryptionConfigured, encryptSecret } from '@/lib/secret-crypto';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchTotpStep,
  totpAuthUri,
} from '@/lib/totp';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// DEV-879 — each member enrols an authenticator app for approvals in their own security
// settings. Enrolment is two-phase like sign-in 2FA: beginEnrollment stores an encrypted
// secret (enabledAt stays null = inactive) and confirmEnrollment activates it only after
// one valid code. The code used to confirm is consumed, so it cannot also approve an
// action. Recovery (reset) belongs to the owner or an administrator, with an audit record.
// The owner alone turns fixed approval PINs off for the whole organization.
//
// DEV-961: the requirement is on by default. Confirming set-up issues one-time recovery codes,
// shown once and stored hashed; using one (with the member's password) removes the
// authenticator, so a lost phone is recovered by setting up a new one. Turning the
// requirement off needs the owner's own current code, or, before he has set one up, his
// password and a plain acknowledgement of what turning it off means.

const ENROLMENT_UNAVAILABLE =
  'Approval authenticators are not available until the server encryption key is configured.';

type Ctx = { db: ScopedDb; session: { user: { id: string; organizationId?: string | null } } };

function organizationOf(ctx: Ctx): string {
  const id = ctx.session.user.organizationId;
  if (!id) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
  return id;
}

async function liveParty(ctx: Ctx, organizationId: string, userId: string) {
  return ctx.db.user.findFirst({
    where: { id: userId, organizationId },
    select: approvalAuthenticatorPartySelect(),
  });
}

async function requireManager(ctx: Ctx, organizationId: string) {
  const actor = await liveParty(ctx, organizationId, ctx.session.user.id);
  if (
    !actor ||
    actor.status !== 'ACTIVE' ||
    !(hasAllCapabilityAccess(actor) || actor.role === 'ADMIN')
  )
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the owner or an administrator can manage approval authenticators.',
    });
  return actor;
}

const reauthentication = currentPasswordInput;

/** DEV-961: recovery codes issued at each confirmed set-up. */
export const APPROVAL_RECOVERY_CODE_COUNT = 10;

function tooManyAttempts(): TRPCError {
  return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try later.' });
}

const approvalCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/);

/**
 * Starting an enrolment or resetting an authenticator changes which factor approves money,
 * stock and controlled-drug actions, so a live session alone is not enough: the member
 * re-enters their current password, an independent factor a stolen session does not carry.
 * Attempts are rate limited per member.
 */
async function requirePasswordReauthentication(ctx: Ctx, organizationId: string, password: string) {
  await requireAccountPassword(ctx.db, {
    organizationId,
    userId: ctx.session.user.id,
    password,
    purpose: 'approval-authenticator',
  });
}

export const approvalAuthenticatorRouter = router({
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const organizationId = organizationOf(ctx);
    const [authenticator, organization, actor] = await Promise.all([
      ctx.db.approvalAuthenticator.findFirst({
        where: { organizationId, userId: ctx.session.user.id },
        select: { enabledAt: true },
      }),
      ctx.db.organization.findFirst({
        where: { id: organizationId },
        select: { requireApprovalAuthenticator: true },
      }),
      liveParty(ctx, organizationId, ctx.session.user.id),
    ]);
    const owner = Boolean(actor && hasAllCapabilityAccess(actor));
    const recoveryCodesLeft = authenticator?.enabledAt
      ? await ctx.db.approvalAuthenticatorRecoveryCode.count({
          where: { organizationId, userId: ctx.session.user.id, usedAt: null },
        })
      : 0;
    return {
      enrolled: Boolean(authenticator?.enabledAt),
      /** DEV-961: this member must finish set-up before the rest of the account works. */
      setupRequired: (
        await approvalAuthenticatorGate(ctx.db, {
          organizationId,
          userId: ctx.session.user.id,
          approver:
            typeof ctx.session.user.approvalApprover === 'boolean'
              ? ctx.session.user.approvalApprover
              : undefined,
        })
      ).setupRequired,
      recoveryCodesLeft,
      required: Boolean(organization?.requireApprovalAuthenticator),
      isOwner: owner,
      canManage: owner || (actor?.status === 'ACTIVE' && actor.role === 'ADMIN'),
      available: encryptionConfigured(),
    };
  }),

  // Phase 1: mint a secret and return it (+ otpauth URI for the QR code) once. Inactive
  // until confirmEnrollment succeeds. Restarting replaces any unconfirmed secret.
  beginEnrollment: protectedProcedure
    .input(z.strictObject({ currentPassword: reauthentication }))
    .mutation(async ({ ctx, input }) => {
      const organizationId = organizationOf(ctx);
      const userId = ctx.session.user.id;
      if (!encryptionConfigured())
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: ENROLMENT_UNAVAILABLE });
      if (!(await rateLimit(`approval-authenticator-begin:${userId}`, 10, 15 * 60_000)).ok)
        throw tooManyAttempts();
      await requirePasswordReauthentication(ctx, organizationId, input.currentPassword);
      const [user, existing] = await Promise.all([
        ctx.db.user.findFirst({ where: { id: userId, organizationId }, select: { email: true } }),
        ctx.db.approvalAuthenticator.findFirst({
          where: { organizationId, userId },
          select: { enabledAt: true },
        }),
      ]);
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' });
      if (existing?.enabledAt)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Your approval authenticator is already set up. Ask the owner or an administrator to reset it.',
        });
      const secret = generateTotpSecret();
      const encryptedSecret = encryptSecret(secret);
      await ctx.db.approvalAuthenticator.upsert({
        where: { organizationId_userId: { organizationId, userId } },
        create: { organizationId, userId, encryptedSecret },
        update: { encryptedSecret, enabledAt: null, lastUsedStep: null },
      });
      annotateAudit(ctx, {
        targetType: 'User',
        targetId: userId,
        description: 'Started approval authenticator enrolment',
        metadata: { approvalAuthenticator: 'enrolment-started' },
      });
      return { secret, otpauthUri: totpAuthUri(user.email, secret, 'DevFathom Approvals') };
    }),

  // Phase 2: one valid code activates the authenticator. From then on this member's
  // fixed PIN is no longer accepted for approvals.
  confirmEnrollment: protectedProcedure
    .input(
      z.strictObject({
        token: z
          .string()
          .trim()
          .regex(/^\d{6}$/),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = organizationOf(ctx);
      const userId = ctx.session.user.id;
      if (!(await rateLimit(`approval-authenticator-confirm:${userId}`, 10, 15 * 60_000)).ok)
        throw tooManyAttempts();
      const pending = await ctx.db.approvalAuthenticator.findFirst({
        where: { organizationId, userId },
        select: { id: true, encryptedSecret: true, enabledAt: true },
      });
      if (!pending)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Start the set-up first.' });
      if (pending.enabledAt)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Your approval authenticator is already set up.',
        });
      let step: number | null = null;
      try {
        step = matchTotpStep(
          decryptSecret(pending.encryptedSecret),
          input.token,
          APPROVAL_TOTP_WINDOW
        );
      } catch {
        step = null;
      }
      if (step === null)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That code is incorrect. Try again.' });
      const activated = await ctx.db.approvalAuthenticator.updateMany({
        // Bound to the secret this code was checked against: if set-up was restarted
        // meanwhile (another tab), the replaced secret is not activated.
        where: { id: pending.id, enabledAt: null, encryptedSecret: pending.encryptedSecret },
        data: { enabledAt: new Date(), lastUsedStep: step },
      });
      if (activated.count !== 1)
        throw new TRPCError({ code: 'CONFLICT', message: 'Start the set-up again.' });
      // DEV-961: fresh one-time recovery codes, shown once; only their hashes are kept and
      // any codes from an earlier set-up stop working.
      const { codes, hashes } = generateRecoveryCodes(APPROVAL_RECOVERY_CODE_COUNT);
      await ctx.db.approvalAuthenticatorRecoveryCode.deleteMany({
        where: { organizationId, userId },
      });
      await ctx.db.approvalAuthenticatorRecoveryCode.createMany({
        data: hashes.map((codeHash) => ({ organizationId, userId, codeHash })),
      });
      annotateAudit(ctx, {
        targetType: 'User',
        targetId: userId,
        description: 'Enrolled an approval authenticator',
        metadata: { approvalAuthenticator: 'enrolled', recoveryCodesIssued: hashes.length },
      });
      return { enrolled: true, recoveryCodes: codes };
    }),

  // DEV-961: a member who lost their phone uses one of their recovery codes, with their
  // password. The code is spent, the authenticator is removed and the other codes stop
  // working, so they must set up a new authenticator before approving (and, while the
  // organization requires one, before using their account).
  useRecoveryCode: protectedProcedure
    .input(
      z.strictObject({
        code: z.string().trim().min(1).max(32),
        currentPassword: reauthentication,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = organizationOf(ctx);
      const userId = ctx.session.user.id;
      if (!(await rateLimit(`approval-authenticator-recovery:${userId}`, 5, 15 * 60_000)).ok)
        throw tooManyAttempts();
      annotateAudit(ctx, { skipInput: true });
      await requirePasswordReauthentication(ctx, organizationId, input.currentPassword);
      const spent = await ctx.db.approvalAuthenticatorRecoveryCode.updateMany({
        where: { organizationId, userId, codeHash: hashRecoveryCode(input.code), usedAt: null },
        data: { usedAt: new Date() },
      });
      if (spent.count !== 1)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That recovery code is not valid or has already been used.',
        });
      const [removed] = await Promise.all([
        ctx.db.approvalAuthenticator.deleteMany({ where: { organizationId, userId } }),
        ctx.db.approvalAuthenticatorRecoveryCode.deleteMany({
          where: { organizationId, userId, usedAt: null },
        }),
      ]);
      annotateAudit(ctx, {
        operation: 'DELETE',
        targetType: 'User',
        targetId: userId,
        description: 'Used an approval authenticator recovery code',
        metadata: { approvalAuthenticator: 'recovery-code-used', removed: removed.count },
      });
      return { reset: true };
    }),

  // Owner and administrators: who has an approval authenticator, for recovery.
  members: protectedProcedure.query(async ({ ctx }) => {
    const organizationId = organizationOf(ctx);
    await requireManager(ctx, organizationId);
    const [members, authenticators] = await Promise.all([
      ctx.db.user.findMany({
        where: { organizationId, status: 'ACTIVE' },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      ctx.db.approvalAuthenticator.findMany({
        where: { organizationId, enabledAt: { not: null } },
        select: { userId: true },
      }),
    ]);
    const enrolled = new Set(authenticators.map((row) => row.userId));
    return members.map((member) => ({
      id: member.id,
      name: member.name,
      enrolled: enrolled.has(member.id),
    }));
  }),

  // DEV-961: staff profiles with a PIN but no web login cannot set up an authenticator, so
  // they keep approving with their PIN while the requirement is on. Listed for the owner.
  terminalOnlyApprovers: protectedProcedure.query(async ({ ctx }) => {
    const organizationId = organizationOf(ctx);
    await requireManager(ctx, organizationId);
    const profiles = await ctx.db.restaurantStaffProfile.findMany({
      where: {
        organizationId,
        userId: null,
        status: 'ACTIVE',
        credentials: { some: { type: 'PIN', revokedAt: null } },
      },
      select: { id: true, displayName: true },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    });
    return profiles;
  }),

  // Recovery: remove a member's approval authenticator so they can enrol a new phone.
  resetForMember: protectedProcedure
    .input(z.strictObject({ userId: z.string().min(1), currentPassword: reauthentication }))
    .mutation(async ({ ctx, input }) => {
      const organizationId = organizationOf(ctx);
      await requirePasswordReauthentication(ctx, organizationId, input.currentPassword);
      const [actor, target] = await Promise.all([
        liveParty(ctx, organizationId, ctx.session.user.id),
        liveParty(ctx, organizationId, input.userId),
      ]);
      if (!actor || !target)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
      const denial = approvalAuthenticatorResetDenial(actor, target);
      if (denial) throw new TRPCError({ code: 'FORBIDDEN', message: denial });
      const [removed] = await Promise.all([
        ctx.db.approvalAuthenticator.deleteMany({
          where: { organizationId, userId: target.id },
        }),
        ctx.db.approvalAuthenticatorRecoveryCode.deleteMany({
          where: { organizationId, userId: target.id },
        }),
      ]);
      annotateAudit(ctx, {
        operation: 'DELETE',
        targetType: 'User',
        targetId: target.id,
        description: 'Reset a member approval authenticator',
        metadata: { approvalAuthenticator: 'reset', resetById: actor.id, removed: removed.count },
      });
      return { reset: removed.count > 0 };
    }),

  // Owner only: refuse every fixed PIN for approvals across the organization (the default,
  // DEV-961). Turning it off is confirmed with the owner's own current authenticator code, or,
  // when he has not set one up, his password and an acknowledgement of what it means.
  setRequired: protectedProcedure
    .input(
      z.union([
        z.strictObject({ required: z.literal(true) }),
        z.strictObject({ required: z.literal(false), code: approvalCode }),
        z.strictObject({
          required: z.literal(false),
          currentPassword: reauthentication,
          acknowledged: z.literal(true),
        }),
      ])
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = organizationOf(ctx);
      const userId = ctx.session.user.id;
      annotateAudit(ctx, { skipInput: true });
      const actor = await liveParty(ctx, organizationId, userId);
      if (!actor || !hasAllCapabilityAccess(actor))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the owner can change this setting.',
        });
      let confirmedWith: 'AUTHENTICATOR' | 'PASSWORD' | null = null;
      if (!input.required) {
        if (!(await rateLimit(`approval-authenticator-off:${userId}`, 5, 15 * 60_000)).ok)
          throw tooManyAttempts();
        const ownAuthenticator = await ctx.db.approvalAuthenticator.findFirst({
          where: { organizationId, userId, enabledAt: { not: null } },
          select: { id: true },
        });
        if ('code' in input) {
          if (
            !(await consumeMemberApprovalCode(ctx.db, {
              organizationId,
              userId,
              code: input.code,
              action: 'approvalAuthenticator.setRequired',
            }))
          )
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'That code is incorrect. Enter the current code from your app.',
            });
          confirmedWith = 'AUTHENTICATOR';
        } else {
          if (ownAuthenticator)
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Confirm with the current code from your authenticator app.',
            });
          await requirePasswordReauthentication(ctx, organizationId, input.currentPassword);
          confirmedWith = 'PASSWORD';
        }
      }
      const saved = await ctx.db.organization.update({
        where: { id: organizationId },
        data: { requireApprovalAuthenticator: input.required },
        select: { requireApprovalAuthenticator: true },
      });
      annotateAudit(ctx, {
        operation: 'UPDATE',
        targetType: 'Organization',
        targetId: organizationId,
        description: saved.requireApprovalAuthenticator
          ? 'Turned the authenticator for approvals on'
          : 'Turned the authenticator for approvals off: approvals take permanent PINs',
        metadata: {
          requireApprovalAuthenticator: saved.requireApprovalAuthenticator,
          ...(confirmedWith ? { confirmedWith } : {}),
        },
      });
      return { required: saved.requireApprovalAuthenticator };
    }),
});
