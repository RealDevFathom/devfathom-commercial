import { MenuExtractionError } from '@/lib/restaurant/menu-extraction';
import { StorageUnavailableError } from '@/lib/storage';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { router, capabilityProcedure } from '../trpc';
import { annotateAudit } from '../audit';
import {
  MenuImportError,
  getMenuImportAvailability,
  commitMenuImport,
  createMenuImport,
  discardMenuImport,
  getMenuImport,
  listMenuImports,
  reviewMenuImportLine,
  summarizeMenuImport,
} from '@/lib/restaurant/menu-import';
import {
  ALLOWED_MENU_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  MenuUploadError,
} from '@/lib/restaurant/menu-import-uploads';

/**
 * R-lane / WHA-194 — the OCR menu-import server surface.
 *
 * Every procedure gates on `menu:import` (default deny) and on the
 * `restaurant-menu` module. That is deliberately narrower than the rest of the
 * catalog surface: `menu:write` edits one dish, while one import writes products,
 * categories and draft prices in bulk from a file nobody in the building
 * authored.
 *
 * The audit trail is IDS ONLY. Extracted menu text is untrusted third-party
 * content, so it is never copied into an audit description — an audit log is
 * read by people and shipped to reviewers, and it is the last place that should
 * be repeating "ignore previous instructions" back at anyone. The evidence
 * recorded is what a reviewer decided and which rows it produced.
 */

const importProcedure = capabilityProcedure('menu:import');

/** Translate domain errors to tRPC status. Rethrows anything unrecognised. */
function mapMenuImportError(err: unknown): never {
  if (
    (err instanceof MenuExtractionError && err.reason === 'ADAPTER_UNAVAILABLE') ||
    err instanceof StorageUnavailableError
  ) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Menu uploads are unavailable.' });
  }
  if (err instanceof MenuImportError) {
    const code =
      err.reason === 'NOT_FOUND' || err.reason === 'MERGE_TARGET_NOT_FOUND'
        ? 'NOT_FOUND'
        : err.reason === 'INVALID_STATE' || err.reason === 'ALREADY_IMPORTED'
          ? 'CONFLICT'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  if (err instanceof MenuUploadError) {
    // Every upload rejection is the caller's to fix, including a type mismatch:
    // the client is told what the bytes actually were, not that it is suspected
    // of anything.
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  }
  throw err;
}

/**
 * Base64 is the transport for the upload because tRPC carries JSON. The cap is
 * applied to the DECODED length as well, inside `validateMenuUpload` — this
 * bound only stops an oversized payload before it is decoded.
 */
const BASE64_UPLOAD = z
  .string()
  .min(1)
  .max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 1_024, {
    message: 'The upload exceeds the maximum file size.',
  })
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'The upload must be base64-encoded.' });

const REVIEW_DECISION = z.enum(['ACCEPTED', 'REJECTED', 'MERGED']);

export const restaurantMenuImportRouter = router({
  /** The limits a client should enforce before it bothers uploading. */
  uploadLimits: importProcedure.query(() => ({
    ...getMenuImportAvailability(),
    maxBytes: MAX_UPLOAD_BYTES,
    allowedMimeTypes: [...ALLOWED_MENU_UPLOAD_TYPES],
  })),

  list: importProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(200).optional() })
        .strict()
        .optional()
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listMenuImports(ctx.db, { limit: input?.limit });
      } catch (err) {
        mapMenuImportError(err);
      }
    }),

  get: importProcedure
    .input(z.object({ importId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await getMenuImport(ctx.db, input.importId);
      } catch (err) {
        mapMenuImportError(err);
      }
    }),

  summary: importProcedure
    .input(z.object({ importId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await summarizeMenuImport(ctx.db, input.importId);
      } catch (err) {
        mapMenuImportError(err);
      }
    }),

  /**
   * Accept an upload and queue its extraction. Returns as soon as the file is
   * stored: extraction is a background job, so a slow provider never holds the
   * request open or times out a restaurant's browser.
   */
  upload: importProcedure
    .input(
      z
        .object({
          fileName: z.string().min(1).max(255),
          /** Base64 of the file. The bytes decide the type, not this field. */
          content: BASE64_UPLOAD,
          declaredMimeType: z.string().max(255).nullable().optional(),
          idempotencyKey: z.string().min(1).max(200).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.session.user.organizationId;
      if (!organizationId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'No organization is in scope.' });
      }
      try {
        const organization = await ctx.db.organization.findUnique({
          where: { id: organizationId },
          select: { currency: true },
        });
        const result = await createMenuImport(ctx.db, organizationId, {
          fileName: input.fileName,
          content: Buffer.from(input.content, 'base64'),
          declaredMimeType: input.declaredMimeType ?? null,
          createdById: ctx.session.user.id,
          defaultCurrency: organization?.currency ?? null,
          idempotencyKey: input.idempotencyKey,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantMenuImport',
          targetId: result.importId,
          description: result.deduplicated
            ? 'Resumed an existing menu import for an identical upload'
            : `Uploaded a menu for import (${result.pageCount} page(s))`,
        });
        return result;
      } catch (err) {
        mapMenuImportError(err);
      }
    }),

  /**
   * Record one reviewer decision: accept, accept-with-edits, reject, or merge
   * into an existing product. This is the mandatory human gate — `commit`
   * refuses while any line is still PENDING.
   */
  reviewLine: importProcedure
    .input(
      z
        .object({
          lineId: z.string().min(1),
          decision: REVIEW_DECISION,
          categoryName: z.string().max(200).nullable().optional(),
          productName: z.string().max(200).nullable().optional(),
          description: z.string().max(2_000).nullable().optional(),
          priceAmount: z.string().max(20).nullable().optional(),
          currency: z.string().length(3).nullable().optional(),
          note: z.string().max(1_000).nullable().optional(),
          mergeProductId: z.string().min(1).nullable().optional(),
          mergeVariantId: z.string().min(1).nullable().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const line = await reviewMenuImportLine(ctx.db, {
          ...input,
          reviewedById: ctx.session.user.id,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantMenuImportLine',
          targetId: line.id,
          // Ids and the decision only — never the extracted text.
          description: `Reviewed menu-import line as ${input.decision}`,
        });
        return {
          id: line.id,
          reviewStatus: line.reviewStatus,
          mergeProductId: line.mergeProductId,
          mergeVariantId: line.mergeVariantId,
          reviewedAt: line.reviewedAt,
        };
      } catch (err) {
        mapMenuImportError(err);
      }
    }),

  /**
   * Import the confirmed rows. One transaction, idempotent on replay, and it
   * never publishes: the menu is created without a branch publication and the
   * price-list version stays DRAFT.
   */
  commit: importProcedure
    .input(
      z
        .object({
          importId: z.string().min(1),
          menuName: z.string().min(1).max(200).optional(),
          effectiveFrom: z.coerce.date().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await commitMenuImport(ctx.db, {
          importId: input.importId,
          committedById: ctx.session.user.id,
          menuName: input.menuName,
          effectiveFrom: input.effectiveFrom,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantMenuImport',
          targetId: result.importId,
          description: result.alreadyCommitted
            ? 'Replayed an already-committed menu import; nothing was created'
            : `Imported a reviewed menu: ${result.createdProductIds.length} product(s) created, ` +
              `${result.mergedProductIds.length} merged, ${result.priceEntryIds.length} draft price(s)`,
          metadata: {
            menuId: result.menuId,
            priceListVersionId: result.priceListVersionId,
            createdProductIds: result.createdProductIds,
            createdCategoryIds: result.createdCategoryIds,
            mergedProductIds: result.mergedProductIds,
            priceEntryIds: result.priceEntryIds,
          },
        });
        return result;
      } catch (err) {
        mapMenuImportError(err);
      }
    }),

  /** Abandon an import and delete the uploaded file. Review rows are retained. */
  discard: importProcedure
    .input(z.object({ importId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await discardMenuImport(ctx.db, input.importId, ctx.session.user.id);
        annotateAudit(ctx, {
          targetType: 'RestaurantMenuImport',
          targetId: input.importId,
          description: result.alreadyDiscarded
            ? 'Menu import was already discarded'
            : 'Discarded a menu import and deleted the uploaded file',
        });
        return result;
      } catch (err) {
        mapMenuImportError(err);
      }
    }),
});
