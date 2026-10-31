import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { assertInOrganization } from '../org-refs';
import { publicProcedure, protectedProcedure, router, type TRPCContext } from '../trpc';
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
async function assertBranch(ctx: TRPCContext, branchId: string) {
  const organizationId = ctx.entitlements.organizationId;
  if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  await assertInOrganization(ctx.db.pharmacyBranch, organizationId, [branchId], { active: true });
}

function mapError(error: unknown): never {
  if (!(error instanceof SupplierLinkError)) throw error;
  if (error.reason === 'INVALID_LINK') throw genericLinkError();
  throw new TRPCError({
    code: error.reason === 'IDEMPOTENCY_CONFLICT' ? 'CONFLICT' : 'BAD_REQUEST',
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
  createRelationship: protectedProcedure
    .input(z.object({ branchId: id, supplierId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      await assertBranch(ctx, input.branchId);
      return ctx.db.pharmacySupplierRelationship.create({
        data: { ...input, organizationId: ctx.entitlements.organizationId },
      });
    }),
  issue: protectedProcedure
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
  revoke: protectedProcedure.input(z.object({ linkId: id }).strict()).mutation(({ ctx, input }) =>
    ctx.db.pharmacySupplierActionLink.update({
      where: { id: input.linkId },
      data: { revokedAt: new Date() },
    })
  ),
  recordManual: protectedProcedure
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
  approveProposal: protectedProcedure
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
        where: { id: input.submissionId, branchId: input.branchId },
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
