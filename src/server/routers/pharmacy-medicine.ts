import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import {
  assertSaleable,
  deriveLooseUnitPrice,
  medicineDuplicateKey,
  normalizeMedicineText,
  PharmacyMedicineError,
} from '@/lib/pharmacy/medicine';
import { auditedProtectedProcedure, protectedProcedure, router } from '../trpc';

const family = z.enum(['PHARMACEUTICAL', 'BIOLOGICAL', 'DEVICE', 'ALTERNATIVE', 'FRONT_SHOP']);
const provenance = z
  .object({
    field: z.string().min(1).max(100),
    source: z.string().min(1).max(500),
    sourceType: z.enum(['REGULATOR', 'MANUFACTURER', 'SCRAPED', 'USER', 'IMPORT']),
    retrievedAt: z.date(),
    confidence: z.number().min(0).max(1).optional(),
    reviewer: z.string().max(200).optional(),
    status: z.enum(['UNREVIEWED', 'ACCEPTED', 'CORRECTED', 'REJECTED']),
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
              input.provenance
                .filter((p) => p.status === 'ACCEPTED' || p.status === 'CORRECTED')
                .map((p) => p.field)
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

  addBarcode: protectedProcedure
    .input(
      z
        .object({
          presentationId: z.string().min(1),
          packLevelId: z.string().min(1).optional(),
          type: z.enum(['GTIN', 'MANUFACTURER', 'INTERNAL']),
          code: z.string().trim().min(1).max(200),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.medicineBarcode.create({
        data: { ...input, normalizedCode: normalizeMedicineText(input.code) },
      })
    ),

  addAlias: protectedProcedure
    .input(
      z
        .object({
          medicineId: z.string().min(1),
          type: z.enum(['BRAND', 'GENERIC', 'URDU', 'TRANSLITERATION', 'LEGACY_CODE']),
          value: z.string().trim().min(1).max(300),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.medicineAlias.create({
        data: { ...input, normalizedValue: normalizeMedicineText(input.value) },
      })
    ),

  resolveScan: auditedProtectedProcedure
    .input(z.object({ code: z.string().trim().min(1).max(200) }).strict())
    .query(async ({ ctx, input }) => {
      const matches = await ctx.db.medicineBarcode.findMany({
        where: { normalizedCode: normalizeMedicineText(input.code) },
        include: { presentation: true, packLevel: true },
      });
      const targets = matches.map(({ presentation, packLevel }) => ({ presentation, packLevel }));
      if (targets.length === 0) {
        const legacyMatches = await ctx.db.medicineAlias.findMany({
          where: { type: 'LEGACY_CODE', normalizedValue: normalizeMedicineText(input.code) },
          include: { medicine: { include: { presentations: { include: { packLevels: true } } } } },
        });
        for (const alias of legacyMatches) {
          for (const presentation of alias.medicine.presentations) {
            const currentLevels = presentation.packLevels.filter(
              (level) => level.effectiveTo === null
            );
            if (currentLevels.length === 0) targets.push({ presentation, packLevel: null });
            else
              targets.push(
                ...currentLevels.map((packLevel) => ({
                  presentation,
                  packLevel,
                }))
              );
          }
        }
      }
      if (targets.length === 0)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Scan code not found.' });
      return targets.length === 1
        ? { kind: 'resolved' as const, target: targets[0] }
        : { kind: 'disambiguation' as const, targets };
    }),

  search: auditedProtectedProcedure
    .input(
      z
        .object({
          query: z.string().trim().min(1).max(200),
          limit: z.number().int().min(1).max(100).default(25),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const query = normalizeMedicineText(input.query);
      const ids = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT DISTINCT medicine.id
           FROM pharmacy_medicines medicine
           LEFT JOIN pharmacy_presentations presentation ON presentation."medicineId" = medicine.id
           LEFT JOIN pharmacy_medicine_strength_components strength ON strength."medicineId" = medicine.id
           LEFT JOIN pharmacy_ingredients ingredient ON ingredient.id = strength."ingredientId"
           LEFT JOIN pharmacy_medicine_aliases alias ON alias."medicineId" = medicine.id
          WHERE pharmacy_normalize_catalog_text(coalesce(medicine."productName",'')) % $1
             OR pharmacy_normalize_catalog_text(coalesce(medicine."brandName",'')) % $1
             OR pharmacy_normalize_catalog_text(coalesce(ingredient.name,'')) % $1
             OR pharmacy_normalize_catalog_text(coalesce(strength.value::text,'') || coalesce(strength.unit,'')) % $1
             OR pharmacy_normalize_catalog_text(coalesce(presentation."dosageForm",'')) % $1
             OR coalesce(alias."normalizedValue",'') % $1
             OR coalesce(alias."normalizedValue",'') = $1
          ORDER BY medicine.id LIMIT $2`,
        query,
        input.limit
      );
      return ctx.db.medicine.findMany({
        where: { id: { in: ids.map(({ id }) => id) } },
        include: {
          aliases: true,
          strengths: { include: { ingredient: true } },
          presentations: true,
        },
      });
    }),

  duplicateGroups: auditedProtectedProcedure.query(async ({ ctx }) => {
    const medicines = await ctx.db.medicine.findMany({
      include: { strengths: true, presentations: true, aliases: true, provenance: true },
    });
    const groups = new Map<string, typeof medicines>();
    for (const medicine of medicines) {
      const key = medicineDuplicateKey({
        productName: medicine.productName,
        strengths: medicine.strengths.map((strength) => ({
          value: String(strength.value),
          unit: strength.unit,
        })),
        dosageForm: medicine.presentations[0]?.dosageForm,
      });
      groups.set(key, [...(groups.get(key) ?? []), medicine]);
    }
    return [...groups.entries()]
      .filter(([, candidates]) => candidates.length > 1)
      .map(([duplicateKey, candidates]) => ({ duplicateKey, candidates }));
  }),

  recordReviewDecision: protectedProcedure
    .input(
      z
        .object({
          duplicateKey: z.string().min(1).max(700),
          action: z.enum(['ACCEPT', 'CORRECT', 'SPLIT', 'MERGE', 'REJECT', 'DEFER']),
          medicineIds: z.array(z.string().min(1)).min(1),
          payload: z.json().optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.medicineReviewDecision.create({
        data: {
          ...input,
          payload:
            input.payload === null
              ? Prisma.JsonNull
              : (input.payload as Prisma.InputJsonValue | undefined),
          reviewerId: ctx.session.user.id,
        },
      })
    ),

  publishAssertions: protectedProcedure
    .input(z.object({ assertionIds: z.array(z.string().min(1)).min(1) }).strict())
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const assertions = await tx.medicineProvenance.findMany({
          where: { id: { in: input.assertionIds } },
        });
        if (assertions.length !== new Set(input.assertionIds).size)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Assertion not found.' });
        const batch = await tx.medicinePublicationBatch.create({
          data: { status: 'PUBLISHED', publishedBy: ctx.session.user.id, publishedAt: new Date() },
        });
        await tx.medicinePublicationEntry.createMany({
          data: assertions.map((assertion) => ({
            batchId: batch.id,
            assertionId: assertion.id,
            priorAssertionId: assertion.supersedesId,
          })),
        });
        return batch;
      })
    ),

  supersedePublication: protectedProcedure
    .input(z.object({ batchId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const published = await tx.medicinePublicationBatch.findFirst({
          where: { id: input.batchId, status: 'PUBLISHED' },
          include: { entries: true },
        });
        if (!published)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Published batch not found.' });
        const reversal = await tx.medicinePublicationBatch.create({
          data: {
            status: 'SUPERSEDED',
            supersedesId: published.id,
            publishedBy: ctx.session.user.id,
            publishedAt: new Date(),
          },
        });
        for (const entry of published.entries) {
          if (!entry.priorAssertionId) continue;
          const [current, prior] = await Promise.all([
            tx.medicineProvenance.findUniqueOrThrow({ where: { id: entry.assertionId } }),
            tx.medicineProvenance.findUniqueOrThrow({ where: { id: entry.priorAssertionId } }),
          ]);
          const restored = await tx.medicineProvenance.create({
            data: {
              medicineId: current.medicineId,
              field: current.field,
              source: prior.source,
              sourceType: prior.sourceType,
              retrievedAt: new Date(),
              confidence: prior.confidence,
              reviewer: ctx.session.user.id,
              status: 'CORRECTED',
              assertedValue: prior.assertedValue ?? undefined,
              supersedesId: current.id,
            },
          });
          await tx.medicinePublicationEntry.create({
            data: { batchId: reversal.id, assertionId: restored.id, priorAssertionId: current.id },
          });
        }
        return reversal;
      })
    ),
});
