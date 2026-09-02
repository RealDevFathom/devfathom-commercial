import { z } from 'zod';
import { capabilityProcedure, router } from '../trpc';

const safety = capabilityProcedure('pharmacy:safety');

export const pharmacySafetyRouter = router({
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
