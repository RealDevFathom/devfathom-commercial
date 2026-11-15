import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { assertProcurementBranch } from '../pharmacy-procurement-scope';
import { assertInOrganization } from '../org-refs';
import {
  denyByDefaultProcedure,
  publicProcedure,
  router,
  type ProcedureMeta,
  type TRPCContext,
} from '../trpc';
import {
  SupplierLinkError,
  getSupplierActionPage,
  issueSupplierActionLink,
  recordManualSupplierEvidence,
  submitSupplierEvidence,
  uploadSupplierDocument,
} from '@/lib/pharmacy/supplier-action-links';
import {
  supplierLinkGetInput,
  supplierLinkSubmitInput,
  supplierLinkUploadInput,
} from '@/lib/auth/anonymous-inputs';

const id = z.string().trim().min(1).max(200);
const kind = z.enum([
  'ACKNOWLEDGEMENT',
  'REJECTION',
  'PARTIAL_ACCEPTANCE',
  'ETA',
  'SUBSTITUTION_PROPOSAL',
]);
const genericLinkError = () =>
  new TRPCError({
    code: 'NOT_FOUND',
    message: 'This supplier link is invalid, expired, or revoked.',
  });
/**
 * PR J (#979): issuing, revoking and acting on supplier links is procurement
 * work. Every staff procedure is deny-by-default with `pharmacy:procurement`,
 * and the branch must be an active branch the caller is assigned to (or the
 * caller is a live tenant owner), not merely a branch of the tenant.
 */
const staff = denyByDefaultProcedure;
const PROCUREMENT = { capabilities: ['pharmacy:procurement'] } as const satisfies ProcedureMeta;

async function assertBranch(ctx: TRPCContext, branchId: string) {
  await assertProcurementBranch(ctx, branchId);
}

function mapError(error: unknown): never {
  if (!(error instanceof SupplierLinkError)) throw error;
  if (error.reason === 'INVALID_LINK') throw genericLinkError();
  throw new TRPCError({
    code:
      error.reason === 'LINK_LIMIT_EXCEEDED'
        ? 'TOO_MANY_REQUESTS'
        : error.reason === 'IDEMPOTENCY_CONFLICT'
          ? 'CONFLICT'
          : 'BAD_REQUEST',
    message: error.reason,
  });
}

export const pharmacySupplierLinksRouter = router({
  get: publicProcedure.input(supplierLinkGetInput).query(async ({ ctx, input }) => {
    try {
      return await getSupplierActionPage(ctx.db, input.token);
    } catch (error) {
      mapError(error);
    }
  }),
  submit: publicProcedure.input(supplierLinkSubmitInput).mutation(async ({ ctx, input }) => {
    try {
      return await submitSupplierEvidence(ctx.db, input);
    } catch (error) {
      mapError(error);
    }
  }),
  uploadDocument: publicProcedure
    .input(supplierLinkUploadInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await uploadSupplierDocument(ctx.db, {
          ...input,
          content: Buffer.from(input.contentBase64, 'base64'),
        });
      } catch (error) {
        mapError(error);
      }
    }),
  createRelationship: staff
    .meta(PROCUREMENT)
    .input(z.object({ branchId: id, supplierId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      await assertBranch(ctx, input.branchId);
      await assertInOrganization(ctx.db.pharmacySupplier, ctx.entitlements.organizationId, [
        input.supplierId,
      ]);
      return ctx.db.pharmacySupplierRelationship.create({
        data: { ...input, organizationId: ctx.entitlements.organizationId },
      });
    }),
  issue: staff
    .meta(PROCUREMENT)
    .input(
      z
        .object({ branchId: id, relationshipId: id, purchaseOrderId: id, expiresAt: z.date() })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      if (input.expiresAt <= new Date())
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Expiry must be in the future.' });
      await assertBranch(ctx, input.branchId);
      try {
        return await issueSupplierActionLink(ctx.db, {
          ...input,
          organizationId: ctx.entitlements.organizationId,
          actorUserId: ctx.session.user.id,
        });
      } catch (error) {
        mapError(error);
      }
    }),
  revoke: staff
    .meta(PROCUREMENT)
    .input(z.object({ linkId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      // The link's own branch is the boundary: a caller may revoke only links
      // issued at a branch they are assigned to.
      const link = await ctx.db.pharmacySupplierActionLink.findFirst({
        where: { id: input.linkId, organizationId: ctx.entitlements.organizationId },
        select: { id: true, branchId: true },
      });
      if (!link) throw genericLinkError();
      await assertBranch(ctx, link.branchId);
      return ctx.db.pharmacySupplierActionLink.update({
        where: {
          id: link.id,
          organizationId: ctx.entitlements.organizationId,
          branchId: link.branchId,
        },
        data: { revokedAt: new Date() },
        // DEV-848: never return `tokenHash`; it verifies the supplier's bearer link.
        select: {
          id: true,
          branchId: true,
          supplierRelationshipId: true,
          purchaseOrderId: true,
          expiresAt: true,
          revokedAt: true,
          createdByUserId: true,
          createdAt: true,
        },
      });
    }),
  recordManual: staff
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          actionLinkId: id,
          branchId: id,
          kind,
          source: z.enum(['PHONE', 'WHATSAPP']),
          sourceEvidence: z.string().trim().min(1).max(2000),
          idempotencyKey: id,
          payload: z.record(z.string(), z.unknown()),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await assertBranch(ctx, input.branchId);
      try {
        return await recordManualSupplierEvidence(ctx.db, input);
      } catch (error) {
        mapError(error);
      }
    }),
  approveProposal: staff
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          submissionId: id,
          branchId: id,
          approved: z.boolean(),
          reason: z.string().trim().max(1000).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await assertBranch(ctx, input.branchId);
      const submission = await ctx.db.pharmacySupplierSubmission.findFirst({
        where: {
          id: input.submissionId,
          branchId: input.branchId,
          organizationId: ctx.entitlements.organizationId,
        },
      });
      if (!submission) throw new TRPCError({ code: 'NOT_FOUND' });
      return ctx.db.pharmacySupplierSubmissionApproval.create({
        data: {
          organizationId: ctx.entitlements.organizationId,
          branchId: input.branchId,
          submissionId: input.submissionId,
          actorUserId: ctx.session.user.id,
          approved: input.approved,
          reason: input.reason,
        },
      });
    }),
});
