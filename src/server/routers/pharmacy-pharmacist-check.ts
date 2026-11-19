import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { NO_PIN_SET_MESSAGE } from '@/lib/pharmacy/own-pin-policy';
import {
  PHARMACIST_CHECK_DISCLAIMER,
  type PharmacistCheckPolicyView,
} from '@/lib/pharmacy/pharmacist-check';
import {
  isPharmacistCheckPolicyOwner,
  PharmacistCheckPolicyError,
  readPharmacistCheckPolicy,
  readPharmacistCheckPolicyHistory,
  writePharmacistCheckPolicy,
  type PharmacistCheckPolicyState,
} from '@/lib/pharmacy/pharmacist-check-policy';
import {
  OWNER_EXPORT_PIN_MAX_INPUT,
  verifyOwnerExportPin,
} from '@/lib/pharmacy/owner-data-export-pin';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '@/server/audit';
import {
  auditedProtectedProcedure,
  protectedProcedure,
  router,
  type TRPCContext,
} from '@/server/trpc';

/**
 * DEV-911 — the owner setting "Pharmacist check and prescription record at each sale".
 *
 * Reading it is open to every member of the pharmacy, because the counter shows its effect.
 * Changing it is the tenant owner's alone (system `owner` role, verified from the live
 * database): a manager, pharmacist, cashier or an ADMIN without the owner role is refused,
 * and so is a support or impersonation session. Every change needs the owner's fresh PIN,
 * and turning the check off needs the disclaimer accepted; the accepted text is kept in the
 * append-only policy audit with who and when.
 */

function actor(ctx: TRPCContext): { organizationId: string; actorId: string } {
  const organizationId = ctx.entitlements?.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!organizationId || !actorId || ctx.session?.user?.organizationId !== organizationId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No tenant actor on this request.' });
  }
  return { organizationId, actorId };
}

function supportSession(ctx: TRPCContext): boolean {
  return Boolean(ctx.support || ctx.session?.user?.isSupportSession);
}

const OWNER_ONLY = 'Only the pharmacy owner can change the pharmacist check at each sale.';

function policyError(error: unknown): never {
  if (error instanceof PharmacistCheckPolicyError) {
    switch (error.reason) {
      case 'NOT_OWNER':
      case 'SUPPORT_SESSION':
        throw new TRPCError({ code: 'FORBIDDEN', message: OWNER_ONLY });
      case 'PIN_REQUIRED':
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter your own PIN to confirm.' });
      case 'NO_PIN':
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: NO_PIN_SET_MESSAGE });
      case 'PIN_REJECTED':
        throw new TRPCError({ code: 'FORBIDDEN', message: 'That PIN is not correct.' });
      case 'PIN_LOCKED':
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Your PIN is locked after too many wrong tries. Wait and try again.',
        });
      case 'DISCLAIMER_REQUIRED':
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Tick the disclaimer before turning the pharmacist check off.',
        });
      case 'STALE_DISCLAIMER':
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The disclaimer has changed. Reload, read it again and tick it.',
        });
      case 'VERSION_CONFLICT':
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This setting was changed elsewhere. Reload before saving.',
        });
    }
  }
  throw error;
}

async function view(
  db: ScopedDb,
  organizationId: string,
  policy: PharmacistCheckPolicyState
): Promise<PharmacistCheckPolicyView> {
  const last =
    policy.source === 'STORED'
      ? ((await readPharmacistCheckPolicyHistory(db, organizationId, 1))[0] ?? null)
      : null;
  const user = last?.actorUserId
    ? await db.user.findFirst({
        where: { organizationId, id: last.actorUserId },
        select: { name: true },
      })
    : null;
  return {
    enabled: policy.enabled,
    version: policy.version,
    source: policy.source,
    updatedAt: last?.changedAt ?? null,
    updatedByName: user?.name ?? null,
  };
}

export const pharmacyPharmacistCheckRouter = router({
  /** The setting in force, and whether this caller may change it. */
  policy: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const { organizationId, actorId } = actor(ctx);
    const policy = await readPharmacistCheckPolicy(ctx.db, organizationId);
    const owner =
      !supportSession(ctx) && (await isPharmacistCheckPolicyOwner(ctx.db, organizationId, actorId));
    return {
      policy: await view(ctx.db, organizationId, policy),
      canManage: owner,
      disclaimerVersion: PHARMACIST_CHECK_DISCLAIMER.version,
    };
  }),

  /** Every change: who, when, from what to what, and the disclaimer text that was accepted. */
  history: auditedProtectedProcedure
    .input(z.strictObject({ limit: z.number().int().min(1).max(200).default(20) }).optional())
    .query(async ({ ctx, input }) => {
      const { organizationId, actorId } = actor(ctx);
      if (
        supportSession(ctx) ||
        !(await isPharmacistCheckPolicyOwner(ctx.db, organizationId, actorId))
      )
        throw new TRPCError({ code: 'FORBIDDEN', message: OWNER_ONLY });
      const changes = await readPharmacistCheckPolicyHistory(
        ctx.db,
        organizationId,
        input?.limit ?? 20
      );
      const ids = [...new Set(changes.map((change) => change.actorUserId).filter(Boolean))];
      const users = ids.length
        ? await ctx.db.user.findMany({
            where: { organizationId, id: { in: ids as string[] } },
            select: { id: true, name: true },
          })
        : [];
      const byId = new Map(users.map((user) => [user.id, user.name]));
      return changes.map((change) => ({
        ...change,
        actorName: change.actorUserId ? (byId.get(change.actorUserId) ?? null) : null,
      }));
    }),

  /**
   * The owner's switch. Needs the owner's fresh PIN every time; turning the check off also
   * needs the current disclaimer ticked. Asking for the state already in force changes
   * nothing. Turning it back on applies to the very next line, payment and completion.
   */
  setPolicy: protectedProcedure
    .input(
      z.strictObject({
        enabled: z.boolean(),
        expectedVersion: z.number().int().min(0).max(2_147_483_647),
        pin: z.string().max(OWNER_EXPORT_PIN_MAX_INPUT),
        disclaimer: z
          .strictObject({
            accepted: z.boolean(),
            version: z.string().trim().min(1).max(100),
          })
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const scope = actor(ctx);
      // The PIN never reaches the audit row.
      annotateAudit(ctx, {
        skipInput: true,
        targetType: 'PharmacyPharmacistCheckPolicy',
        targetId: scope.organizationId,
      });
      try {
        if (supportSession(ctx)) throw new PharmacistCheckPolicyError('SUPPORT_SESSION');
        if (!(await isPharmacistCheckPolicyOwner(ctx.db, scope.organizationId, scope.actorId)))
          throw new PharmacistCheckPolicyError('NOT_OWNER');
        if (!input.pin) throw new PharmacistCheckPolicyError('PIN_REQUIRED');
        // Its own tenant transaction, so a wrong-PIN strike commits even though we refuse.
        const pin = await verifyOwnerExportPin({
          organizationId: scope.organizationId,
          userId: scope.actorId,
          pin: input.pin,
          action: 'pharmacy.pharmacistCheckPolicy',
        });
        if (pin === 'NO_PIN') throw new PharmacistCheckPolicyError('NO_PIN');
        if (pin === 'LOCKED') throw new PharmacistCheckPolicyError('PIN_LOCKED');
        if (pin !== 'OK') throw new PharmacistCheckPolicyError('PIN_REJECTED');
        const result = await ctx.db.$transaction(async (tx) => {
          const db = tx as unknown as ScopedDb;
          // Re-verified inside the write transaction, against the live database.
          if (
            !(await isPharmacistCheckPolicyOwner(db, scope.organizationId, scope.actorId, {
              lock: true,
            }))
          )
            throw new PharmacistCheckPolicyError('NOT_OWNER');
          return writePharmacistCheckPolicy(db, scope, {
            enabled: input.enabled,
            expectedVersion: input.expectedVersion,
            disclaimer: input.disclaimer,
          });
        });
        if (result.changed) {
          annotateAudit(ctx, {
            operation: 'UPDATE',
            description: result.policy.enabled
              ? 'Turned the pharmacist check and prescription record at each sale on'
              : 'Turned the pharmacist check and prescription record at each sale off',
            changes: {
              pharmacistCheckEnabled: {
                before: result.previous.enabled,
                after: result.policy.enabled,
              },
              version: { before: result.previous.version, after: result.policy.version },
            },
            metadata: {
              pinVerified: true,
              acceptedDisclaimer: result.acceptedDisclaimer,
            },
          });
        }
        return {
          changed: result.changed,
          policy: await view(ctx.db, scope.organizationId, result.policy),
        };
      } catch (error) {
        policyError(error);
      }
    }),
});
