import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { NO_PIN_SET_MESSAGE } from '@/lib/pharmacy/own-pin-policy';
import { isPharmacistCheckPolicyOwner } from '@/lib/pharmacy/pharmacist-check-policy';
import {
  OWNER_EXPORT_PIN_MAX_INPUT,
  verifyOwnerExportPin,
} from '@/lib/pharmacy/owner-data-export-pin';
import { readDeclaredSoloSignOffs } from '@/lib/pharmacy/rx-review-self-sign';
import { RX_SOLO_SHIFT_DISCLAIMER, type RxSoloShiftBranchView } from '@/lib/pharmacy/rx-solo-shift';
import {
  readRxSoloShiftPolicies,
  readRxSoloShiftPolicy,
  readRxSoloShiftPolicyHistory,
  RxSoloShiftPolicyError,
  writeRxSoloShiftPolicy,
} from '@/lib/pharmacy/rx-solo-shift-policy';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '@/server/audit';
import {
  auditedProtectedProcedure,
  protectedProcedure,
  router,
  type TRPCContext,
} from '@/server/trpc';

/**
 * DEV-960 — the owner setting "One pharmacist per shift", per branch, and the owner's list of
 * declared solo sign-offs.
 *
 * Everything here is the tenant owner's alone (system `owner` role, verified from the live
 * database, the DEV-911 rule): a manager, pharmacist, cashier or an ADMIN without the owner role
 * is refused, and so is a support or impersonation session. Every change needs the owner's fresh
 * PIN, and turning the setting on needs the current statement accepted; the accepted text and
 * version are stored with the change, which the database keeps append-only.
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

const OWNER_ONLY = 'Only the pharmacy owner can see and change “One pharmacist per shift”.';

async function ownerOnly(ctx: TRPCContext, scope: { organizationId: string; actorId: string }) {
  if (
    supportSession(ctx) ||
    !(await isPharmacistCheckPolicyOwner(
      ctx.db as unknown as ScopedDb,
      scope.organizationId,
      scope.actorId
    ))
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: OWNER_ONLY });
}

function policyError(error: unknown): never {
  if (error instanceof RxSoloShiftPolicyError) {
    switch (error.reason) {
      case 'NOT_OWNER':
      case 'SUPPORT_SESSION':
        throw new TRPCError({ code: 'FORBIDDEN', message: OWNER_ONLY });
      case 'BRANCH_NOT_FOUND':
        throw new TRPCError({ code: 'NOT_FOUND', message: 'This branch was not found.' });
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
          message: 'Tick the statement before turning “One pharmacist per shift” on.',
        });
      case 'STALE_DISCLAIMER':
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The statement has changed. Reload, read it again and tick it.',
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

async function names(db: ScopedDb, organizationId: string, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const users = wanted.length
    ? await db.user.findMany({
        where: { organizationId, id: { in: wanted } },
        select: { id: true, name: true },
      })
    : [];
  return new Map(users.map((user) => [user.id, user.name]));
}

const limitInput = z
  .strictObject({
    branchId: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .optional();

export const pharmacyRxSoloShiftRouter = router({
  /** Every active branch's setting, for the owner; anyone else is told only that they may not. */
  overview: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const scope = actor(ctx);
    const db = ctx.db as unknown as ScopedDb;
    const owner =
      !supportSession(ctx) &&
      (await isPharmacistCheckPolicyOwner(db, scope.organizationId, scope.actorId));
    if (!owner)
      return {
        canManage: false,
        branches: [] as RxSoloShiftBranchView[],
        disclaimerVersion: RX_SOLO_SHIFT_DISCLAIMER.version,
      };
    const [branches, policies] = await Promise.all([
      db.pharmacyBranch.findMany({
        where: { organizationId: scope.organizationId, active: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, code: true },
      }),
      readRxSoloShiftPolicies(db, scope.organizationId),
    ]);
    const byId = await names(
      db,
      scope.organizationId,
      [...policies.values()].map((policy) => policy.actorUserId)
    );
    return {
      canManage: true,
      disclaimerVersion: RX_SOLO_SHIFT_DISCLAIMER.version,
      branches: branches.map((branch): RxSoloShiftBranchView => {
        const policy = policies.get(branch.id);
        return {
          branchId: branch.id,
          branchName: branch.name,
          branchCode: branch.code,
          enabled: policy?.enabled ?? false,
          version: policy?.version ?? 0,
          source: policy?.source ?? 'DEFAULT',
          updatedAt: policy?.changedAt ?? null,
          updatedByName: policy ? (byId.get(policy.actorUserId) ?? null) : null,
        };
      }),
    };
  }),

  /** Every change: who, when, which branch, from what to what, and the statement accepted. */
  history: auditedProtectedProcedure.input(limitInput).query(async ({ ctx, input }) => {
    const scope = actor(ctx);
    await ownerOnly(ctx, scope);
    const db = ctx.db as unknown as ScopedDb;
    const changes = await readRxSoloShiftPolicyHistory(db, scope.organizationId, {
      branchId: input?.branchId,
      limit: input?.limit ?? 50,
    });
    const byId = await names(
      db,
      scope.organizationId,
      changes.map((change) => change.actorUserId)
    );
    return changes.map((change) => ({
      ...change,
      actorName: byId.get(change.actorUserId) ?? null,
    }));
  }),

  /**
   * Every declared solo sign-off, newest first: who signed, when, at which branch, which sale and
   * line, and the other pharmacists on the staff list at that moment.
   */
  declaredSignOffs: auditedProtectedProcedure.input(limitInput).query(async ({ ctx, input }) => {
    const scope = actor(ctx);
    await ownerOnly(ctx, scope);
    return readDeclaredSoloSignOffs(ctx.db as unknown as ScopedDb, scope.organizationId, {
      branchId: input?.branchId,
      limit: input?.limit ?? 50,
    });
  }),

  /**
   * The owner's switch for one branch. Needs the owner's fresh PIN every time; turning it on also
   * needs the current statement ticked. Asking for the state already in force changes nothing.
   * Turning it off applies to the very next signature.
   */
  setPolicy: protectedProcedure
    .input(
      z.strictObject({
        branchId: z.string().min(1).max(128),
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
        targetType: 'PharmacyRxSoloShiftPolicy',
        targetId: input.branchId,
      });
      try {
        if (supportSession(ctx)) throw new RxSoloShiftPolicyError('SUPPORT_SESSION');
        const db = ctx.db as unknown as ScopedDb;
        if (!(await isPharmacistCheckPolicyOwner(db, scope.organizationId, scope.actorId)))
          throw new RxSoloShiftPolicyError('NOT_OWNER');
        const branch = await db.pharmacyBranch.findFirst({
          where: { id: input.branchId, organizationId: scope.organizationId },
          select: { id: true },
        });
        if (!branch) throw new RxSoloShiftPolicyError('BRANCH_NOT_FOUND');
        // Nothing to change: no PIN asked, no strike spent, nothing recorded.
        const current = await readRxSoloShiftPolicy(db, scope.organizationId, input.branchId);
        if (current.source !== 'FAIL_CLOSED' && current.enabled === input.enabled)
          return { changed: false, enabled: current.enabled, version: current.version };
        if (!input.pin) throw new RxSoloShiftPolicyError('PIN_REQUIRED');
        // Its own tenant transaction, so a wrong-PIN strike commits even though we refuse.
        const pin = await verifyOwnerExportPin({
          organizationId: scope.organizationId,
          userId: scope.actorId,
          pin: input.pin,
          action: 'pharmacy.rxSoloShiftPolicy',
        });
        if (pin === 'NO_PIN') throw new RxSoloShiftPolicyError('NO_PIN');
        if (pin === 'LOCKED') throw new RxSoloShiftPolicyError('PIN_LOCKED');
        if (pin !== 'OK') throw new RxSoloShiftPolicyError('PIN_REJECTED');
        const result = await ctx.db.$transaction(async (tx) => {
          const writer = tx as unknown as ScopedDb;
          // Re-verified inside the write transaction, against the live database.
          if (
            !(await isPharmacistCheckPolicyOwner(writer, scope.organizationId, scope.actorId, {
              lock: true,
            }))
          )
            throw new RxSoloShiftPolicyError('NOT_OWNER');
          return writeRxSoloShiftPolicy(writer, scope, {
            branchId: input.branchId,
            enabled: input.enabled,
            expectedVersion: input.expectedVersion,
            disclaimer: input.disclaimer,
          });
        });
        if (result.changed) {
          annotateAudit(ctx, {
            operation: 'UPDATE',
            description: result.policy.enabled
              ? 'Turned “One pharmacist per shift” on at a branch'
              : 'Turned “One pharmacist per shift” off at a branch',
            changes: {
              rxSoloShiftEnabled: {
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
          enabled: result.policy.enabled,
          version: result.policy.version,
        };
      } catch (error) {
        policyError(error);
      }
    }),
});
