import { authorizeSoloApproval, soloOwnerEligible } from '@/lib/pharmacy/solo-approval';
import { z } from 'zod';
import { capabilityProcedure, router } from '../trpc';
import { TRPCError } from '@trpc/server';

const dispense = capabilityProcedure('pharmacy:dispense');

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
    const items = await ctx.db.pharmacyPharmacistReviewItem.findMany({
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
    const soloReviewItemIds: string[] = [];
    for (const item of items) {
      if (item.requestedByUserId !== ctx.session!.user.id) continue;
      const line = await ctx.db.pharmacySaleLine.findFirst({
        where: { id: item.saleLineId },
        select: { branchId: true },
      });
      if (
        await soloOwnerEligible(ctx.db, {
          organizationId: ctx.entitlements.organizationId,
          branchId: line?.branchId,
          actorId: ctx.session!.user.id,
        })
      )
        soloReviewItemIds.push(item.id);
    }
    return { currentUserId: ctx.session!.user.id, items, soloReviewItemIds };
  }),
  substitutionWorkspace: dispense.query(async ({ ctx }) => ({
    lines: await ctx.db.pharmacyPharmacistReviewItem.findMany({
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
  })),
  enqueueReview: dispense
    .input(
      z.object({ prescriptionLineId: z.string().min(1), saleLineId: z.string().min(1) }).strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.pharmacyPharmacistReviewItem.create({
        data: { ...input, requestedByUserId: ctx.session!.user.id },
      })
    ),
  decideReview: dispense
    .input(
      z
        .object({
          reviewItemId: z.string().min(1),
          kind: z.enum(['VERIFY', 'CLARIFY', 'REFUSE', 'OVERRIDE', 'COUNSEL', 'SIGN']),
          reason: z.string().trim().min(1).optional(),
          pin: z
            .string()
            .regex(/^\d{4,8}$/)
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (db) => {
        const item = await db.pharmacyPharmacistReviewItem.findFirst({
          where: { id: input.reviewItemId },
        });
        if (!item) throw new TRPCError({ code: 'NOT_FOUND' });
        const line = await db.pharmacySaleLine.findFirst({
          where: { id: item.saleLineId },
          select: { branchId: true },
        });
        if (
          item.requestedByUserId === ctx.session!.user.id &&
          !(await authorizeSoloApproval(
            db as typeof ctx.db,
            {
              organizationId: ctx.entitlements.organizationId,
              branchId: line?.branchId ?? null,
              actorId: ctx.session!.user.id,
            },
            { type: 'PharmacyReviewItem', id: item.id },
            input.pin
          ))
        ) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'A second pharmacist or a solo owner PIN is required.',
          });
        }
        const decision = {
          reviewItemId: input.reviewItemId,
          kind: input.kind,
          reason: input.reason,
        };
        return db.pharmacyPharmacistReviewDecision.create({
          data: {
            ...decision,
            actorUserId: ctx.session!.user.id,
            signedAt: input.kind === 'SIGN' ? new Date() : undefined,
          },
        });
      })
    ),
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
