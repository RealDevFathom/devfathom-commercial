import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { assertInOrganization } from '../org-refs';
import { publicProcedure, protectedProcedure, router, type TRPCContext } from '../trpc';
import {
  SupplierLinkError,
  compensateSupplierDocumentUpload,
  getSupplierActionPage,
  getSupplierLinkAuditTarget,
  issueSupplierActionLink,
  recordManualSupplierEvidence,
  submitSupplierEvidence,
  uploadSupplierDocument,
} from '@/lib/pharmacy/supplier-action-links';
import { recordAudit } from '@/server/audit';

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

type SupplierAuditTarget = { id: string; organizationId: string; branchId: string };

async function auditSupplierLinkAction(
  ctx: TRPCContext,
  db: TRPCContext['db'],
  target: SupplierAuditTarget | null,
  action: 'submit' | 'uploadDocument',
  outcome: 'SUCCESS' | 'FAILURE',
  kind: string,
  error?: unknown
) {
  if (!target) return;
  const reason =
    error instanceof SupplierLinkError
      ? error.reason
      : error instanceof TRPCError
        ? error.code
        : error
          ? 'INTERNAL_ERROR'
          : null;
  await recordAudit(
    {
      organizationId: target.organizationId,
      actorType: 'ANONYMOUS',
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'CREATE',
      action: `pharmacySupplierLinks.${action}`,
      targetType: 'PharmacySupplierActionLink',
      targetId: target.id,
      metadata: { branchId: target.branchId, linkId: target.id, kind },
      ip: ctx.requestMeta?.ip ?? null,
      userAgent: ctx.requestMeta?.userAgent ?? null,
      outcome,
      errorCode: reason,
      errorMessage: reason,
    },
    db
  );
}

function auditedSupplierLinkProcedure(action: 'submit' | 'uploadDocument') {
  return publicProcedure.use(async ({ ctx, getRawInput, next }) => {
    const rawInput = await getRawInput();
    const result = await next();

    // Input parsers run before the resolver, so audit attributable validation
    // failures here. Resolver and service failures are recorded in the mutation
    // itself, where the parsed kind and domain error are available.
    if (!result.ok && result.error.cause instanceof z.ZodError) {
      const raw =
        rawInput && typeof rawInput === 'object'
          ? (rawInput as Record<string, unknown>)
          : undefined;
      const token = typeof raw?.token === 'string' ? raw.token : null;
      if (token) {
        const target = await getSupplierLinkAuditTarget(
          ctx.db,
          token,
          ctx.entitlements.organizationId
        );
        const rawKind = typeof raw?.kind === 'string' ? raw.kind : null;
        await auditSupplierLinkAction(
          ctx,
          ctx.db,
          target,
          action,
          'FAILURE',
          action === 'uploadDocument' ? 'DOCUMENT' : (rawKind ?? 'UNKNOWN'),
          result.error
        );
      }
    }

    return result;
  });
}

export const pharmacySupplierLinksRouter = router({
  get: publicProcedure.input(z.object({ token: id }).strict()).query(async ({ ctx, input }) => {
    try {
      return await getSupplierActionPage(ctx.db, input.token);
    } catch (error) {
      mapError(error);
    }
  }),
  submit: auditedSupplierLinkProcedure('submit')
    .input(
      z
        .object({
          token: id,
          kind,
          idempotencyKey: id,
          payload: z.record(z.string(), z.unknown()),
          supersedesId: id.optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const target = await getSupplierLinkAuditTarget(
        ctx.db,
        input.token,
        ctx.entitlements.organizationId
      );
      let result;
      try {
        result = await ctx.db.$transaction(async (tx) => {
          const submission = await submitSupplierEvidence(tx, input);
          await auditSupplierLinkAction(ctx, tx, target, 'submit', 'SUCCESS', input.kind);
          return submission;
        });
      } catch (error) {
        await auditSupplierLinkAction(ctx, ctx.db, target, 'submit', 'FAILURE', input.kind, error);
        mapError(error);
      }
      return result;
    }),
  uploadDocument: auditedSupplierLinkProcedure('uploadDocument')
    .input(
      z
        .object({
          token: id,
          idempotencyKey: id,
          fileName: z.string().trim().min(1).max(255),
          declaredMimeType: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
          contentBase64: z.string().min(1).max(14_000_000),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const target = await getSupplierLinkAuditTarget(
        ctx.db,
        input.token,
        ctx.entitlements.organizationId
      );
      let upload: Awaited<ReturnType<typeof uploadSupplierDocument>> | undefined;
      try {
        upload = await ctx.db.$transaction(async (tx) => {
          const stored = await uploadSupplierDocument(tx, {
            ...input,
            content: Buffer.from(input.contentBase64, 'base64'),
          });
          // Retain the storage receipt before the audit insert so the catch
          // path can compensate when that insert aborts the DB transaction.
          upload = stored;
          await auditSupplierLinkAction(
            ctx,
            tx,
            target,
            'uploadDocument',
            'SUCCESS',
            'DOCUMENT'
          );
          return stored;
        });
      } catch (error) {
        if (upload && target) await compensateSupplierDocumentUpload(target.organizationId, upload);
        await auditSupplierLinkAction(
          ctx,
          ctx.db,
          target,
          'uploadDocument',
          'FAILURE',
          'DOCUMENT',
          error
        );
        mapError(error);
      }
      return upload.document;
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
