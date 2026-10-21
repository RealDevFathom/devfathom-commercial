import { can } from '@/lib/abac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { annotateAudit } from '@/server/audit';
import { appendControlledCorrection } from '@/lib/pharmacy/controlled-register';
import { createInspectionPack } from '@/lib/pharmacy/inspection-pack';
import { installPharmacySopLibrary } from '@/lib/pharmacy/sop-library';
import { activeLegalHoldKeys } from '@/lib/pharmacy/retention';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import { protectedProcedure, capabilityProcedure, router, type TRPCContext } from '../trpc';

async function organizationBranch(ctx: TRPCContext, branchId: string) {
  const organizationId = ctx.entitlements?.organizationId;
  if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const branch = await ctx.db.pharmacyBranch.findFirst({
    where: { id: branchId, organizationId, active: true },
    select: { id: true },
  });
  if (!branch) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your pharmacy scope.' });
  }
  return organizationId;
}

const safety = capabilityProcedure('pharmacy:safety');

export const pharmacySafetyRouter = router({
  controlledPharmacists: protectedProcedure.query(async ({ ctx }) => {
    const staff = await ctx.db.restaurantStaffProfile.findMany({
      where: {
        status: 'ACTIVE',
        userId: { not: ctx.session!.user.id },
        credentials: { some: { type: 'PIN', revokedAt: null, deviceId: null } },
      },
      include: { user: true },
    });
    const eligible: Array<{ id: string; name: string }> = [];
    for (const profile of staff) {
      if (
        profile.user?.status === 'ACTIVE' &&
        (await can(profile.user, 'pharmacy:dispense', undefined, { db: ctx.db }))
      )
        eligible.push({ id: profile.id, name: profile.displayName });
    }
    return eligible;
  }),
  branches: safety.query(async ({ ctx }) => {
    const organizationId = ctx.entitlements?.organizationId;
    if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
    return ctx.db.pharmacyBranch.findMany({
      where: { organizationId, active: true },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }),
  controlledRegister: safety
    .input(z.object({ branchId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const organizationId = await organizationBranch(ctx, input.branchId);
      return {
        entries: await ctx.db.pharmacyControlledRegisterEntry.findMany({
          where: { organizationId, branchId: input.branchId },
          orderBy: { serial: 'asc' },
          include: {
            patient: true,
            prescriber: true,
            prescription: true,
            medicine: { select: { productName: true, manufacturer: true } },
            line: { include: { medicine: true } },
            correctsEntry: { select: { serial: true } },
            refEntry: { select: { serial: true } },
            incidents: { include: { approvals: true } },
          },
        }),
      };
    }),
  recordCorrection: safety
    .input(
      z
        .object({
          branchId: z.string().min(1),
          correctsEntryId: z.string().min(1),
          correctionReason: z.string().trim().min(3).max(500),
          quantityCanonicalUnits: z.number().int().positive(),
          balanceDelta: z.number().int(),
          staffProfileId: z.string().min(1),
          pin: z.string().regex(/^\d{4,8}$/),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = await organizationBranch(ctx, input.branchId);
      const actorId = ctx.session!.user.id;
      try {
        return await ctx.db.$transaction(async (tx) => {
          const db = tx as ScopedDb;
          await db.$queryRaw`SELECT id FROM restaurant_operator_credentials WHERE "organizationId"=${organizationId} AND "staffProfileId"=${input.staffProfileId} AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`;
          const credential = await db.restaurantOperatorCredential.findFirst({
            where: {
              organizationId,
              staffProfileId: input.staffProfileId,
              type: 'PIN',
              revokedAt: null,
              deviceId: null,
            },
            include: { staffProfile: { include: { user: true } } },
          });
          const pharmacist = credential?.staffProfile.user;
          const now = new Date();
          const eligible =
            credential &&
            credential.staffProfile.status === 'ACTIVE' &&
            pharmacist &&
            pharmacist.organizationId === organizationId &&
            pharmacist.status === 'ACTIVE' &&
            pharmacist.id !== actorId &&
            !isLockedOut(credential, now) &&
            (await can(pharmacist, 'pharmacy:dispense', undefined, { db, now }));
          if (!eligible || !credential || !pharmacist) {
            return { blocked: 'A different qualified person must enter their PIN.' };
          }
          if (!(await verifyOperatorCredential('PIN', input.pin, credential.credentialHash))) {
            await db.restaurantOperatorCredential.update({
              where: { id: credential.id },
              data: registerFailedAttempt(credential, now),
            });
            return { blocked: 'A different qualified person must enter their PIN.' };
          }
          await db.restaurantOperatorCredential.update({
            where: { id: credential.id },
            data: clearLockout(),
          });
          return appendControlledCorrection(db, {
            organizationId,
            branchId: input.branchId,
            correctsEntryId: input.correctsEntryId,
            correctionReason: input.correctionReason,
            quantityCanonicalUnits: input.quantityCanonicalUnits,
            balanceDelta: input.balanceDelta,
            recordedByUserId: actorId,
            witnessedByUserId: pharmacist.id,
            signatureRef: `pin:${pharmacist.id}`,
          });
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'NOT_FOUND') {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'That register entry is not on this branch.',
          });
        }
        if (error instanceof Error && error.message === 'BALANCE') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'That correction would make the balance negative.',
          });
        }
        throw error;
      }
    }),
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
