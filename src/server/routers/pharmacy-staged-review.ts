import { annotateAudit } from '../audit';
import {
  stagingInput,
  stagingUploadInput,
  STAGING_FIELDS,
} from '@/lib/pharmacy/migration/staging-input';
import { OwnerImportError } from '@/lib/pharmacy/migration/owner-import-upload';
import { parseStagingUpload, stagingSourceBytes } from '@/lib/pharmacy/migration/staging-upload';
import { excelCsvProfiler } from '@/lib/pharmacy/migration/excel-csv-profiler';
import { profileTable } from '@/lib/pharmacy/migration/profiler';
import {
  hashSourceBytes,
  openExceptionCounts,
  persistProfile,
  recordSource,
} from '@/lib/pharmacy/migration/workbench';
import { applyLegacyControlledClass } from '@/lib/pharmacy/migration/legacy-controlled';
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

/**
 * A catalogue-sized batch (about 19,000 rows and their exceptions) is written in
 * one transaction; allow it longer than the 30 second request default.
 */
const STAGE_TRANSACTION = { maxWait: 10_000, timeout: 180_000 } as const;

/**
 * The batch's profiler version records the exact column mapping, so a batch
 * says which columns produced its rows and a re-run can be recognised.
 */
function stagingProfilerVersion(mapping: Record<string, number | undefined>) {
  const fields = Object.entries(mapping)
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([field, index]) => `${field}=${index}`)
    .join(',');
  return `manual-columns/3;${fields}`;
}

async function readUpload(input: {
  fileName: string;
  content: string;
  encoding?: 'identity' | 'gzip';
}) {
  try {
    const bytes = stagingSourceBytes(input);
    const table = await parseStagingUpload(input.fileName, bytes);
    const clash = table.headers.find((header) => RESERVED_HEADERS.includes(header.trim()));
    if (clash)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Rename the reserved column "${clash}" before staging this file.`,
      });
    return { table, bytes };
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
      const { table } = await readUpload(input);
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
      const { table, bytes } = await readUpload(input);
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
        version: stagingProfilerVersion(input.mapping),
        resolveColumns: () => input.mapping,
      };
      // DEV-912: with no quantity column there is nothing to count, so no packs-or-units choice.
      const quantityUnit = input.mapping.quantity === undefined ? null : input.quantityUnit!;
      const result = profileTable(profiler, table, { quantityUnit: quantityUnit ?? undefined });
      const saved = await ctx.db.$transaction(async (tx) => {
        // One stage per file, mapping and quantity choice: concurrent or repeated
        // submissions of the same handover wait here and replay the first batch.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pharmacy-migration-stage:${org}:${hashSourceBytes(bytes)}`}, 0))`;
        const source = await recordSource(tx, {
          kind: profiler.kind,
          fileName: input.fileName,
          bytes,
        });
        const [previous] = await tx.pharmacyMigrationBatch.findMany({
          where: {
            organizationId: org,
            sourceId: source.id,
            profilerVersion: profiler.version,
            quantityUnit,
            status: 'PROFILED',
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 1,
          select: { id: true, rowCount: true, exceptionCount: true },
        });
        if (previous) {
          // DEV-854 still applies on a replay: a medicine created since the first stage
          // must not escape the NARCOTICS rule. The flag only ever tightens.
          const replayLegacy = await applyLegacyControlledClass(tx, org, result.rows);
          return {
            sourceId: source.id,
            batchId: previous.id,
            rowCount: previous.rowCount,
            exceptionCount: previous.exceptionCount,
            buckets: await openExceptionCounts(tx as typeof ctx.db, previous.id),
            replayed: true,
            controlledFromClass: replayLegacy.controlledRows,
            controlledMedicineIds: replayLegacy.medicineIds,
            controlledSkippedCorrected: replayLegacy.skippedCorrectedRows,
          };
        }
        // Bind every row to the exact uploaded bytes, including repeated product names.
        for (const row of result.rows) {
          row.sourceKey = `sha256:${source.contentHash}:row:${row.rowNumber}`;
          row.rawPayload.__source_sha256 = source.contentHash;
          row.rawPayload.__source_row = String(row.rowNumber);
        }
        const persisted = await persistProfile(tx, {
          sourceId: source.id,
          label: input.fileName,
          profiler,
          result,
        });
        // DEV-854: a NARCOTICS-class row is imported as controlled, with no review hold.
        const legacy = await applyLegacyControlledClass(tx, org, result.rows);
        return {
          sourceId: source.id,
          ...persisted,
          replayed: false,
          controlledFromClass: legacy.controlledRows,
          controlledMedicineIds: legacy.medicineIds,
          controlledSkippedCorrected: legacy.skippedCorrectedRows,
        };
      }, STAGE_TRANSACTION);
      annotateAudit(ctx, {
        targetType: 'PharmacyMigrationBatch',
        targetId: saved.batchId,
        metadata: {
          quantityUnit,
          mapping: input.mapping,
          sourceId: saved.sourceId,
          rowCount: saved.rowCount,
          replayed: saved.replayed,
          controlledFromClass: saved.controlledFromClass,
          controlledMedicineIds: saved.controlledMedicineIds,
          controlledSkippedCorrected: saved.controlledSkippedCorrected,
        },
      });
      const { controlledMedicineIds, ...summary } = saved;
      return { ...summary, controlledMedicinesFlagged: controlledMedicineIds.length };
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
