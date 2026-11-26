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
import { actorIsPharmacyOwner } from '@/lib/pharmacy/procurement-access';
import { counterBranchAssignmentDenial } from '@/lib/pharmacy/counter-capability';
import { captureRefillReminder, RefillSupportError } from '@/lib/pharmacy/refill-support';
import {
  configuredRxOcrAdapterName,
  proposeRxPrefill,
  resolveRxOcrAdapter,
  RxOcrError,
} from '@/lib/pharmacy/rx-ocr';
import { buildRxDraftCart } from '@/lib/pharmacy/rx-draft-cart';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';
import type { TRPCContext } from '../trpc';
import { annotateAuditBranch } from '../audit-branch';
import {
  auditedProtectedProcedure,
  capabilityProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '../trpc';

const purpose = z.enum(['DISPENSING', 'REMINDERS', 'LOYALTY', 'MARKETING']);
const channel = z.enum(['IN_PERSON', 'PHONE', 'SMS', 'WHATSAPP', 'EMAIL']);
const prescriptionCalendarDate = z
  .date()
  .refine(
    (value) =>
      value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0 &&
      value.getUTCMilliseconds() === 0,
    'Prescription validity must be a calendar date.'
  );

/** Optional free text: trimmed, and an empty field is stored as absent. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || undefined);

/** DEV-941: the plain refusal for a branch the caller is not assigned to. */
const REFILL_BRANCH_REFUSAL =
  'You are not assigned to this branch. Only a pharmacist assigned to this branch can see its refill reminders.';

/**
 * DEV-941: one branch's refill reminder records, read with the database's own branch rule
 * (`tenant_branch_isolation` on `pharmacy_refill_reminder_captures`) switched on for this read
 * only. The request runs in one transaction, so the previous binding is restored afterwards.
 */
async function branchReminderCaptures(db: ScopedDb, organizationId: string, branchId: string) {
  const [previous] = await db.$queryRaw<{ branch: string | null }[]>`
    SELECT current_setting('app.current_branch_id', true) AS branch`;
  await db.$queryRaw`SELECT set_config('app.current_branch_id', ${branchId}, true)`;
  try {
    return await db.pharmacyRefillReminderCapture.findMany({
      where: { organizationId, branchId },
      orderBy: { capturedAt: 'desc' },
    });
  } finally {
    await db.$queryRaw`SELECT set_config('app.current_branch_id', ${previous?.branch ?? ''}, true)`;
  }
}

function prescriberConflict() {
  return new TRPCError({
    code: 'CONFLICT',
    message: 'A prescriber with this registration number is already in the directory.',
  });
}

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
  // DEV-15: a photo a customer sent from the PWA, attached to that same patient's request.
  const portalRequest =
    patient && !prescription
      ? await ctx.db.pharmacyCustomerPortalRequest.findFirst({
          where: {
            organizationId,
            kind: 'RX_ORDER',
            prescriptionFileRef: sourceFileRef,
            customer: { patientId: file.patientId },
          },
          select: { id: true },
        })
      : null;
  if (
    !patient ||
    (!prescription && !portalRequest && file.uploadedByUserId !== ctx.session.user.id)
  ) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Prescription image unavailable.' });
  }
  return file;
}

/** Read a stored Rx image with the configured OCR adapter (never applied by itself). */
async function readRxSource(ctx: Parameters<typeof readableSourceFile>[0], sourceFileRef: string) {
  const adapterName = configuredRxOcrAdapterName();
  if (!adapterName) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Prescription reading is not enabled for this workspace.',
    });
  }
  const file = await readableSourceFile(ctx, sourceFileRef);
  let extraction;
  try {
    extraction = await resolveRxOcrAdapter(adapterName).extract({
      content: file.bytes,
      mimeType: file.contentType,
      sourceFileRef: sourceFileRef,
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
  return extraction;
}

export const pharmacyPrescriptionsRouter = router({
  workspace: fileProcedure
    .input(
      z
        .object({ branchId: z.string().trim().min(1).max(200).optional() })
        .strict()
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements.organizationId;
      const user = ctx.session.user;
      const activeBranches = await ctx.db.pharmacyBranch.findMany({
        where: { organizationId, active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
      // DEV-941: refill reminders belong to a branch. A pharmacist sees only the branches
      // they are assigned to, a tenant owner every branch: the counter's branch rule,
      // as `captureRefillReminder` writes them and `decideReview` signs at a branch.
      const visible = await Promise.all(
        activeBranches.map(
          async (branch) =>
            !(await counterBranchAssignmentDenial(ctx.db, user, organizationId, branch.id))
        )
      );
      const branches = activeBranches.filter((_, index) => visible[index]);
      if (input?.branchId) {
        const requested = activeBranches.find((branch) => branch.id === input.branchId);
        if (!requested)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Pharmacy branch not found.' });
        // Tag the entry, so a refused read is visible at the branch it targeted.
        annotateAuditBranch(ctx, requested.id);
        if (!branches.some((branch) => branch.id === requested.id))
          throw new TRPCError({ code: 'FORBIDDEN', message: REFILL_BRANCH_REFUSAL });
      }
      const selectedBranch = input?.branchId
        ? branches.find((branch) => branch.id === input.branchId)
        : branches[0];
      const visibleBranchIds = new Set(branches.map((branch) => branch.id));

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
      const [patients, prescribers, medicines, prescriptions] = await Promise.all([
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
      ]);
      const reminderCaptures = selectedBranch
        ? await branchReminderCaptures(ctx.db, organizationId, selectedBranch.id)
        : [];
      return {
        branches,
        selectedBranchId: selectedBranch?.id ?? null,
        // DEV-943: the caller's own organisation zone, so date defaults use the shop's day.
        timezone: workspaceTimezone(ctx.organization?.timezone),
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
            // DEV-941: another branch's reminder record is not shown.
            fills: line.fills.map((fill) => ({
              ...fill,
              reminderCapture:
                fill.reminderCapture && visibleBranchIds.has(fill.reminderCapture.branchId)
                  ? fill.reminderCapture
                  : null,
            })),
            remainingAuthorizedUnits: Math.max(
              0,
              line.authorizedCanonicalUnits * (prescription.authorizedRepeats + 1) -
                line.fills.reduce((total, fill) => total + fill.quantityCanonicalUnits, 0)
            ),
          })),
        })),
      };
    }),
  // DEV-626 / DEV-53 / #1036: registering a patient or prescriber is
  // prescription work, so it carries the same module + `pharmacy:prescriptions`
  // gate (and raw-input audit suppression for patient identifiers) as capture.
  createPatient: fileProcedure
    .input(
      z
        .object({
          displayName: z.string().trim().min(1).max(200),
          cnic: optionalText(32),
          phone: optionalText(32),
          dateOfBirth: z.date().optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) => ctx.db.pharmacyPatient.create({ data: input })),

  createPrescriber: fileProcedure
    .input(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          registrationNumber: z.string().trim().min(1).max(64),
          phone: optionalText(32),
          facility: optionalText(200),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements.organizationId;
      const duplicate = await ctx.db.pharmacyPrescriber.findFirst({
        where: { organizationId, registrationNumber: input.registrationNumber },
        select: { id: true },
      });
      if (duplicate) throw prescriberConflict();
      try {
        return await ctx.db.pharmacyPrescriber.create({ data: input });
      } catch (error) {
        // A concurrent registration that raced past the pre-check.
        if ((error as { code?: unknown } | null)?.code === 'P2002') throw prescriberConflict();
        throw error;
      }
    }),

  recordConsent: capabilityProcedure('pharmacy:prescriptions')
    .input(
      z
        .object({
          patientId: z.string().min(1).max(200),
          purpose,
          channel,
          version: z.number().int().positive().optional(),
          granted: z.boolean(),
          source: z.enum(['COUNTER_TABLET', 'QR']).default('COUNTER_TABLET'),
          supersedesId: z.string().max(200).optional(),
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
      const extraction = await readRxSource(ctx, input.sourceFileRef);
      const medicines = await ctx.db.medicine.findMany({
        where: { organizationId: ctx.entitlements.organizationId, saleable: true },
        select: { id: true, productName: true, brandName: true },
        orderBy: { productName: 'asc' },
      });
      return proposeRxPrefill(extraction, medicines);
    }),

  /**
   * DEV-63: Rx photo → DRAFT cart with salt and strength matching. Writes
   * nothing and confirms nothing: the pharmacist confirms each line into
   * `capture`, and the RX-03 pharmacist sign still releases any sale.
   */
  draftCartFromSource: fileProcedure
    .input(
      z
        .object({
          sourceFileRef: prescriptionFileRefSchema,
          /** The workspace's own confidence threshold; never a built-in figure. */
          minConfidence: z.number().min(0).max(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const extraction = await readRxSource(ctx, input.sourceFileRef);
      const medicines = await ctx.db.medicine.findMany({
        where: { organizationId: ctx.entitlements.organizationId, saleable: true },
        select: {
          id: true,
          productName: true,
          brandName: true,
          strengths: {
            select: {
              ingredientId: true,
              value: true,
              unit: true,
              ingredient: { select: { name: true } },
            },
          },
          presentations: { select: { id: true, presentation: true }, orderBy: { id: 'asc' } },
        },
        orderBy: { productName: 'asc' },
      });
      return buildRxDraftCart(
        extraction,
        medicines.map((medicine) => ({
          ...medicine,
          strengths: medicine.strengths.map((strength) => ({
            ingredientId: strength.ingredientId,
            ingredientName: strength.ingredient.name,
            value: strength.value.toString(),
            unit: strength.unit,
          })),
        })),
        { minConfidence: input.minConfidence }
      );
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
          validFrom: prescriptionCalendarDate,
          validUntil: prescriptionCalendarDate,
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
        .refine((value) => value.validFrom <= value.validUntil, {
          message: 'Valid until must be on or after valid from.',
          path: ['validUntil'],
        })
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

  readPatient: capabilityProcedure('pharmacy:prescriptions')
    .input(z.object({ patientId: z.string().min(1).max(200) }).strict())
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

  exportPatient: capabilityProcedure('pharmacy:prescriptions')
    .input(z.object({ patientId: z.string().min(1).max(200) }).strict())
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
      return { ...patient, ...maskedPatient(patient) };
    }),

  // Recording a fill is a dispensing act: require the exact-grant-only
  // pharmacy:dispense capability through central ABAC (DENY wins).
  fill: capabilityProcedure('pharmacy:dispense')
    .input(
      z
        .object({
          id: z.string().min(1).max(200),
          prescriptionLineId: z.string().min(1).max(200),
          fillSequence: z.number().int().positive(),
          quantityCanonicalUnits: z.number().int().positive(),
          idempotencyKey: z.string().trim().min(1).max(200),
          // DEV-962: the branch dispensing the fill. Only that branch may later record the
          // fill's refill reminder; a fill recorded without one leaves that to an owner.
          branchId: z.string().trim().min(1).max(128).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      if (input.branchId) {
        const organizationId = ctx.entitlements.organizationId;
        const branch = await ctx.db.pharmacyBranch.findFirst({
          where: { id: input.branchId, organizationId, active: true },
          select: { id: true },
        });
        if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'BRANCH_NOT_FOUND' });
        annotateAuditBranch(ctx, branch.id);
        if (
          await counterBranchAssignmentDenial(ctx.db, ctx.session.user, organizationId, branch.id)
        )
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
      }
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
      const organizationId = ctx.entitlements.organizationId;
      const user = ctx.session!.user;
      // DEV-938: a reminder is recorded only at a branch the caller works at, as
      // every other branch-scoped dispensing action. A branch of another
      // organization, an inactive one and a missing one get the same refusal;
      // only a tenant owner of this organization may use any of its branches.
      const branch = await ctx.db.pharmacyBranch.findFirst({
        where: { id: input.branchId, organizationId, active: true },
        select: { id: true },
      });
      if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'BRANCH_NOT_FOUND' });
      // Tag the entry now, so a refused attempt is visible at the branch it targeted.
      annotateAuditBranch(ctx, branch.id);
      if (await counterBranchAssignmentDenial(ctx.db, user, organizationId, branch.id))
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
      // DEV-962: a fill has one reminder slot, and only the branch that dispensed the fill may
      // take it, so another branch cannot use it up. A fill whose dispensing branch is not
      // recorded (older than this rule, branch not provable) is left to an organisation owner.
      // A missing fill is reported by `captureRefillReminder` as before.
      if (user.role !== 'ADMIN' || !(await actorIsPharmacyOwner(ctx.db, organizationId, user.id))) {
        const fill = await ctx.db.prescriptionFill.findFirst({
          where: { id: input.fillId, organizationId },
          select: { branchId: true },
        });
        if (fill && fill.branchId !== branch.id)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: fill.branchId ? 'FILL_DISPENSED_AT_ANOTHER_BRANCH' : 'FILL_BRANCH_UNKNOWN',
          });
      }
      try {
        return await captureRefillReminder(
          ctx.db,
          { organizationId, branchId: branch.id, actorId: user.id },
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
    .input(z.object({ patientId: z.string().min(1).max(200) }).strict())
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
