import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { actorCanProcure } from '@/lib/pharmacy/procurement-access';
import {
  SUPPLIER_COMPLIANCE_WARNING,
  type SupplierCompliancePolicyView,
} from '@/lib/pharmacy/supplier-compliance';
import {
  actorIsVerifiedTenantOwner,
  readSupplierCompliancePolicy,
  readSupplierCompliancePolicyHistory,
  readSupplierCompliancePolicyLastChange,
  readSupplierComplianceSkips,
  SupplierCompliancePolicyError,
  writeSupplierCompliancePolicy,
  type SupplierCompliancePolicyState,
} from '@/lib/pharmacy/supplier-compliance-policy';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '@/server/audit';
import {
  auditedProtectedProcedure,
  protectedProcedure,
  router,
  type TRPCContext,
} from '@/server/trpc';

/**
 * DEV-753 — the owner switch for supplier compliance checks.
 *
 * Reading the policy is open to the people who work the purchasing lane (they must
 * see when supplier checks are off). Changing it is for the verified tenant owner
 * only: the live database must show the system `owner` role, so a tenant ADMIN, a
 * custom wildcard role, a procurement grant or a support session cannot change it.
 * Nothing here grants or widens anyone's permissions; supplier trade authorization
 * is a fact about a supplier, not user access.
 */

const id = z.string().trim().min(1).max(128);

function actor(ctx: TRPCContext): { organizationId: string; actorId: string } {
  const organizationId = ctx.entitlements?.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!organizationId || !actorId || ctx.session?.user?.organizationId !== organizationId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No tenant actor on this request.' });
  }
  return { organizationId, actorId };
}

async function isOwner(
  ctx: TRPCContext,
  db: ScopedDb = ctx.db,
  options: { lock?: boolean } = {}
): Promise<boolean> {
  const { organizationId, actorId } = actor(ctx);
  return actorIsVerifiedTenantOwner(db, organizationId, actorId, options);
}

/** Owner, or someone who already works the purchasing lane. Nothing wider. */
async function assertCanReadEvidence(ctx: TRPCContext): Promise<{ owner: boolean }> {
  const { actorId } = actor(ctx);
  if (await isOwner(ctx)) return { owner: true };
  if (await actorCanProcure(ctx.db, actorId)) return { owner: false };
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'You do not have permission for this action.',
  });
}

const OWNER_ONLY = 'Only the pharmacy owner can change supplier compliance checks.';

function policyError(error: unknown): never {
  if (error instanceof SupplierCompliancePolicyError) {
    switch (error.reason) {
      case 'NOT_OWNER':
      case 'SUPPORT_SESSION':
        throw new TRPCError({ code: 'FORBIDDEN', message: OWNER_ONLY });
      case 'ACKNOWLEDGEMENT_REQUIRED':
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Confirm the warning before turning supplier checks off.',
        });
      case 'STALE_WARNING':
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The warning has changed. Reload, read it again and confirm.',
        });
      case 'VERSION_CONFLICT':
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Supplier compliance checks were changed elsewhere. Reload before saving.',
        });
    }
  }
  throw error;
}

async function names(db: ScopedDb, organizationId: string, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.filter((value): value is string => Boolean(value)))];
  if (wanted.length === 0) return new Map<string, string>();
  const users = await db.user.findMany({
    where: { organizationId, id: { in: wanted } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user.name]));
}

async function view(
  db: ScopedDb,
  organizationId: string,
  policy: SupplierCompliancePolicyState
): Promise<SupplierCompliancePolicyView> {
  // The supplier setting's own last change; the row's timestamps are shared with Rx.
  const last =
    policy.source === 'STORED'
      ? await readSupplierCompliancePolicyLastChange(db, organizationId)
      : null;
  const byId = await names(db, organizationId, [last?.actorUserId ?? null]);
  return {
    checksEnabled: policy.checksEnabled,
    version: policy.version,
    source: policy.source,
    updatedAt: last?.changedAt ?? null,
    updatedByName: last?.actorUserId ? (byId.get(last.actorUserId) ?? null) : null,
  };
}

export const pharmacySupplierComplianceRouter = router({
  /**
   * The policy in force, and whether this caller may change it. Readable by anyone who
   * can read the supplier register (same module gate), because the register shows its
   * effect; the change history and the skip evidence stay narrower.
   */
  policy: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const owner = await isOwner(ctx);
    const { organizationId } = actor(ctx);
    const policy = await readSupplierCompliancePolicy(ctx.db, organizationId);
    return {
      policy: await view(ctx.db, organizationId, policy),
      canManage: owner && !ctx.support && !ctx.session?.user?.isSupportSession,
      warningVersion: SUPPLIER_COMPLIANCE_WARNING.version,
    };
  }),

  /** Every change of the supplier policy: who, when, from what to what, and what they agreed to. */
  history: auditedProtectedProcedure
    .input(z.strictObject({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      if (!(await isOwner(ctx))) throw new TRPCError({ code: 'FORBIDDEN', message: OWNER_ONLY });
      const { organizationId } = actor(ctx);
      const changes = await readSupplierCompliancePolicyHistory(
        ctx.db,
        organizationId,
        input?.limit ?? 50
      );
      const byId = await names(
        ctx.db,
        organizationId,
        changes.map((change) => change.actorUserId)
      );
      return changes.map((change) => ({
        ...change,
        actorName: change.actorUserId ? (byId.get(change.actorUserId) ?? null) : null,
      }));
    }),

  /**
   * Writes that passed the supplier gate without a check while the owner had the checks
   * off, for one supplier, order or receipt. Read-only evidence; nothing here changes it.
   */
  skips: auditedProtectedProcedure
    .input(
      z
        .strictObject({
          supplierId: id.optional(),
          purchaseOrderId: id.optional(),
          goodsReceiptId: id.optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .refine((value) => value.supplierId || value.purchaseOrderId || value.goodsReceiptId, {
          message: 'Name a supplier, purchase order or goods receipt.',
        })
    )
    .query(async ({ ctx, input }) => {
      await assertCanReadEvidence(ctx);
      const { organizationId } = actor(ctx);
      const skips = await readSupplierComplianceSkips(
        ctx.db,
        organizationId,
        {
          supplierId: input.supplierId,
          purchaseOrderId: input.purchaseOrderId,
          goodsReceiptId: input.goodsReceiptId,
        },
        input.limit
      );
      const byId = await names(
        ctx.db,
        organizationId,
        skips.map((skip) => skip.actorUserId)
      );
      return skips.map((skip) => ({ ...skip, actorName: byId.get(skip.actorUserId) ?? null }));
    }),

  /**
   * The owner's switch. Saving the state already in force is a no-op (safe to repeat).
   * Turning the checks off needs the current warning acknowledged; turning them back on
   * applies to every later write and never rewrites earlier evidence.
   */
  setPolicy: protectedProcedure
    .input(
      z.strictObject({
        checksEnabled: z.boolean(),
        expectedVersion: z.number().int().min(0).max(2_147_483_647),
        acknowledgement: z
          .strictObject({
            accepted: z.boolean(),
            warningVersion: z.string().trim().min(1).max(100),
          })
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const scope = actor(ctx);
      try {
        if (ctx.support || ctx.session?.user?.isSupportSession) {
          throw new SupplierCompliancePolicyError('SUPPORT_SESSION');
        }
        const result = await ctx.db.$transaction(async (tx) => {
          const db = tx as unknown as ScopedDb;
          // Re-verified inside the write transaction, against the live database.
          if (!(await isOwner(ctx, db, { lock: true }))) {
            throw new SupplierCompliancePolicyError('NOT_OWNER');
          }
          return writeSupplierCompliancePolicy(db, scope, input);
        });
        if (result.changed) {
          annotateAudit(ctx, {
            targetType: 'PharmacySupplierCompliancePolicy',
            targetId: scope.organizationId,
            operation: 'UPDATE',
            description: result.policy.checksEnabled
              ? 'Turned supplier licence and authorization checks on'
              : 'Turned supplier licence and authorization checks off',
            changes: {
              checksEnabled: {
                before: result.previous.checksEnabled,
                after: result.policy.checksEnabled,
              },
              version: { before: result.previous.version, after: result.policy.version },
            },
            metadata: {
              warningVersion: result.policy.checksEnabled
                ? null
                : SUPPLIER_COMPLIANCE_WARNING.version,
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
