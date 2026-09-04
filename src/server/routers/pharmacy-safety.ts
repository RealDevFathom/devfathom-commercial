import { z } from 'zod';
import { annotateAudit } from '@/server/audit';
import { createInspectionPack } from '@/lib/pharmacy/inspection-pack';
import { installPharmacySopLibrary } from '@/lib/pharmacy/sop-library';
import { activeLegalHoldKeys } from '@/lib/pharmacy/retention';
import { capabilityProcedure, router } from '../trpc';

const safety = capabilityProcedure('pharmacy:safety');

export const pharmacySafetyRouter = router({
  controlledRegister: safety.query(async ({ ctx }) => ({
    entries: await ctx.db.pharmacyControlledRegisterEntry.findMany({
      orderBy: [{ branchId: 'asc' }, { serial: 'desc' }],
      include: {
        patient: true,
        prescriber: true,
        prescription: true,
        line: { include: { medicine: true } },
        incidents: { include: { approvals: true } },
      },
    }),
  })),
  createInspectionPack: safety
    .input(z.object({ branchId: z.string().min(1), from: z.date(), to: z.date() }).strict())
    .query(async ({ ctx, input }) => {
      if (input.from > input.to) throw new Error('Inspection pack start must not follow its end.');
      const manifest = await createInspectionPack(ctx.db, input);
      annotateAudit(ctx, {
        category: 'PHARMACY_SAFETY',
        operation: 'READ',
        action: 'pharmacy.inspectionPack.export',
        targetType: 'PharmacyBranch',
        targetId: input.branchId,
        skipInput: true,
        metadata: { sensitiveExport: true, manifestSha256: manifest.manifestSha256 },
      });
      return manifest;
    }),
  installSopLibrary: safety.mutation(({ ctx }) => installPharmacySopLibrary(ctx.db)),
  setRetentionClass: safety
    .input(
      z
        .object({
          id: z.string().min(1),
          recordClass: z.enum(['PRESCRIPTION', 'CONTROLLED_REGISTER', 'FISCAL', 'AUDIT']),
          retentionDays: z.number().int().positive(),
          effectiveFrom: z.date(),
          reason: z.string().trim().min(1),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.pharmacyRetentionClass.create({
        data: { ...input, createdByUserId: ctx.session!.user.id },
      })
    ),
  recordLegalHold: safety
    .input(
      z
        .object({
          id: z.string().min(1),
          holdKey: z.string().trim().min(1),
          recordClass: z.enum(['PRESCRIPTION', 'CONTROLLED_REGISTER', 'FISCAL', 'AUDIT']),
          recordId: z.string().min(1),
          kind: z.enum(['PLACED', 'RELEASED']),
          reason: z.string().trim().min(1),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.pharmacyLegalHoldEvent.create({
        data: { ...input, actorUserId: ctx.session!.user.id },
      })
    ),
  legalHoldStatus: safety
    .input(
      z
        .object({
          recordClass: z.enum(['PRESCRIPTION', 'CONTROLLED_REGISTER', 'FISCAL', 'AUDIT']),
          recordId: z.string().min(1),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const holdKeys = await activeLegalHoldKeys(ctx.db, input.recordClass, input.recordId);
      return { held: holdKeys.length > 0, holdKeys };
    }),
  recordControlledEntry: safety
    .input(
      z
        .object({
          id: z.string().min(1),
          branchId: z.string().min(1),
          serial: z.number().int().positive(),
          prescriptionId: z.string().min(1),
          prescriptionLineId: z.string().min(1),
          patientId: z.string().min(1),
          prescriberId: z.string().min(1),
          inventoryLotId: z.string().min(1),
          stockMovementId: z.string().min(1),
          batchNumber: z.string().trim().min(1),
          quantityCanonicalUnits: z.number().int().positive(),
          runningBalance: z.number().int().nonnegative(),
          witnessedByUserId: z.string().min(1),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.pharmacyControlledRegisterEntry.create({
        data: { ...input, recordedByUserId: ctx.session!.user.id },
      })
    ),
  approveRegisterIncident: safety
    .input(z.object({ incidentId: z.string().min(1), reason: z.string().trim().min(1) }).strict())
    .mutation(({ ctx, input }) =>
      ctx.db.pharmacyRegisterIncidentApproval.create({
        data: { ...input, approvedByUserId: ctx.session!.user.id },
      })
    ),
});
