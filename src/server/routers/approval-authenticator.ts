import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { annotateAudit } from '../audit';
import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import {
  APPROVAL_TOTP_WINDOW,
  approvalAuthenticatorPartySelect,
  approvalAuthenticatorResetDenial,
} from '@/lib/approval-authenticator';
import {
  currentPasswordInput,
  requirePasswordReauthentication as requireAccountPassword,
} from '@/lib/password-reauthentication';
import { rateLimit } from '@/lib/rate-limit';
import { decryptSecret, encryptionConfigured, encryptSecret } from '@/lib/secret-crypto';
import { generateTotpSecret, matchTotpStep, totpAuthUri } from '@/lib/totp';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// DEV-879 — each member enrols an authenticator app for approvals in their own security
// settings. Enrolment is two-phase like sign-in 2FA: beginEnrollment stores an encrypted
// secret (enabledAt stays null = inactive) and confirmEnrollment activates it only after
// one valid code. The code used to confirm is consumed, so it cannot also approve an
// action. Recovery (reset) belongs to the owner or an administrator, with an audit record.
// The owner alone turns fixed approval PINs off for the whole organization.

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
    return {
      enrolled: Boolean(authenticator?.enabledAt),
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
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many attempts. Try later.',
        });
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
      annotateAudit(ctx, {
        targetType: 'User',
        targetId: userId,
        description: 'Enrolled an approval authenticator',
        metadata: { approvalAuthenticator: 'enrolled' },
      });
      return { enrolled: true };
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
      const removed = await ctx.db.approvalAuthenticator.deleteMany({
        where: { organizationId, userId: target.id },
      });
      annotateAudit(ctx, {
        operation: 'DELETE',
        targetType: 'User',
        targetId: target.id,
        description: 'Reset a member approval authenticator',
        metadata: { approvalAuthenticator: 'reset', resetById: actor.id, removed: removed.count },
      });
      return { reset: removed.count > 0 };
    }),

  // Owner only: refuse every fixed PIN for approvals across the organization.
  setRequired: protectedProcedure
    .input(z.strictObject({ required: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const organizationId = organizationOf(ctx);
      const actor = await liveParty(ctx, organizationId, ctx.session.user.id);
      if (!actor || !hasAllCapabilityAccess(actor))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the owner can change this setting.',
        });
      const saved = await ctx.db.organization.update({
        where: { id: organizationId },
        data: { requireApprovalAuthenticator: input.required },
        select: { requireApprovalAuthenticator: true },
      });
      annotateAudit(ctx, {
        operation: 'UPDATE',
        targetType: 'Organization',
        targetId: organizationId,
        description: `${saved.requireApprovalAuthenticator ? 'Required' : 'Stopped requiring'} an authenticator for approvals`,
        metadata: { requireApprovalAuthenticator: saved.requireApprovalAuthenticator },
      });
      return { required: saved.requireApprovalAuthenticator };
    }),
});
