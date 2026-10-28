import { authorizeSoloOwnerApproval } from '@/lib/pharmacy/solo-owner-approval';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { requirePharmacyReadBranch } from '../pharmacy-branch-access';
import { z } from 'zod';
import { capabilityProcedure, publicProcedure, router, type TRPCContext } from '../trpc';
import { TRPCError } from '@trpc/server';

const dispense = capabilityProcedure('pharmacy:dispense');

async function reviewScope(ctx: TRPCContext) {
  const { branches } = await requirePharmacyReadBranch(ctx);
  const lines = await ctx.db.pharmacySaleLine.findMany({
    where: {
      organizationId: ctx.entitlements!.organizationId,
      branchId: { in: branches.map((branch) => branch.id) },
    },
    select: { id: true },
  });
  return {
    organizationId: ctx.entitlements!.organizationId,
    saleLineId: { in: lines.map((line) => line.id) },
  };
}

export const pharmacyDispensingRouter = router({
  // Separate, repeatable OTC-capable work queue. These holdings remain quarantined;
  // a verification task never grants permission to credit AVAILABLE inventory.
  returnVerificationQueue: dispense
    .input(z.object({ branchId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements?.organizationId;
      if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
      const branch = await ctx.db.pharmacyBranch.findFirst({
        where: { id: input.branchId, organizationId },
      });
      if (!branch) throw new TRPCError({ code: 'NOT_FOUND' });
      return ctx.db.pharmacyReturnVerificationTask.findMany({
        where: { organizationId, branchId: input.branchId },
        orderBy: { requestedAt: 'asc' },
        include: {
          holding: {
            include: {
              location: { select: { name: true } },
              saleLine: { select: { medicine: { select: { productName: true } }, saleId: true } },
            },
          },
        },
      });
    }),
  reviewQueue: dispense.query(async ({ ctx }) => {
    const where = await reviewScope(ctx);
    const soloItems = await ctx.db.$queryRaw<
      { id: string }[]
    >`SELECT i.id FROM pharmacy_pharmacist_review_items i JOIN pharmacy_sale_lines l ON l.id=i."saleLineId" AND l."organizationId"=i."organizationId" WHERE i."organizationId"=${ctx.entitlements.organizationId} AND pharmacy_is_solo_owner(i."organizationId", ${ctx.session.user.id}, l."branchId")`;
    const soloIds = new Set(soloItems.map((item) => item.id));
    const items = await ctx.db.pharmacyPharmacistReviewItem.findMany({
      where,
      orderBy: { requestedAt: 'asc' },
      include: {
        line: {
          include: {
            medicine: true,
            presentation: true,
            prescription: { include: { patient: true, prescriber: true } },
          },
        },
        decisions: { orderBy: { createdAt: 'asc' } },
      },
    });
    return {
      soloOwnerReviewItemIds: items.filter((item) => soloIds.has(item.id)).map((item) => item.id),
      soloOwner:
        (
          await ctx.db.$queryRaw<
            { allowed: boolean }[]
          >`SELECT pharmacy_is_solo_owner(${ctx.entitlements.organizationId}, ${ctx.session.user.id}) AS allowed`
        )[0]?.allowed ?? false,
      currentUserId: ctx.session!.user.id,
      items,
    };
  }),
  substitutionWorkspace: dispense.query(async ({ ctx }) => {
    const where = await reviewScope(ctx);
    return {
      lines: await ctx.db.pharmacyPharmacistReviewItem.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        include: {
          line: {
            include: {
              medicine: { include: { presentations: { orderBy: { presentation: 'asc' } } } },
              presentation: true,
              prescription: { include: { patient: true } },
            },
          },
        },
      }),
    };
  }),
  enqueueReview: dispense
    .input(
      z.object({ prescriptionLineId: z.string().min(1), saleLineId: z.string().min(1) }).strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.pharmacyPharmacistReviewItem.create({
        data: { ...input, requestedByUserId: ctx.session!.user.id },
      })
    ),
  decideReview: publicProcedure
    .use(({ ctx, next }) => {
      ctx.audit.detail.skipInput = true;
      return next();
    })
    .concat(dispense)
    .input(
      z
        .object({
          reviewItemId: z.string().min(1),
          pin: z
            .string()
            .regex(/^\d{4,8}$/)
            .optional(),
          kind: z.enum(['VERIFY', 'CLARIFY', 'REFUSE', 'OVERRIDE', 'COUNSEL', 'SIGN']),
          reason: z.string().trim().min(1).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      ctx.audit.detail.skipInput = true;
      const result = await ctx.db.$transaction(async (tx) => {
        const db = tx as ScopedDb;
        const organizationId = ctx.entitlements.organizationId;
        const item = await db.pharmacyPharmacistReviewItem.findFirst({
          where: { id: input.reviewItemId, organizationId },
        });
        if (!item) throw new TRPCError({ code: 'NOT_FOUND' });
        const saleLine = await db.pharmacySaleLine.findFirst({
          where: { id: item.saleLineId, organizationId },
          include: { sale: true },
        });
        if (!saleLine) throw new TRPCError({ code: 'NOT_FOUND' });
        await requirePharmacyReadBranch({ ...ctx, db }, saleLine.sale.branchId);
        if (
          item.requestedByUserId === ctx.session.user.id &&
          !(await authorizeSoloOwnerApproval(db, {
            organizationId,
            actorId: ctx.session.user.id,
            targetId: item.id,
            branchId: saleLine.branchId,
            capability: 'pharmacy:dispense',
            pin: input.pin,
          }))
        )
          return { blocked: true as const };
        const { pin: secret, ...decision } = input;
        void secret;
        return {
          decision: await db.pharmacyPharmacistReviewDecision.create({
            data: {
              ...decision,
              actorUserId: ctx.session.user.id,
              signedAt: input.kind === 'SIGN' ? new Date() : undefined,
            },
          }),
        };
      });
      if ('blocked' in result)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            'A second approver is required, or a solo owner must reauthenticate with their PIN.',
        });
      return result.decision;
    }),

  recordSubstitution: dispense
    .input(
      z
        .object({
          prescriptionLineId: z.string().min(1),
          saleLineId: z.string().min(1),
          prescribedPresentationId: z.string().min(1),
          suppliedPresentationId: z.string().min(1),
          equivalenceBasis: z.string().trim().min(1),
          patientCommunication: z.string().trim().min(1),
          jurisdictionRuleRef: z.string().trim().min(1),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.pharmacySubstitutionRecord.create({
        data: { ...input, actorUserId: ctx.session!.user.id },
      })
    ),
});
