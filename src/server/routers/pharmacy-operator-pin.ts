import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  enrolPharmacyOperatorPin,
  listPharmacyPinStatus,
  PharmacyPinEnrolmentError,
} from '@/lib/pharmacy/operator-pin';
import { annotateAudit } from '@/server/audit';

import { capabilityProcedure, router, type TRPCContext } from '../trpc';

// Owner/manager PIN enrolment for pharmacy approvals. Licensed by the mandatory
// `pharmacy-core` module (module-catalog), never by `restaurant-core`.
const ownerOrManager = capabilityProcedure('pharmacy:manage');

const pinSchema = z.string().regex(/^\d{4,8}$/, 'A PIN must be 4–8 digits.');

function pharmacyActor(ctx: TRPCContext) {
  const organizationId = ctx.entitlements?.organizationId;
  const user = ctx.session?.user;
  if (!organizationId || !user?.id) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (
    ctx.organization?.vertical !== 'PHARMACY' ||
    ctx.organization.id !== organizationId ||
    user.organizationId !== organizationId
  )
    throw new TRPCError({ code: 'FORBIDDEN' });
  return { organizationId, userId: user.id, role: user.role };
}

const ERROR_CODES: Record<PharmacyPinEnrolmentError['code'], TRPCError['code']> = {
  FORBIDDEN: 'FORBIDDEN',
  TARGET_NOT_ELIGIBLE: 'FORBIDDEN',
  CURRENT_PIN_REQUIRED: 'BAD_REQUEST',
  CURRENT_PIN_INVALID: 'FORBIDDEN',
  PROFILE_INACTIVE: 'PRECONDITION_FAILED',
  INVALID_PIN: 'BAD_REQUEST',
};

export const pharmacyOperatorPinRouter = router({
  status: ownerOrManager.query(async ({ ctx }) => {
    const actor = pharmacyActor(ctx);
    const rows = await listPharmacyPinStatus(ctx.db, actor.organizationId);
    // A manager sees only their own row; the owner manages the roster.
    return actor.role === 'ADMIN' ? rows : rows.filter((row) => row.userId === actor.userId);
  }),
  setPin: ownerOrManager
    .input(
      z
        .object({
          targetUserId: z.string().trim().min(1).max(128).optional(),
          pin: pinSchema,
          currentPin: pinSchema.optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      // The plaintext PIN must never reach the audit log, even on failure.
      annotateAudit(ctx, { skipInput: true });
      const actor = pharmacyActor(ctx);
      let outcome: Awaited<ReturnType<typeof enrolPharmacyOperatorPin>>;
      try {
        outcome = await ctx.db.$transaction((db) =>
          enrolPharmacyOperatorPin(db as typeof ctx.db, actor, input)
        );
      } catch (error) {
        if (error instanceof PharmacyPinEnrolmentError)
          throw new TRPCError({ code: ERROR_CODES[error.code], message: error.message });
        throw error;
      }
      // The failed-attempt counter has committed before this refusal is raised.
      if (!outcome.ok)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Current PIN is incorrect or locked.',
        });
      annotateAudit(ctx, {
        skipInput: true,
        targetType: 'RestaurantOperatorCredential',
        targetId: outcome.credentialId,
        description: outcome.reset ? 'Reset pharmacy operator PIN' : 'Set pharmacy operator PIN',
        metadata: { targetUserId: outcome.targetUserId, reset: outcome.reset },
      });
      // Response carries no PIN and no hash.
      return {
        targetUserId: outcome.targetUserId,
        reset: outcome.reset,
      };
    }),
});
