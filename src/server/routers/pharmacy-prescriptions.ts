import { z } from 'zod';
import { auditPatientRead, maskedPatient } from '@/lib/pharmacy/patient-prescriptions';
import { auditedProtectedProcedure, protectedProcedure, router } from '../trpc';

const purpose = z.enum(['DISPENSING', 'REMINDERS', 'LOYALTY', 'MARKETING']);
const channel = z.enum(['IN_PERSON', 'PHONE', 'SMS', 'WHATSAPP', 'EMAIL']);

export const pharmacyPrescriptionsRouter = router({
  createPatient: protectedProcedure
    .input(
      z
        .object({
          displayName: z.string().trim().min(1).max(200),
          cnic: z.string().max(32).optional(),
          phone: z.string().max(32).optional(),
          dateOfBirth: z.date().optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) => ctx.db.pharmacyPatient.create({ data: input })),

  recordConsent: protectedProcedure
    .input(
      z
        .object({
          patientId: z.string().min(1),
          purpose,
          channel,
          version: z.number().int().positive(),
          granted: z.boolean(),
          supersedesId: z.string().optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.patientConsent.create({
        data: {
          ...input,
          recordedByUserId: ctx.session.user.id,
          revokedAt: input.granted ? undefined : new Date(),
        },
      })
    ),

  capture: protectedProcedure
    .input(
      z
        .object({
          patientId: z.string().min(1),
          prescriberId: z.string().min(1),
          sourceKind: z.enum(['PAPER_IMAGE', 'WHATSAPP_PHOTO']),
          sourceFileRef: z.string().trim().min(1),
          custodyState: z
            .enum(['NOT_HELD', 'HELD_AT_PHARMACY', 'RETURNED_TO_PATIENT', 'TRANSFERRED'])
            .optional(),
          validFrom: z.date(),
          validUntil: z.date(),
          authorizedRepeats: z.number().int().nonnegative(),
          lines: z
            .array(
              z
                .object({
                  lineNumber: z.number().int().positive(),
                  medicineId: z.string().min(1),
                  presentationId: z.string().min(1),
                  authorizedCanonicalUnits: z.number().int().positive(),
                  directions: z.string().trim().min(1),
                })
                .strict()
            )
            .min(1),
        })
        .strict()
    )
    .mutation(({ ctx, input }) => {
      const { lines, ...prescription } = input;
      return ctx.db.prescription.create({
        data: { ...prescription, capturedByUserId: ctx.session.user.id, lines: { create: lines } },
      });
    }),

  readPatient: auditedProtectedProcedure
    .input(z.object({ patientId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const patient = await ctx.db.pharmacyPatient.findFirstOrThrow({
        where: { id: input.patientId },
      });
      auditPatientRead({
        organizationId: ctx.entitlements.organizationId,
        actorId: ctx.session.user.id,
        patientId: patient.id,
      });
      return maskedPatient(patient);
    }),

  exportPatient: auditedProtectedProcedure
    .input(z.object({ patientId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const patient = await ctx.db.pharmacyPatient.findFirstOrThrow({
        where: { id: input.patientId },
        include: {
          consents: true,
          prescriptions: { include: { lines: { include: { fills: true } } } },
        },
      });
      auditPatientRead({
        organizationId: ctx.entitlements.organizationId,
        actorId: ctx.session.user.id,
        patientId: patient.id,
        export: true,
      });
      return patient;
    }),

  fill: protectedProcedure
    .input(
      z
        .object({
          id: z.string().min(1),
          prescriptionLineId: z.string().min(1),
          fillSequence: z.number().int().positive(),
          quantityCanonicalUnits: z.number().int().positive(),
          idempotencyKey: z.string().trim().min(1).max(200),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.prescriptionFill.create({ data: { ...input, dispensedByUserId: ctx.session.user.id } })
    ),
});
