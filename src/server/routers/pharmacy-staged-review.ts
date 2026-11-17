import { annotateAudit } from '../audit';
import {
  stagingInput,
  stagingUploadInput,
  STAGING_FIELDS,
} from '@/lib/pharmacy/migration/staging-input';
import { OwnerImportError, parseOwnerUpload } from '@/lib/pharmacy/migration/owner-import-upload';
import { excelCsvProfiler } from '@/lib/pharmacy/migration/excel-csv-profiler';
import { profileTable } from '@/lib/pharmacy/migration/profiler';
import { recordSource, persistProfile } from '@/lib/pharmacy/migration/workbench';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, router, type TRPCContext } from '../trpc';
import {
  assertReviewBranch,
  listStagedMedicines,
  reviewBatchInput,
  reviewListInput,
  reviewScopeInput,
  stagedMedicineDetail,
} from '@/lib/pharmacy/migration/staged-review-read';

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

/** Headers the staging path writes itself; an upload may not shadow its own lineage evidence. */
const RESERVED_HEADERS = ['__source_sha256', '__source_row', '__review_flags'];

async function readUpload(input: { fileName: string; content: string }) {
  try {
    const table = await parseOwnerUpload(input.fileName, Buffer.from(input.content, 'base64'));
    const clash = table.headers.find((header) => RESERVED_HEADERS.includes(header.trim()));
    if (clash)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Rename the reserved column "${clash}" before staging this file.`,
      });
    return table;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (error instanceof OwnerImportError)
      throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
    throw error;
  }
}

/** Server-page/action caller only. Nesting preserves the existing pharmacy-core entitlement path. */
export const pharmacyStagedReviewRouter = router({
  pharmacyMedicine: router({
    stagingUpload: adminProcedure.input(stagingUploadInput).mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      await assertReviewBranch(ctx.db, organizationId(ctx), input.branchId);
      const table = await readUpload(input);
      const suggested = excelCsvProfiler.resolveColumns(table) ?? {};
      const mapping = Object.fromEntries(
        STAGING_FIELDS.flatMap(([field]) =>
          suggested[field] === undefined ? [] : [[field, suggested[field]]]
        )
      );
      return { headers: [...table.headers], rowCount: table.rows.length, mapping };
    }),
    stageBatch: adminProcedure.input(stagingInput).mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      const org = organizationId(ctx);
      await assertReviewBranch(ctx.db, org, input.branchId);
      const table = await readUpload(input);
      const indices = Object.values(input.mapping).filter(
        (index): index is number => index !== undefined
      );
      if (
        new Set(indices).size !== indices.length ||
        indices.some((index) => index >= table.headers.length)
      )
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Map each field to a distinct column in this file.',
        });
      const profiler = {
        ...excelCsvProfiler,
        version: 'manual-columns/2',
        resolveColumns: () => input.mapping,
      };
      const result = profileTable(profiler, table, { quantityUnit: input.quantityUnit });
      const saved = await ctx.db.$transaction(async (tx) => {
        const source = await recordSource(tx, {
          kind: profiler.kind,
          fileName: input.fileName,
          bytes: Buffer.from(input.content, 'base64'),
        });
        // Bind every row to the exact uploaded bytes, including repeated product names.
        for (const row of result.rows) {
          row.sourceKey = `sha256:${source.contentHash}:row:${row.rowNumber}`;
          row.rawPayload.__source_sha256 = source.contentHash;
          row.rawPayload.__source_row = String(row.rowNumber);
        }
        return {
          sourceId: source.id,
          ...(await persistProfile(tx, {
            sourceId: source.id,
            label: input.fileName,
            profiler,
            result,
          })),
        };
      });
      annotateAudit(ctx, {
        targetType: 'PharmacyMigrationBatch',
        targetId: saved.batchId,
        metadata: {
          quantityUnit: input.quantityUnit,
          mapping: input.mapping,
          sourceId: saved.sourceId,
        },
      });
      return saved;
    }),
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
