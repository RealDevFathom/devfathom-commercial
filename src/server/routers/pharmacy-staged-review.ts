import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, capabilityProcedure, router, type TRPCContext } from '../trpc';
import {
  assertReviewBranch,
  listStagedMedicines,
  reviewBatchInput,
  reviewListInput,
  reviewScopeInput,
  stagedMedicineDetail,
} from '@/lib/pharmacy/migration/staged-review-read';
import { IMPORT_TARGET_FIELDS } from '@/lib/pharmacy/migration/header-synonyms';

const mappingSchema = z
  .record(z.string().min(1).max(200), z.enum(IMPORT_TARGET_FIELDS))
  .refine(
    (mapping) => new Set(Object.values(mapping)).size === Object.values(mapping).length,
    'Each target field can be mapped only once.'
  );
const presetId = z.object({ id: z.string().min(1).max(128) }).strict();

function organizationId(ctx: TRPCContext): string {
  const id = ctx.session?.user.organizationId;
  if (
    !id ||
    id !== ctx.entitlements.organizationId ||
    (ctx.organization && ctx.organization.id !== id)
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace scope mismatch.' });
  }
  return id;
}

/** Server-page caller only. Nesting preserves the existing pharmacy-core entitlement path. */
export const pharmacyStagedReviewRouter = router({
  importCore: router({
    /** Import operations use central can(); an explicit DENY wins over role grants. */
    batches: capabilityProcedure('pharmacy:data-import').query(({ ctx }) => {
      const org = organizationId(ctx);
      return ctx.db.pharmacyMigrationBatch.findMany({
        where: { organizationId: org, source: { organizationId: org } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          label: true,
          status: true,
          rowCount: true,
          exceptionCount: true,
          createdByUserId: true,
          source: { select: { fileName: true, contentHash: true, byteSize: true } },
        },
      });
    }),
    presets: capabilityProcedure('pharmacy:data-import').query(({ ctx }) => {
      const org = organizationId(ctx);
      return ctx.db.importMappingPreset.findMany({
        where: { organizationId: org },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, mapping: true, updatedAt: true },
      });
    }),
    savePreset: capabilityProcedure('pharmacy:data-import')
      .input(
        z
          .object({
            id: z.string().max(128).optional(),
            name: z.string().trim().min(1).max(80),
            mapping: mappingSchema,
          })
          .strict()
      )
      .mutation(({ ctx, input }) => {
        const org = organizationId(ctx);
        const actor = ctx.session!.user.id;
        return input.id
          ? ctx.db.importMappingPreset.update({
              where: { organizationId_id: { organizationId: org, id: input.id } },
              data: { name: input.name, mapping: input.mapping, updatedByUserId: actor },
              select: { id: true, name: true, mapping: true },
            })
          : ctx.db.importMappingPreset.create({
              data: {
                organizationId: org,
                name: input.name,
                mapping: input.mapping,
                createdByUserId: actor,
                updatedByUserId: actor,
              },
              select: { id: true, name: true, mapping: true },
            });
      }),
    deletePreset: capabilityProcedure('pharmacy:data-import')
      .input(presetId)
      .mutation(async ({ ctx, input }) => {
        const deleted = await ctx.db.importMappingPreset.deleteMany({
          where: { organizationId: organizationId(ctx), id: input.id },
        });
        if (deleted.count !== 1)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Mapping preset not found.' });
        return { deleted: true };
      }),
    preview: capabilityProcedure('pharmacy:data-import')
      .input(presetId)
      .query(async ({ ctx, input }) => {
        const org = organizationId(ctx);
        const batch = await ctx.db.pharmacyMigrationBatch.findFirst({
          where: { organizationId: org, id: input.id },
        });
        if (!batch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Import batch not found.' });
        const [entities, errors, dedupeMatches] = await Promise.all([
          ctx.db.pharmacyMigrationRow.groupBy({
            by: ['targetModelKey'],
            where: { organizationId: org, batchId: input.id },
            _count: { _all: true },
          }),
          ctx.db.pharmacyMigrationException.count({
            where: { organizationId: org, batchId: input.id, status: 'OPEN' },
          }),
          ctx.db.pharmacyMigrationException.count({
            where: { organizationId: org, batchId: input.id, bucket: 'DUPLICATE_PRODUCT' },
          }),
        ]);
        return {
          batch,
          errors,
          dedupeMatches,
          entities: entities.map((row) => ({ key: row.targetModelKey, count: row._count._all })),
        };
      }),
    queueCommit: capabilityProcedure('pharmacy:data-import')
      .input(presetId)
      .mutation(async ({ ctx, input }) => {
        const org = organizationId(ctx);
        const blocking = await ctx.db.pharmacyMigrationException.count({
          where: { organizationId: org, batchId: input.id, status: 'OPEN', severity: 'BLOCKING' },
        });
        if (blocking)
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Resolve blocking preview errors before commit.',
          });
        const queued = await ctx.db.pharmacyMigrationBatch.updateMany({
          where: { organizationId: org, id: input.id, status: 'PREVIEW' },
          data: { status: 'COMMITTING' },
        });
        if (queued.count !== 1)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Only a previewed batch can be committed.',
          });
        return { status: 'COMMITTING' as const };
      }),
  }),
  pharmacyMedicine: router({
    stagedBranches: adminProcedure.query(({ ctx }) =>
      ctx.db.pharmacyBranch.findMany({
        where: { organizationId: organizationId(ctx), active: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      })
    ),
    stagedBatches: adminProcedure
      .input(reviewScopeInput.extend({ page: z.number().int().min(1).max(10000).default(1) }))
      .query(async ({ ctx, input }) => {
        const org = organizationId(ctx);
        await assertReviewBranch(ctx.db, org, input.branchId);
        const where = { organizationId: org, source: { organizationId: org } };
        const total = await ctx.db.pharmacyMigrationBatch.count({ where });
        const batches = await ctx.db.pharmacyMigrationBatch.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 25,
          skip: (input.page - 1) * 25,
          select: {
            id: true,
            sourceId: true,
            label: true,
            status: true,
            rowCount: true,
            source: { select: { fileName: true, contentHash: true } },
          },
        });
        return { batches, total };
      }),
    stagedRows: adminProcedure
      .input(reviewListInput)
      .query(({ ctx, input }) => listStagedMedicines(ctx.db, organizationId(ctx), input)),
    stagedDetail: adminProcedure
      .input(reviewBatchInput.extend({ rowId: z.string().min(1).max(128) }).strict())
      .query(({ ctx, input }) => stagedMedicineDetail(ctx.db, organizationId(ctx), input)),
  }),
});
