import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { ACTIVE_STATUSES } from '@/lib/abac';
import { approvalAuthenticatorPartySelect } from '@/lib/approval-authenticator';
import { currentPasswordInput } from '@/lib/password-reauthentication';
import {
  managesStaffPins,
  OwnPinError,
  pinResetDenial,
  readOwnPinState,
  resetMemberPin,
  requireMemberPinReset,
  setOwnPinWithPassword,
} from '@/lib/pharmacy/own-pin';
import { OWN_PIN_MAX_LENGTH } from '@/lib/pharmacy/own-pin-policy';
import { CredentialLifecycleError } from '@/lib/restaurant/credential-lifecycle';
import { CredentialPolicyError } from '@/lib/restaurant/operator-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '@/server/audit';
import { protectedProcedure, router, type TRPCContext } from '@/server/trpc';

/**
 * DEV-931 — "Your PIN" in pharmacy Settings.
 *
 * Every signed-in pharmacy member creates or changes their own approval PIN here, after
 * re-entering their account password (checked on the server, rate limited). The PIN is the
 * existing operator credential (see `src/lib/pharmacy/own-pin.ts`); it is never returned,
 * logged or written to the audit row, whose input capture is skipped on every mutation.
 *
 * The owner, an administrator, or a member granted `staff:manage` resets another member's
 * PIN (it is revoked and the member creates a new one); they never set or see it. A support
 * or impersonation session can do neither. Every create, change and reset is audited with
 * who, for whom and when. All reads and writes are scoped to the session's organization.
 */

const SUPPORT_REFUSED = 'A support session cannot set or reset a PIN.';

function actor(ctx: TRPCContext): { organizationId: string; userId: string } {
  const organizationId = ctx.entitlements?.organizationId;
  const userId = ctx.session?.user?.id;
  if (!organizationId || !userId || ctx.session?.user?.organizationId !== organizationId)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No tenant actor on this request.' });
  return { organizationId, userId };
}

function supportSession(ctx: TRPCContext): boolean {
  return Boolean(ctx.support || ctx.session?.user?.isSupportSession);
}

async function liveParty(db: ScopedDb, organizationId: string, userId: string) {
  return db.user.findFirst({
    where: { id: userId, organizationId },
    select: { ...approvalAuthenticatorPartySelect(), department: true },
  });
}

function mapPinError(error: unknown): never {
  if (error instanceof CredentialPolicyError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  if (error instanceof OwnPinError)
    throw new TRPCError({
      code: error.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'FORBIDDEN',
      message: error.message,
    });
  if (error instanceof CredentialLifecycleError)
    throw new TRPCError({ code: 'CONFLICT', message: 'Your PIN changed elsewhere. Try again.' });
  throw error;
}

export const pharmacyPinRouter = router({
  /** The caller's own PIN state, and whether they may reset other people's PINs. */
  status: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const { organizationId, userId } = actor(ctx);
    const support = supportSession(ctx);
    const [pin, party] = await Promise.all([
      readOwnPinState(ctx.db, organizationId, userId),
      liveParty(ctx.db, organizationId, userId),
    ]);
    return {
      ...pin,
      state: pin.mustChange ? ('MUST_CHANGE' as const) : pin.state,
      supportSession: support,
      canResetOthers: !support && !!party && (await managesStaffPins(ctx.db, party)),
    };
  }),

  /** Create or change the caller's own PIN. Never takes another person's id. */
  setMine: protectedProcedure
    .input(
      z.strictObject({
        currentPassword: currentPasswordInput,
        pin: z.string().max(OWN_PIN_MAX_LENGTH * 2),
        confirmPin: z.string().max(OWN_PIN_MAX_LENGTH * 2),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Neither the PIN nor the password ever reaches the audit row, on success or refusal.
      annotateAudit(ctx, { skipInput: true, targetType: 'User' });
      const { organizationId, userId } = actor(ctx);
      annotateAudit(ctx, { targetId: userId });
      if (supportSession(ctx)) throw new TRPCError({ code: 'FORBIDDEN', message: SUPPORT_REFUSED });
      try {
        const saved = await setOwnPinWithPassword(ctx.db, {
          organizationId,
          userId,
          currentPassword: input.currentPassword,
          pin: input.pin,
          confirmPin: input.confirmPin,
        });
        annotateAudit(ctx, {
          skipInput: true,
          operation: saved.action === 'created' ? 'CREATE' : 'UPDATE',
          targetType: 'User',
          targetId: userId,
          description:
            saved.action === 'created' ? 'Created their own PIN' : 'Changed their own PIN',
          metadata: {
            pinAction: saved.action,
            forUserId: userId,
            byUserId: userId,
            staffProfileId: saved.staffProfileId,
            credentialId: saved.credentialId,
          },
        });
        return { action: saved.action, state: 'SET' as const };
      } catch (error) {
        mapPinError(error);
      }
    }),

  /** Members whose PIN the caller may reset, with whether each has one. Never the PIN. */
  members: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const { organizationId, userId } = actor(ctx);
    const party = await liveParty(ctx.db, organizationId, userId);
    if (supportSession(ctx) || !party || !(await managesStaffPins(ctx.db, party)))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only the owner or a manager who manages staff can reset a PIN.',
      });
    const members = await ctx.db.user.findMany({
      where: {
        organizationId,
        id: { not: userId },
        status: { in: [...ACTIVE_STATUSES] as Array<'ACTIVE' | 'ON_LEAVE'> },
      },
      select: { ...approvalAuthenticatorPartySelect(), department: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const pins = await ctx.db.restaurantOperatorCredential.findMany({
      where: {
        organizationId,
        type: 'PIN',
        deviceId: null,
        revokedAt: null,
        staffProfile: {
          organizationId,
          status: 'ACTIVE',
          userId: { in: members.map((member) => member.id) },
        },
      },
      select: { staffProfile: { select: { userId: true } } },
    });
    const withPin = new Set(pins.map((pin) => pin.staffProfile.userId));
    return Promise.all(
      members.map(async (member) => ({
        id: member.id,
        name: member.name,
        hasPin: withPin.has(member.id),
        canReset: (await pinResetDenial(ctx.db, party, member)) === null,
      }))
    );
  }),

  /** Revoke another member's PIN; they create a new one themselves. */
  resetForMember: protectedProcedure
    .input(
      z.strictObject({ userId: z.string().min(1).max(200), currentPassword: currentPasswordInput })
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true, targetType: 'User', targetId: input.userId });
      const { organizationId, userId } = actor(ctx);
      if (supportSession(ctx)) throw new TRPCError({ code: 'FORBIDDEN', message: SUPPORT_REFUSED });
      await requireMemberPinReset(ctx.db, {
        organizationId,
        actorId: userId,
        targetId: input.userId,
        currentPassword: input.currentPassword,
      });
      const revoked = await ctx.db.$transaction(async (tx) => {
        const count = await resetMemberPin(tx as unknown as ScopedDb, {
          organizationId,
          userId: input.userId,
        });
        if (!count)
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'This person has no PIN to reset.' });
        await tx.notification.create({
          data: {
            organizationId,
            userId: input.userId,
            type: 'approval_pin_reset',
            title: 'Your approval PIN was reset',
            message:
              'A staff manager reset your PIN. Open Your PIN in Settings and use your password to set a new one.',
            entityType: 'User',
            entityId: userId,
          },
        });
        return count;
      });
      annotateAudit(ctx, {
        skipInput: true,
        operation: 'UPDATE',
        targetType: 'User',
        targetId: input.userId,
        description: "Reset a staff member's PIN",
        metadata: { pinAction: 'reset', forUserId: input.userId, byUserId: userId, revoked },
      });
      return { reset: true };
    }),
});
