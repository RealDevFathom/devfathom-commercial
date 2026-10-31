import { can, subjectFromSession } from '@/lib/abac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { annotateAudit } from '@/server/audit';
import {
  appendControlledCorrection,
  assignedRegisterBranchIds,
  listControlledPinWitnesses,
} from '@/lib/pharmacy/controlled-register';
import { chooseRegisterPersonName } from '@/lib/pharmacy/register-print';
import { maskCnic } from '@/lib/pharmacy/patient-prescriptions';
import { provinceName, ruleSetOptions } from '@/lib/pharmacy/regulatory-profile-form';
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
  const userId = ctx.session?.user?.id;
  if (!organizationId || !userId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const assigned = await assignedRegisterBranchIds(ctx.db, organizationId, userId);
  if (!assigned.includes(branchId)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your pharmacy scope.' });
  }
  const branch = await ctx.db.pharmacyBranch.findFirst({
    where: { id: branchId, organizationId, active: true },
    select: { id: true, provinceCode: true },
  });
  if (!branch) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your pharmacy scope.' });
  }
  return { organizationId, provinceCode: branch.provinceCode };
}

const safety = capabilityProcedure('pharmacy:safety');

export const pharmacySafetyRouter = router({
  access: protectedProcedure.query(async ({ ctx }) => {
    const user = ctx.session?.user;
    if (!user) return { allowed: false };
    return {
      allowed: await can(subjectFromSession(user), 'pharmacy:safety', undefined, {
        db: ctx.db,
        source: 'TRPC',
      }),
    };
  }),
  controlledPharmacists: protectedProcedure.query(async ({ ctx }) => {
    const actor = subjectFromSession(ctx.session!.user);
    if (
      !(await can(actor, 'pharmacy:safety', undefined, { db: ctx.db })) &&
      !(await can(actor, 'pharmacy:dispense', undefined, { db: ctx.db }))
    ) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
    const organizationId = ctx.entitlements?.organizationId;
    if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
    return listControlledPinWitnesses(ctx.db, organizationId, actor.id);
  }),
  branches: safety.query(async ({ ctx }) => {
    const organizationId = ctx.entitlements?.organizationId;
    const userId = ctx.session?.user?.id;
    if (!organizationId || !userId) throw new TRPCError({ code: 'UNAUTHORIZED' });
    const assigned = await assignedRegisterBranchIds(ctx.db, organizationId, userId);
    if (assigned.length === 0) return [];
    return ctx.db.pharmacyBranch.findMany({
      where: { organizationId, active: true, id: { in: assigned } },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }),
  controlledRegister: safety
    .input(z.object({ branchId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const { organizationId, provinceCode: branchProvinceCode } = await organizationBranch(
        ctx,
        input.branchId
      );
      const now = new Date();
      const ruleFields = {
        licenceCategories: true,
        permittedSchedules: true,
        pharmacistCoverageRule: true,
      } as const;
      const [entries, profile] = await Promise.all([
        ctx.db.pharmacyControlledRegisterEntry.findMany({
          where: { organizationId, branchId: input.branchId },
          orderBy: { serial: 'asc' },
          include: {
            patient: { select: { displayName: true, cnic: true } },
            prescriber: true,
            prescription: true,
            medicine: { select: { productName: true, manufacturer: true } },
            line: { include: { medicine: true } },
            correctsEntry: { select: { serial: true } },
            refEntry: { select: { serial: true } },
            incidents: { include: { approvals: true } },
          },
        }),
        ctx.db.branchRegulatoryProfile.findFirst({
          where: {
            organizationId,
            branchId: input.branchId,
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          },
          orderBy: { effectiveFrom: 'desc' },
          select: {
            provinceCode: true,
            jurisdictionRuleSet: { select: ruleFields },
          },
        }),
      ]);
      // The guard uses the effective profile's pinned rules, even after a newer
      // provincial rule set is published. Branch metadata may also still use
      // the legacy two-letter province code.
      const provinceCode =
        profile?.provinceCode ??
        (branchProvinceCode.startsWith('PK-') ? branchProvinceCode : `PK-${branchProvinceCode}`);
      const ruleSet =
        profile?.jurisdictionRuleSet ??
        (await ctx.db.jurisdictionRuleSet.findFirst({
          where: {
            code: provinceCode,
            isPlaceholder: false,
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          },
          orderBy: { effectiveFrom: 'desc' },
          select: ruleFields,
        }));
      const pendingLegalReview = ruleSet
        ? [
            ruleSet.licenceCategories,
            ruleSet.permittedSchedules,
            ruleSet.pharmacistCoverageRule,
          ].some((field) => ruleSetOptions(field).provisional)
        : false;
      const witnessIds = [...new Set(entries.map((entry) => entry.witnessedByUserId))];
      const [witnesses, staff] = witnessIds.length
        ? await Promise.all([
            ctx.db.user.findMany({
              where: { organizationId, id: { in: witnessIds } },
              select: { id: true, name: true },
            }),
            ctx.db.restaurantStaffProfile.findMany({
              where: { organizationId, userId: { in: witnessIds } },
              select: { userId: true, displayName: true },
            }),
          ])
        : [[], []];
      const userNames = new Map(witnesses.map((user) => [user.id, user.name]));
      const staffNames = new Map<string, string[]>();
      for (const profile of staff) {
        if (!profile.userId) continue;
        const names = staffNames.get(profile.userId) ?? [];
        names.push(profile.displayName);
        staffNames.set(profile.userId, names);
      }
      return {
        pendingLegalReview,
        provinceName: provinceName(provinceCode),
        entries: entries.map((entry) => ({
          ...entry,
          patient: entry.patient
            ? { displayName: entry.patient.displayName, cnic: maskCnic(entry.patient.cnic) }
            : null,
          witnessName: chooseRegisterPersonName(
            [
              ...(staffNames.get(entry.witnessedByUserId) ?? []),
              userNames.get(entry.witnessedByUserId),
            ],
            entry.witnessedByUserId
          ),
        })),
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
          staffProfileId: z.string().min(1),
          pin: z.string().regex(/^\d{4,8}$/),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { organizationId } = await organizationBranch(ctx, input.branchId);
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
        if (error instanceof Error && error.message === 'CAP') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'That correction is larger than the original quantity.',
          });
        }
        if (error instanceof Error && error.message === 'ALREADY_CORRECTED') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'That register entry has already been corrected.',
          });
        }
        if (error instanceof Error && error.message === 'STOCK') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'That correction does not match the stock on hand.',
          });
        }
        if (error instanceof Error && error.message === 'CONFLICT') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'That register serial is already on this branch.',
          });
        }
        throw error;
      }
    }),
  createInspectionPack: safety
    .input(z.object({ branchId: z.string().min(1), from: z.date(), to: z.date() }).strict())
    .query(async ({ ctx, input }) => {
      if (input.from > input.to)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Inspection pack start must not follow its end.',
        });
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
  approveRegisterIncident: safety
    .input(z.object({ incidentId: z.string().min(1), reason: z.string().trim().min(1) }).strict())
    .mutation(({ ctx, input }) =>
      ctx.db.pharmacyRegisterIncidentApproval.create({
        data: { ...input, approvedByUserId: ctx.session!.user.id },
      })
    ),
});
