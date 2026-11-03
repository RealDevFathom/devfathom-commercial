import { writePatientConsent } from '@/lib/pharmacy/consent-writer';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import {
  loadPrescriptionFile,
  persistPrescriptionFile,
  prescriptionFileId,
  prescriptionFileRefSchema,
  prescriptionUploadSchema,
} from '@/lib/pharmacy/prescription-files';
import {
  PharmacyCounterPrescriptionError,
  readCounterPatientPanel,
  searchCounterPatients,
} from '@/lib/pharmacy/counter-prescriptions';
import { auditPatientRead, maskedPatient } from '@/lib/pharmacy/patient-prescriptions';
import { captureRefillReminder, RefillSupportError } from '@/lib/pharmacy/refill-support';
import {
  configuredRxOcrAdapterName,
  proposeRxPrefill,
  resolveRxOcrAdapter,
  RxOcrError,
} from '@/lib/pharmacy/rx-ocr';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '../trpc';
import {
  auditedProtectedProcedure,
  capabilityProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '../trpc';

const purpose = z.enum(['DISPENSING', 'REMINDERS', 'LOYALTY', 'MARKETING']);
const channel = z.enum(['IN_PERSON', 'PHONE', 'SMS', 'WHATSAPP', 'EMAIL']);

async function requireCounterPatientAccess(
  ctx: Pick<TRPCContext, 'db' | 'requestMeta'> & {
    session: NonNullable<TRPCContext['session']>;
  }
) {
  const subject = subjectFromSession(ctx.session.user);
  const options = { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta.ip };
  if (
    !(await can(subject, 'pharmacy:counter', undefined, options)) &&
    !(await can(subject, 'pharmacy:dispense', undefined, options))
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission to access counter patients.',
    });
  }
}

// Suppress sensitive payload auditing before authentication/input validation,
// including denied uploads. Keep the existing audited guards and ABAC engine.
const fileProcedure = publicProcedure
  .use(({ ctx, next }) => {
    ctx.audit.detail.skipInput = true;
    return next();
  })
  .concat(auditedProtectedProcedure)
  .use(async ({ ctx, next }) => {
    const subject = subjectFromSession(ctx.session.user);
    const options = { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta.ip };
    if (
      !hasModule(ctx.entitlements, 'pharmacy-dispensing') ||
      !(await can(subject, 'pharmacy:prescriptions', undefined, options))
    ) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Prescription file access is not permitted.',
      });
    }
    return next();
  });

/**
 * Load a stored Rx image the caller may see. Before capture only the uploader
 * may preview it; after capture the stored prescription must prove the same
 * patient/file binding.
 */
async function readableSourceFile(
  ctx: {
    db: ScopedDb;
    entitlements: { organizationId: string };
    session: { user: { id: string } };
  },
  sourceFileRef: string
) {
  const organizationId = ctx.entitlements.organizationId;
  const file = await loadPrescriptionFile(organizationId, sourceFileRef);
  const patient = await ctx.db.pharmacyPatient.findFirst({
    where: { id: file.patientId, organizationId },
    select: { id: true },
  });
  const prescription = await ctx.db.prescription.findFirst({
    where: { organizationId, patientId: file.patientId, sourceFileRef },
    select: { id: true },
  });
  if (!patient || (!prescription && file.uploadedByUserId !== ctx.session.user.id)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Prescription image unavailable.' });
  }
  return file;
}

export const pharmacyPrescriptionsRouter = router({
  workspace: fileProcedure
    .input(
      z
        .object({ branchId: z.string().trim().min(1).optional() })
        .strict()
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const branches = await ctx.db.pharmacyBranch.findMany({
        where: { active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, city: true },
      });
      const selectedBranch = input?.branchId
        ? branches.find((branch) => branch.id === input.branchId)
        : branches[0];
      if (input?.branchId && !selectedBranch)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Pharmacy branch not found.' });

      // Prescription access is narrower than dispensing (tenant admins may
      // capture without an exact dispense grant). Report whether the caller can
      // also record fills / refill reminders so the console hides actions that
      // the `pharmacy:dispense` gate would refuse.
      const canDispense = await can(
        subjectFromSession(ctx.session.user),
        'pharmacy:dispense',
        undefined,
        { db: ctx.db, source: 'TRPC', ip: ctx.requestMeta.ip }
      );
      const [patients, prescribers, medicines, prescriptions, reminderCaptures] = await Promise.all(
        [
          ctx.db.pharmacyPatient.findMany({ orderBy: { displayName: 'asc' } }),
          ctx.db.pharmacyPrescriber.findMany({ orderBy: { name: 'asc' } }),
          ctx.db.medicine.findMany({
            where: { saleable: true },
            orderBy: { productName: 'asc' },
            include: { presentations: { orderBy: { presentation: 'asc' } } },
          }),
          ctx.db.prescription.findMany({
            orderBy: { capturedAt: 'desc' },
            include: {
              patient: true,
              prescriber: true,
              lines: {
                orderBy: { lineNumber: 'asc' },
                include: {
                  medicine: true,
                  presentation: true,
                  fills: { include: { reminderCapture: true }, orderBy: { dispensedAt: 'desc' } },
                },
              },
            },
          }),
          selectedBranch
            ? ctx.db.pharmacyRefillReminderCapture.findMany({
                where: { branchId: selectedBranch.id },
                orderBy: { capturedAt: 'desc' },
              })
            : Promise.resolve([]),
        ]
      );
      return {
        branches,
        selectedBranchId: selectedBranch?.id ?? null,
        canDispense,
        patients: patients.map(maskedPatient),
        prescribers,
        medicines,
        reminderCaptures,
        prescriptions: prescriptions.map((prescription) => ({
          ...prescription,
          patient: maskedPatient(prescription.patient),
          lines: prescription.lines.map((line) => ({
            ...line,
            remainingAuthorizedUnits: Math.max(
              0,
              line.authorizedCanonicalUnits * (prescription.authorizedRepeats + 1) -
                line.fills.reduce((total, fill) => total + fill.quantityCanonicalUnits, 0)
            ),
          })),
        })),
      };
    }),
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
          version: z.number().int().positive().optional(),
          granted: z.boolean(),
          source: z.enum(['COUNTER_TABLET', 'QR']).default('COUNTER_TABLET'),
          supersedesId: z.string().optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((db) =>
        writePatientConsent(
          db as typeof ctx.db,
          ctx.entitlements.organizationId,
          ctx.session.user.id,
          // Source is client-labelled, so an authenticated staff session always
          // stays attributable as the capturing staff member, QR included.
          { ...input, staffId: ctx.session.user.id }
        )
      )
    ),

  uploadSource: fileProcedure.input(prescriptionUploadSchema).mutation(async ({ ctx, input }) => {
    const organizationId = ctx.entitlements.organizationId;
    const patient = await ctx.db.pharmacyPatient.findFirst({
      where: { id: input.patientId, organizationId },
      select: { id: true },
    });
    if (!patient) throw new TRPCError({ code: 'NOT_FOUND', message: 'Patient not found.' });
    return persistPrescriptionFile(organizationId, ctx.session.user.id, input);
  }),

  readSource: fileProcedure
    .input(z.object({ sourceFileRef: prescriptionFileRefSchema }).strict())
    .query(async ({ ctx, input }) => {
      const file = await readableSourceFile(ctx, input.sourceFileRef);
      return { dataBase64: file.dataBase64, contentType: file.contentType };
    }),

  /**
   * PH-A3: read drug and dose off a stored Rx image as a PROPOSAL. Nothing is
   * written; the pharmacist confirms each value into the capture form, and
   * `capture` never reads OCR output. Off unless PHARMACY_RX_OCR_ADAPTER is set.
   */
  extractSource: fileProcedure
    .input(z.object({ sourceFileRef: prescriptionFileRefSchema }).strict())
    .mutation(async ({ ctx, input }) => {
      const adapterName = configuredRxOcrAdapterName();
      if (!adapterName) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Prescription reading is not enabled for this workspace.',
        });
      }
      const file = await readableSourceFile(ctx, input.sourceFileRef);
      let extraction;
      try {
        extraction = await resolveRxOcrAdapter(adapterName).extract({
          content: file.bytes,
          mimeType: file.contentType,
          sourceFileRef: input.sourceFileRef,
        });
      } catch (error) {
        if (error instanceof RxOcrError) {
          // Provider detail stays server-side; the counter gets an operator sentence.
          throw new TRPCError({
            code: error.reason === 'ADAPTER_UNAVAILABLE' ? 'PRECONDITION_FAILED' : 'BAD_GATEWAY',
            message: 'The prescription could not be read. Enter the details by hand.',
            cause: error,
          });
        }
        throw error;
      }
      const medicines = await ctx.db.medicine.findMany({
        where: { organizationId: ctx.entitlements.organizationId, saleable: true },
        select: { id: true, productName: true, brandName: true },
        orderBy: { productName: 'asc' },
      });
      return proposeRxPrefill(extraction, medicines);
    }),

  capture: fileProcedure
    .input(
      z
        .object({
          patientId: z.string().min(1).max(200),
          prescriberId: z.string().min(1).max(200),
          sourceKind: z.enum(['PAPER_IMAGE', 'WHATSAPP_PHOTO']),
          sourceFileRef: prescriptionFileRefSchema,
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
                  medicineId: z.string().min(1).max(200),
                  presentationId: z.string().min(1).max(200),
                  authorizedCanonicalUnits: z.number().int().positive(),
                  directions: z.string().trim().min(1).max(2_000),
                })
                .strict()
            )
            .min(1)
            .max(30),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { lines, ...prescription } = input;
      const organizationId = ctx.entitlements.organizationId;
      const file = await loadPrescriptionFile(organizationId, input.sourceFileRef);
      if (file.patientId !== input.patientId || file.uploadedByUserId !== ctx.session.user.id) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Prescription image unavailable for this patient.',
        });
      }
      const [patient, prescriber] = await Promise.all([
        ctx.db.pharmacyPatient.findFirst({
          where: { id: input.patientId, organizationId },
          select: { id: true },
        }),
        ctx.db.pharmacyPrescriber.findFirst({
          where: { id: input.prescriberId, organizationId },
          select: { id: true },
        }),
      ]);
      if (!patient || !prescriber)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Patient or prescriber not found.' });
      // One durable file identifies one capture. A failed/uncertain create can
      // be retried without duplicate records; competing inserts fail on the PK.
      const id = `rx-${prescriptionFileId(input.sourceFileRef)}`;
      const existing = await ctx.db.prescription.findFirst({
        where: { id, organizationId },
        include: { lines: true },
      });
      if (existing) {
        const savedLinesInOrder = [...existing.lines].sort((a, b) => a.lineNumber - b.lineNumber);
        const inputLinesInOrder = [...lines].sort((a, b) => a.lineNumber - b.lineNumber);
        const sameLines =
          existing.lines.length === lines.length &&
          inputLinesInOrder.every((line, index) =>
            Object.entries(line).every(
              ([key, value]) =>
                savedLinesInOrder[index][key as keyof (typeof savedLinesInOrder)[number]] === value
            )
          );
        if (
          existing.patientId !== input.patientId ||
          existing.prescriberId !== input.prescriberId ||
          existing.sourceFileRef !== input.sourceFileRef ||
          existing.sourceKind !== input.sourceKind ||
          existing.custodyState !== (input.custodyState ?? 'NOT_HELD') ||
          existing.validFrom.getTime() !== input.validFrom.getTime() ||
          existing.validUntil.getTime() !== input.validUntil.getTime() ||
          existing.authorizedRepeats !== input.authorizedRepeats ||
          !sameLines
        ) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This image already belongs to a different capture.',
          });
        }
        const { lines: savedLines, ...saved } = existing;
        void savedLines;
        return saved;
      }
      return ctx.db.prescription.create({
        data: {
          ...prescription,
          id,
          capturedByUserId: ctx.session.user.id,
          lines: { create: lines },
        },
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

  // Recording a fill is a dispensing act: require the exact-grant-only
  // pharmacy:dispense capability through central ABAC (DENY wins).
  fill: capabilityProcedure('pharmacy:dispense')
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
    .mutation(async ({ ctx, input }) => {
      const line = await ctx.db.prescriptionLine.findFirst({
        where: {
          id: input.prescriptionLineId,
          organizationId: ctx.entitlements.organizationId,
        },
        select: { medicine: { select: { controlled: true } } },
      });
      if (!line) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Prescription line not found.' });
      }
      // Controlled dispensing must use the counter flow, which atomically allocates stock and
      // records both the witnessed fill and controlled-drug register entry.
      if (line.medicine.controlled) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Controlled medicines must be dispensed through the witnessed counter flow.',
        });
      }
      return ctx.db.prescriptionFill.create({
        data: { ...input, dispensedByUserId: ctx.session.user.id },
      });
    }),

  captureRefillReminder: capabilityProcedure('pharmacy:dispense')
    .input(
      z
        .object({
          branchId: z.string().trim().min(1).max(128),
          fillId: z.string().trim().min(1).max(128),
          channel: z.enum(['PHONE', 'SMS', 'WHATSAPP', 'EMAIL']),
          directionsUrdu: z.string().trim().min(1).max(500),
          idempotencyKey: z.string().trim().min(1).max(200),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await captureRefillReminder(
          ctx.db,
          {
            organizationId: ctx.entitlements.organizationId,
            branchId: input.branchId,
            actorId: ctx.session!.user.id,
          },
          input
        );
      } catch (error) {
        if (error instanceof RefillSupportError) {
          throw new TRPCError({
            code:
              error.reason === 'FILL_NOT_FOUND' || error.reason === 'BRANCH_NOT_FOUND'
                ? 'NOT_FOUND'
                : error.reason === 'REMINDER_CONSENT_REQUIRED' ||
                    error.reason === 'PHARMACIST_APPROVAL_REQUIRED'
                  ? 'FORBIDDEN'
                  : 'BAD_REQUEST',
            message: error.reason,
          });
        }
        throw error;
      }
    }),

  // ── POS-09: the prescription panel beside the cart ────────────────────────

  /** Patients a counter can attach without navigating away from the bill. */
  counterPatients: protectedProcedure
    .input(z.object({ query: z.string().trim().min(2).max(120) }).strict())
    .query(async ({ ctx, input }) => {
      await requireCounterPatientAccess(ctx);
      try {
        return {
          patients: await searchCounterPatients(
            ctx.db,
            ctx.entitlements.organizationId,
            input.query
          ),
        };
      } catch (error) {
        if (error instanceof PharmacyCounterPrescriptionError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.reason });
        }
        throw error;
      }
    }),

  /**
   * The panel itself: masked identity plus live authorizations.
   *
   * `auditedProtectedProcedure` and the explicit `auditPatientRead` below keep
   * this on the same audited path as `readPatient` — a counter-side read of a
   * patient is still a protected read (RX-01), not an exemption.
   */
  counterPatientPanel: auditedProtectedProcedure
    .input(z.object({ patientId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      await requireCounterPatientAccess(ctx);
      try {
        const panel = await readCounterPatientPanel(
          ctx.db,
          ctx.entitlements.organizationId,
          input.patientId
        );
        auditPatientRead({
          organizationId: ctx.entitlements.organizationId,
          actorId: ctx.session.user.id,
          patientId: panel.patientId,
        });
        return panel;
      } catch (error) {
        if (error instanceof PharmacyCounterPrescriptionError) {
          throw new TRPCError({
            code: error.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST',
            message: error.reason,
          });
        }
        throw error;
      }
    }),
});
