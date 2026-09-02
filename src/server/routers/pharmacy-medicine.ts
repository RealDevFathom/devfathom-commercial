import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  assertSaleable,
  deriveLooseUnitPrice,
  PharmacyMedicineError,
} from '@/lib/pharmacy/medicine';
import { auditedProtectedProcedure, protectedProcedure, router } from '../trpc';

const family = z.enum(['PHARMACEUTICAL', 'BIOLOGICAL', 'DEVICE', 'ALTERNATIVE', 'FRONT_SHOP']);
const provenance = z
  .object({
    field: z.string().min(1).max(100),
    source: z.string().min(1).max(500),
    retrievedAt: z.date(),
    confidence: z.number().min(0).max(1).optional(),
    reviewer: z.string().max(200).optional(),
    status: z.enum(['PENDING', 'VERIFIED', 'REJECTED']),
    assertedValue: z.unknown().optional(),
  })
  .strict();

function domainError(error: unknown): never {
  if (error instanceof PharmacyMedicineError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CROSS_TENANT_REFERENCE'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.message,
    });
  }
  throw error;
}

export const pharmacyMedicineRouter = router({
  createIngredient: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(200) }).strict())
    .mutation(({ ctx, input }) => ctx.db.ingredient.create({ data: input })),

  createMedicine: protectedProcedure
    .input(
      z
        .object({
          productName: z.string().trim().min(1).max(300),
          brandName: z.string().trim().max(300).optional(),
          manufacturer: z.string().trim().max(300).optional(),
          marketingAuthorizationHolder: z.string().trim().max(300).optional(),
          drapRegistrationNumber: z.string().trim().max(100).optional(),
          drapRegistrationStatus: z.string().trim().max(100).optional(),
          drapRegisteredAt: z.date().optional(),
          productFamily: family,
          rx: z.boolean().optional(),
          otc: z.boolean().optional(),
          restricted: z.boolean().optional(),
          controlled: z.boolean().optional(),
          highAlert: z.boolean().optional(),
          lasa: z.boolean().optional(),
          coldChain: z.boolean().optional(),
          presentation: z
            .object({
              dosageForm: z.string().max(100).optional(),
              route: z.string().max(100).optional(),
              presentation: z.string().min(1).max(300),
            })
            .optional(),
          strengths: z
            .array(
              z
                .object({
                  ingredientId: z.string().min(1),
                  value: z.number().positive(),
                  unit: z.string().trim().min(1).max(50),
                })
                .strict()
            )
            .default([]),
          provenance: z.array(provenance).default([]),
          saleable: z.boolean().default(false),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        if (input.saleable)
          assertSaleable({
            productFamily: input.productFamily,
            hasPresentation: Boolean(input.presentation),
            hasStrength: input.strengths.length > 0,
            hasRegistration: Boolean(input.drapRegistrationNumber),
            provenanceFields: new Set(
              input.provenance.filter((p) => p.status === 'VERIFIED').map((p) => p.field)
            ),
          });
        for (const component of input.strengths) {
          if (!(await ctx.db.ingredient.findFirst({ where: { id: component.ingredientId } }))) {
            throw new PharmacyMedicineError('CROSS_TENANT_REFERENCE');
          }
        }
        const { presentation, strengths, provenance: assertions, ...medicine } = input;
        return await ctx.db.medicine.create({
          data: {
            ...medicine,
            presentations: presentation ? { create: presentation } : undefined,
            strengths: { create: strengths },
            provenance: {
              create: assertions.map((item) => ({
                ...item,
                assertedValue: item.assertedValue ?? undefined,
              })),
            },
          },
          include: { strengths: true, presentations: true, provenance: true },
        });
      } catch (error) {
        domainError(error);
      }
    }),

  get: auditedProtectedProcedure
    .input(z.object({ id: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const medicine = await ctx.db.medicine.findFirst({
        where: { id: input.id },
        include: {
          strengths: { include: { ingredient: true } },
          presentations: { include: { packLevels: true } },
          provenance: true,
        },
      });
      if (!medicine) throw new TRPCError({ code: 'NOT_FOUND', message: 'Medicine not found.' });
      return medicine;
    }),

  createPackLevel: protectedProcedure
    .input(
      z
        .object({
          presentationId: z.string().min(1),
          parentPackLevelId: z.string().min(1).optional(),
          versionGroupId: z.string().min(1),
          level: z.enum(['CARTON', 'BOX', 'STRIP', 'UNIT']),
          unitsPerParent: z.number().int().positive(),
          effectiveFrom: z.date(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      if (!(await ctx.db.presentation.findFirst({ where: { id: input.presentationId } })))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Presentation is outside this workspace.',
        });
      if (
        input.parentPackLevelId &&
        !(await ctx.db.packLevel.findFirst({
          where: { id: input.parentPackLevelId, presentationId: input.presentationId },
        }))
      )
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Parent pack is outside this presentation.',
        });
      return ctx.db.packLevel.create({ data: { ...input, version: 1 } });
    }),

  revisePackLevel: protectedProcedure
    .input(
      z
        .object({
          id: z.string().min(1),
          unitsPerParent: z.number().int().positive(),
          effectiveFrom: z.date(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const current = await tx.packLevel.findFirst({ where: { id: input.id } });
        if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pack level not found.' });
        await tx.packLevel.update({
          where: { id: current.id },
          data: { effectiveTo: input.effectiveFrom },
        });
        return tx.packLevel.create({
          data: {
            presentationId: current.presentationId,
            parentPackLevelId: current.parentPackLevelId,
            versionGroupId: current.versionGroupId,
            version: current.version + 1,
            level: current.level,
            unitsPerParent: input.unitsPerParent,
            effectiveFrom: input.effectiveFrom,
            supersedesPackLevelId: current.id,
          },
        });
      })
    ),

  recordPrintedMrp: protectedProcedure
    .input(
      z
        .object({
          packLevelId: z.string().min(1),
          batchReference: z.string().min(1).max(200),
          printedMrpMinor: z.number().int().nonnegative(),
          roundingIncrementMinor: z.number().int().positive().default(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      if (!(await ctx.db.packLevel.findFirst({ where: { id: input.packLevelId } })))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Pack level is outside this workspace.',
        });
      return ctx.db.medicinePackMrp.create({ data: input });
    }),

  deriveLooseUnitPrice: auditedProtectedProcedure
    .input(
      z
        .object({ mrpId: z.string().min(1), canonicalUnitsInPack: z.number().int().positive() })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const mrp = await ctx.db.medicinePackMrp.findFirst({ where: { id: input.mrpId } });
      if (!mrp) throw new TRPCError({ code: 'NOT_FOUND', message: 'Printed MRP not found.' });
      return deriveLooseUnitPrice({
        printedMrpMinor: mrp.printedMrpMinor,
        canonicalUnitsInPack: input.canonicalUnitsInPack,
        roundingIncrementMinor: mrp.roundingIncrementMinor,
      });
    }),
});
