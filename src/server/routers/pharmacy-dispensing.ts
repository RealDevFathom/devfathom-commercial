import { z } from 'zod';
import { can, subjectFromSession } from '@/lib/abac';
import { auditedProtectedProcedure, capabilityProcedure, router } from '../trpc';
import { TRPCError } from '@trpc/server';

const dispense = capabilityProcedure('pharmacy:dispense');

// DEV-832: dispensing queues show who the prescription is for, nothing more.
// CNIC, phone, address and date of birth stay behind the audited, masked
// patient-read route (`pharmacyPrescriptions.readPatient`).
const queuePatient = { select: { id: true, displayName: true } } as const;

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
  reviewQueue: dispense.query(async ({ ctx }) => ({
    currentUserId: ctx.session!.user.id,
    items: await ctx.db.pharmacyPharmacistReviewItem.findMany({
      orderBy: { requestedAt: 'asc' },
      include: {
        line: {
          include: {
            medicine: true,
            presentation: true,
            prescription: {
              include: { patient: queuePatient, prescriber: { select: { id: true, name: true } } },
            },
          },
        },
        decisions: { orderBy: { createdAt: 'asc' } },
      },
    }),
  })),
  // DEV-35: the substitution workspace opens for a dispensing pharmacist or a
  // Pharmacy Safety holder (the same pair the rail offers it to). Only a
  // dispensing pharmacist may record evidence (`recordSubstitution`), so the
  // read says which of the two this caller is.
  // QA-7: patient records are a separate permission. The patient (id and name
  // only, per DEV-832) is read and returned only for a caller holding
  // `pharmacy:prescriptions`, the patient-record permission `readPatient` enforces.
  substitutionWorkspace: auditedProtectedProcedure.query(async ({ ctx }) => {
    const user = ctx.session!.user;
    const subject = subjectFromSession(user);
    const options = { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta.ip };
    const canRecord =
      Boolean(user.id) && (await can(subject, 'pharmacy:dispense', undefined, options));
    if (
      !canRecord &&
      !(Boolean(user.id) && (await can(subject, 'pharmacy:safety', undefined, options)))
    ) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'You do not have permission for this action.',
      });
    }
    const canViewPatients = await can(subject, 'pharmacy:prescriptions', undefined, options);
    const orderBy = { requestedAt: 'desc' } as const;
    const medicine = { include: { presentations: { orderBy: { presentation: 'asc' } } } } as const;
    // Without that permission the patient relation is never read and every line
    // carries `patient: null`.
    const lines = canViewPatients
      ? await ctx.db.pharmacyPharmacistReviewItem.findMany({
          orderBy,
          include: {
            line: {
              include: {
                medicine,
                presentation: true,
                prescription: { include: { patient: queuePatient } },
              },
            },
          },
        })
      : (
          await ctx.db.pharmacyPharmacistReviewItem.findMany({
            orderBy,
            include: { line: { include: { medicine, presentation: true, prescription: true } } },
          })
        ).map((item) => ({
          ...item,
          line: { ...item.line, prescription: { ...item.line.prescription, patient: null } },
        }));
    return { canRecord, canViewPatients, lines };
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
