import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, capabilityProcedure, router, type TRPCContext } from '../trpc';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  assertReviewBranch,
  listStagedMedicines,
  reviewBatchInput,
  reviewListInput,
  reviewScopeInput,
  stagedMedicineDetail,
} from '@/lib/pharmacy/migration/staged-review-read';
import {
  bindImportBranch,
  importBranchIds,
  inImportTransaction,
  PharmacyImportError,
  type ImportRequest,
} from '@/lib/pharmacy/migration/import-authority';
import { commitImportBatch, rollbackImportBatch } from '@/lib/pharmacy/migration/import-commit';
import {
  ASYNC_IMPORT_THRESHOLD_BYTES,
  ImportValidationError,
} from '@/lib/pharmacy/migration/import-core';
import { UnrecognisedSourceError } from '@/lib/pharmacy/migration/profiler';
import { importSourceFile, signOffException } from '@/lib/pharmacy/migration/workbench';

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

function importRequest(ctx: TRPCContext, branchId: string): ImportRequest {
  return {
    organizationId: organizationId(ctx),
    branchId,
    actor: { userId: ctx.session!.user.id, role: ctx.session!.user.role },
  };
}

/** Every refusal is an operator sentence with a stable code, never a 500. */
function failImport(error: unknown): never {
  if (error instanceof PharmacyImportError) {
    const code =
      error.reason === 'FORBIDDEN' || error.reason === 'BRANCH_OUT_OF_SCOPE'
        ? 'FORBIDDEN'
        : error.reason === 'BATCH_NOT_FOUND' ||
            error.reason === 'ROW_NOT_IN_BATCH' ||
            error.reason === 'EXCEPTION_NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'BATCH_NOT_PREVIEW' ||
              error.reason === 'BATCH_NOT_COMMITTED' ||
              error.reason === 'BATCH_ROLLED_BACK' ||
              error.reason === 'BATCH_LEGACY' ||
              error.reason === 'SUPPLIER_CONFLICT' ||
              error.reason === 'ROLLBACK_BLOCKED' ||
              error.reason === 'MANIFEST_INCONSISTENT'
            ? 'CONFLICT'
            : 'BAD_REQUEST';
    throw new TRPCError({
      code,
      message: error.details.length ? `${error.message} ${error.details.join(' ')}` : error.message,
      cause: error,
    });
  }
  if (error instanceof ImportValidationError || error instanceof UnrecognisedSourceError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  throw error;
}

const id = z.string().trim().min(1).max(128);
const branchScope = z.object({ branchId: id });
const money = z.number().int().nonnegative().max(2_147_483_647);
const commitInstruction = z.discriminatedUnion('kind', [
  z
    .object({ rowId: id, kind: z.literal('SUPPLIER'), name: z.string().trim().min(1).max(200) })
    .strict(),
  z
    .object({
      rowId: id,
      kind: z.literal('OPENING_STOCK'),
      manufacturingBatchId: id,
      packLevelId: id,
      stockLocationId: id,
      unitsPerPack: z.number().int().positive().max(2_147_483_647),
      quantityUnits: z.number().int().positive().max(2_147_483_647),
      unitCostMinor: money,
      printedMrpMinor: money,
    })
    .strict(),
]);
/** base64 of a file below the async threshold. */
const contentBase64 = z
  .string()
  .max(Math.ceil(ASYNC_IMPORT_THRESHOLD_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

/** Server-page caller only. Nesting preserves the existing pharmacy-core entitlement path. */
export const pharmacyStagedReviewRouter = router({
  importCore: router({
    /**
     * Batches in every branch the actor may import into. Import operations use central can();
     * an explicit DENY wins over role grants. The branch-scoped policies need one binding per
     * branch, so each branch is read under its own binding inside one transaction.
     */
    batches: capabilityProcedure('pharmacy:data-import').query(async ({ ctx }) => {
      const org = organizationId(ctx);
      const actor = { userId: ctx.session!.user.id, role: ctx.session!.user.role };
      const branches = await importBranchIds(ctx.db, { organizationId: org, actor });
      const perBranch = await inImportTransaction(ctx.db, async (tx: ScopedDb) => {
        const out = [];
        for (const branchId of branches) {
          await bindImportBranch(tx, { organizationId: org, branchId, actor });
          out.push(
            ...(await tx.pharmacyMigrationBatch.findMany({
              where: { organizationId: org, branchId, legacy: false },
              select: {
                id: true,
                branchId: true,
                label: true,
                status: true,
                rowCount: true,
                exceptionCount: true,
                createdByUserId: true,
                committedAt: true,
                rolledBackAt: true,
                createdAt: true,
                source: { select: { fileName: true, contentHash: true, byteSize: true } },
              },
            }))
          );
        }
        return out;
      });
      return perBranch.sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)
      );
    }),
    /** Upload and preview a file below the async threshold. Writes staging only, never live data. */
    upload: capabilityProcedure('pharmacy:data-import')
      .input(
        branchScope
          .extend({
            kind: z.enum(['EXCEL_CSV', 'ABUZAR']),
            fileName: z.string().trim().min(1).max(255),
            label: z.string().trim().min(1).max(120),
            contentBase64,
          })
          .strict()
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await importSourceFile(ctx.db, importRequest(ctx, input.branchId), {
            kind: input.kind,
            fileName: input.fileName,
            label: input.label,
            bytes: new Uint8Array(Buffer.from(input.contentBase64, 'base64')),
          });
        } catch (error) {
          failImport(error);
        }
      }),
    signOffException: capabilityProcedure('pharmacy:data-import')
      .input(
        branchScope
          .extend({ exceptionId: id, note: z.string().trim().max(500).optional() })
          .strict()
      )
      .mutation(async ({ ctx, input }) => {
        try {
          await signOffException(ctx.db, importRequest(ctx, input.branchId), {
            exceptionId: input.exceptionId,
            note: input.note,
          });
          return { signedOff: true };
        } catch (error) {
          failImport(error);
        }
      }),
    commit: capabilityProcedure('pharmacy:data-import')
      .input(
        branchScope
          .extend({ batchId: id, instructions: z.array(commitInstruction).min(1).max(5_000) })
          .strict()
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await commitImportBatch(ctx.db, importRequest(ctx, input.branchId), {
            batchId: input.batchId,
            instructions: input.instructions,
          });
        } catch (error) {
          failImport(error);
        }
      }),
    rollback: capabilityProcedure('pharmacy:data-import')
      .input(
        branchScope.extend({ batchId: id, reason: z.string().trim().min(10).max(500) }).strict()
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await rollbackImportBatch(ctx.db, importRequest(ctx, input.branchId), {
            batchId: input.batchId,
            reason: input.reason,
          });
        } catch (error) {
          failImport(error);
        }
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
        return inImportTransaction(ctx.db, async (tx) => {
          await assertReviewBranch(tx, org, input.branchId);
          const where = {
            organizationId: org,
            branchId: input.branchId,
            source: { organizationId: org, branchId: input.branchId },
          };
          const total = await tx.pharmacyMigrationBatch.count({ where });
          const batches = await tx.pharmacyMigrationBatch.findMany({
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
        });
      }),
    stagedRows: adminProcedure
      .input(reviewListInput)
      .query(({ ctx, input }) => listStagedMedicines(ctx.db, organizationId(ctx), input)),
    stagedDetail: adminProcedure
      .input(reviewBatchInput.extend({ rowId: z.string().min(1).max(128) }).strict())
      .query(({ ctx, input }) => stagedMedicineDetail(ctx.db, organizationId(ctx), input)),
  }),
});
