import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import sharp from 'sharp';
import { z } from 'zod';
import {
  configuredPackLabelOcrAdapterName,
  PackLabelOcrError,
  proposePackLabelFields,
  resolvePackLabelOcrAdapter,
  type PackLabelOcrAdapter,
  type PackLabelProposal,
} from '@/lib/pharmacy/pack-label-ocr';
import {
  assertSingleFrameImage,
  decodeBoundedImageBase64,
  MAX_PRESCRIPTION_FILE_BYTES,
} from '@/lib/pharmacy/prescription-files';
import { actorCanProcure } from '@/lib/pharmacy/procurement-access';
import { rateLimit } from '@/lib/rate-limit';
import { annotateAudit } from '../audit';
import { auditedProtectedProcedure, publicProcedure, router } from '../trpc';

/**
 * DEV-752: read batch and expiry off ONE photographed medicine pack while
 * receiving against a purchase-order line. The result is a PROPOSAL the
 * receiver edits and confirms into the existing capture fields; nothing here
 * drafts a goods receipt, touches stock, prices or the medicine register.
 *
 * Medicine, pack and conversion come from the purchase-order line the receiver
 * chose, never from the photo. The photo is validated, stripped of metadata,
 * sent to the configured reader and then dropped: it is never stored and never
 * written to the audit log (only its hash and size are).
 */

const MAX_PHOTO_BASE64 = 4 * Math.ceil(MAX_PRESCRIPTION_FILE_BYTES / 3);
/** Longest edge sent to the reader. Enough for a batch print; bounds provider cost. */
const READER_MAX_EDGE = 2000;
/** Per-user reads per minute. A bench photographs packs one at a time. */
export const PACK_LABEL_READS_PER_MINUTE = 20;
/** Tenant-wide ceiling, so many receivers cannot multiply provider spend. */
export const PACK_LABEL_TENANT_READS_PER_MINUTE = 60;

const NOT_READ = 'The pack photo could not be read. Enter the batch and expiry by hand.';

export const packLabelReadInput = z
  .object({
    branchId: z.string().trim().min(1).max(200),
    purchaseOrderId: z.string().trim().min(1).max(200),
    purchaseOrderLineId: z.string().trim().min(1).max(200),
    photo: z
      .object({
        contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        dataBase64: z.string().min(1).max(MAX_PHOTO_BASE64),
      })
      .strict(),
  })
  .strict();

/** Test seam: the adapter a read uses. Production resolves it from the environment. */
export const packLabelAdapterSeam: {
  resolve: () => PackLabelOcrAdapter | null;
} = {
  resolve() {
    const name = configuredPackLabelOcrAdapterName();
    return name ? resolvePackLabelOcrAdapter(name) : null;
  },
};

// The photo must never reach an audit row, including denied or malformed
// requests, so input capture is switched off before authentication runs.
const packPhotoProcedure = publicProcedure
  .use(({ ctx, next }) => {
    ctx.audit.detail.skipInput = true;
    return next();
  })
  .concat(auditedProtectedProcedure);

/** Re-encode: drops EXIF/GPS and any trailing payload, bounds the pixels sent out. */
async function readerImage(bytes: Buffer): Promise<Buffer> {
  try {
    return await sharp(bytes, { limitInputPixels: 25_000_000, failOn: 'warning' })
      .rotate()
      // JPEG has no alpha: a transparent label would otherwise turn black.
      .flatten({ background: '#ffffff' })
      .resize({
        width: READER_MAX_EDGE,
        height: READER_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: NOT_READ });
  }
}

export const pharmacyPackLabelRouter = router({
  read: packPhotoProcedure
    .input(packLabelReadInput)
    .mutation(async ({ ctx, input }): Promise<PackLabelProposal> => {
      const organizationId = ctx.entitlements.organizationId;
      const actorId = ctx.session.user.id;
      if (!organizationId || !(await actorCanProcure(ctx.db, actorId))) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission for this action.',
        });
      }

      // The line is the authority for what is being received. It must be on an
      // order of this tenant that is out for delivery to this branch.
      const line = await ctx.db.pharmacyPurchaseOrderLine.findFirst({
        where: {
          id: input.purchaseOrderLineId,
          purchaseOrderId: input.purchaseOrderId,
          organizationId,
        },
        select: {
          id: true,
          medicineId: true,
          packLevelId: true,
          purchaseOrder: { select: { branchId: true, status: true } },
        },
      });
      const order = line?.purchaseOrder;
      if (
        !line ||
        !order ||
        (order.branchId !== null && order.branchId !== input.branchId) ||
        (order.status !== 'SENT' && order.status !== 'RECEIVING')
      ) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'That order line is not open for receiving at this branch. Reload the page.',
        });
      }
      const branch = await ctx.db.pharmacyBranch.findFirst({
        where: { id: input.branchId, organizationId, active: true },
        select: { id: true },
      });
      if (!branch) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That branch is not available.' });
      }

      const adapter = packLabelAdapterSeam.resolve();
      if (!adapter) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'Reading pack photos is not enabled for this workspace. Enter the batch and expiry by hand.',
        });
      }

      const limited = await rateLimit(
        `pharmacy-pack-label:${organizationId}:${actorId}`,
        PACK_LABEL_READS_PER_MINUTE,
        60_000
      );
      const tenantLimited = limited.ok
        ? await rateLimit(
            `pharmacy-pack-label:org:${organizationId}`,
            PACK_LABEL_TENANT_READS_PER_MINUTE,
            60_000
          )
        : limited;
      if (!tenantLimited.ok) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many pack photos in a minute. Wait a moment, or enter the values by hand.',
        });
      }

      const bytes = decodeBoundedImageBase64(input.photo.dataBase64);
      await assertSingleFrameImage(bytes, input.photo.contentType);
      const photoSha256 = createHash('sha256').update(bytes).digest('hex');
      const content = await readerImage(bytes);

      let proposal: PackLabelProposal;
      try {
        proposal = proposePackLabelFields(
          await adapter.extract({ content, mimeType: 'image/jpeg', organizationId })
        );
      } catch (error) {
        const reason = error instanceof PackLabelOcrError ? error.reason : 'UNKNOWN';
        // Reason and adapter only: provider text can echo label content.
        console.error('[pharmacyPackLabel.read] reader failed', { adapter: adapter.name, reason });
        annotateAudit(ctx, {
          category: 'pharmacy.receiving',
          action: 'pack_label.read_failed',
          targetType: 'PharmacyPurchaseOrderLine',
          targetId: line.id,
          metadata: {
            branchId: input.branchId,
            purchaseOrderId: input.purchaseOrderId,
            photoSha256,
            photoBytes: bytes.length,
            adapter: adapter.name,
            reason,
          },
        });
        // Provider detail stays server-side; the bench gets an operator sentence.
        throw new TRPCError({
          code:
            error instanceof PackLabelOcrError && error.reason === 'ADAPTER_UNAVAILABLE'
              ? 'PRECONDITION_FAILED'
              : 'BAD_GATEWAY',
          message: NOT_READ,
          cause: error,
        });
      }

      annotateAudit(ctx, {
        category: 'pharmacy.receiving',
        action: 'pack_label.read',
        description: 'Pack photo read as a receiving suggestion. Nothing was posted.',
        targetType: 'PharmacyPurchaseOrderLine',
        targetId: line.id,
        metadata: {
          branchId: input.branchId,
          purchaseOrderId: input.purchaseOrderId,
          medicineId: line.medicineId,
          packLevelId: line.packLevelId,
          photoSha256,
          photoBytes: bytes.length,
          adapter: proposal.adapter,
          adapterVersion: proposal.adapterVersion,
          suggestedBatch: proposal.batch.value,
          suggestedExpiry: proposal.expiry.printed,
          expiryKind: proposal.expiry.kind,
          warnings: proposal.warnings.map((warning) => warning.code),
        },
      });
      return proposal;
    }),
});
