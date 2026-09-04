import { z } from 'zod';
import { capabilityProcedure, router } from '../trpc';

const dispense = capabilityProcedure('pharmacy:dispense');

export const pharmacyDispensingRouter = router({
  reviewQueue: dispense.query(async ({ ctx }) => ({
    currentUserId: ctx.session!.user.id,
    items: await ctx.db.pharmacyPharmacistReviewItem.findMany({
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
    }),
  })),
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
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.pharmacyPharmacistReviewDecision.create({
        data: {
          ...input,
          actorUserId: ctx.session!.user.id,
          signedAt: input.kind === 'SIGN' ? new Date() : undefined,
        },
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
