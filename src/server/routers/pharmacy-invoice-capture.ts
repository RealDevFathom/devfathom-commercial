import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import sharp from 'sharp';
import { z } from 'zod';
import {
  choosePrintedPack,
  configuredInvoiceCaptureAdapterName,
  InvoiceCaptureError,
  MAX_INVOICE_LINES,
  proposeInvoiceCapture,
  resolveInvoiceCaptureAdapter,
  type InvoiceCaptureAdapter,
  type InvoiceCaptureProposal,
  type InvoiceExtraction,
  type InvoiceLineContext,
} from '@/lib/pharmacy/invoice-capture';
import { packConversions, type PackLevelNode } from '@/lib/pharmacy/pack-conversion';
import {
  assertSingleFrameImage,
  decodeBoundedImageBase64,
  MAX_PRESCRIPTION_FILE_BYTES,
} from '@/lib/pharmacy/prescription-files';
import { actorCanProcure } from '@/lib/pharmacy/procurement-access';
import { findDuplicateSupplierInvoice } from '@/lib/pharmacy/supplier-invoice-duplicate';
import { rateLimit } from '@/lib/rate-limit';
import { countPdfPages, sniffMimeType } from '@/lib/restaurant/menu-import-uploads';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '../audit';
import { auditedProtectedProcedure, publicProcedure, router } from '../trpc';

/**
 * DEV-679: read a distributor invoice (a photo or a PDF) into a reviewable
 * draft of a goods receipt. The result is a PROPOSAL: it is copied into the
 * direct-purchase form, where a person checks every line, files a DRAFT
 * receipt and later posts it through the existing, unchanged procedures.
 * Nothing here writes a receipt, stock, a price or the medicine register.
 *
 * The model only transcribes. Matching against the register, the duplicate
 * bill guard, the last-purchase MRP and trade price, and every difference are
 * read from the database and computed by deterministic code.
 *
 * The file is validated, images are re-encoded without metadata, it is sent to
 * the configured reader and then dropped: it is never stored and never written
 * to the audit log (only its hash and size are).
 */

const MAX_FILE_BASE64 = 4 * Math.ceil(MAX_PRESCRIPTION_FILE_BYTES / 3);
/** A distributor bill is a page or two; a longer file is not one invoice. */
export const MAX_INVOICE_PDF_PAGES = 5;
/** Longest edge sent to the reader. Enough for invoice print; bounds provider cost. */
const READER_MAX_EDGE = 2400;
/** Per-user reads per minute. One invoice is one read. */
export const INVOICE_CAPTURE_READS_PER_MINUTE = 6;
/** Tenant-wide ceiling, so many receivers cannot multiply provider spend. */
export const INVOICE_CAPTURE_TENANT_READS_PER_MINUTE = 20;

const NOT_READ = 'The invoice could not be read. Enter the lines by hand.';
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export const invoiceCaptureReadInput = z
  .object({
    branchId: z.string().trim().min(1).max(200),
    /** The supplier already chosen on the form, if any. Otherwise matched by printed name. */
    supplierId: z.string().trim().min(1).max(200).optional(),
    document: z
      .object({
        contentType: z.enum([...IMAGE_TYPES, 'application/pdf']),
        dataBase64: z.string().min(1).max(MAX_FILE_BASE64),
      })
      .strict(),
  })
  .strict();

/** Test seam: the adapter a read uses. Production resolves it from the environment. */
export const invoiceCaptureAdapterSeam: {
  resolve: () => InvoiceCaptureAdapter | null;
} = {
  resolve() {
    const name = configuredInvoiceCaptureAdapterName();
    return name ? resolveInvoiceCaptureAdapter(name) : null;
  },
};

// The file must never reach an audit row, including denied or malformed
// requests, so input capture is switched off before authentication runs.
const invoiceProcedure = publicProcedure
  .use(({ ctx, next }) => {
    ctx.audit.detail.skipInput = true;
    return next();
  })
  .concat(auditedProtectedProcedure);

const unreadable = (message = NOT_READ) => new TRPCError({ code: 'BAD_REQUEST', message });

/** Re-encode: drops EXIF/GPS and any trailing payload, bounds the pixels sent out. */
async function readerImage(bytes: Buffer): Promise<Buffer> {
  try {
    return await sharp(bytes, { limitInputPixels: 25_000_000, failOn: 'warning' })
      .rotate()
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
    throw unreadable();
  }
}

/** A PDF is checked by its own bytes, never by the declared type alone. */
function readerPdf(dataBase64: string): Buffer {
  const bytes = Buffer.from(dataBase64, 'base64');
  if (
    !bytes.length ||
    bytes.length > MAX_PRESCRIPTION_FILE_BYTES ||
    bytes.toString('base64') !== dataBase64 ||
    sniffMimeType(bytes) !== 'application/pdf'
  ) {
    throw unreadable('Upload a valid PDF of at most 5 MiB, or a photo of the invoice.');
  }
  let pages: number;
  try {
    pages = countPdfPages(bytes);
  } catch {
    throw unreadable('The PDF has no readable pages. Upload a photo of the invoice instead.');
  }
  if (pages > MAX_INVOICE_PDF_PAGES) {
    throw unreadable(
      `The PDF has ${pages} pages. Upload one invoice of at most ${MAX_INVOICE_PDF_PAGES} pages.`
    );
  }
  return bytes;
}

const lower = (value: string) => value.trim().toLocaleLowerCase('en');

/**
 * Everything the proposal compares against comes from the register and the
 * posted receipts of this tenant, never from the document.
 */
async function lineContexts(
  db: ScopedDb,
  organizationId: string,
  extraction: InvoiceExtraction,
  at: Date
): Promise<InvoiceLineContext[]> {
  const names = [
    ...new Set(extraction.lines.map((line) => line.product.value).filter((name) => name !== null)),
  ];
  const exact = names.length
    ? await db.medicine.findMany({
        where: {
          organizationId,
          saleable: true,
          OR: names.flatMap((name) => [
            { productName: { equals: name, mode: 'insensitive' as const } },
            { brandName: { equals: name, mode: 'insensitive' as const } },
          ]),
        },
        orderBy: [{ productName: 'asc' }, { id: 'asc' }],
        take: MAX_INVOICE_LINES * 4,
        select: {
          id: true,
          productName: true,
          brandName: true,
          presentations: {
            select: {
              packLevels: {
                select: {
                  id: true,
                  level: true,
                  unitsPerParent: true,
                  parentPackLevelId: true,
                  effectiveFrom: true,
                  effectiveTo: true,
                },
              },
            },
          },
        },
      })
    : [];

  async function lineContext(
    line: InvoiceExtraction['lines'][number]
  ): Promise<InvoiceLineContext> {
    const name = line.product.value ? lower(line.product.value) : '';
    const matches = exact.filter(
      (medicine) =>
        lower(medicine.productName) === name ||
        (medicine.brandName !== null && lower(medicine.brandName) === name)
    );
    if (matches.length !== 1) {
      // Never chosen for the receiver: shown as names to pick from.
      const token = name.split(/[^\p{L}\p{N}]+/u).find((part) => part.length >= 3);
      const candidates =
        matches.length > 1
          ? matches
          : token
            ? await db.medicine.findMany({
                where: {
                  organizationId,
                  saleable: true,
                  productName: { contains: token, mode: 'insensitive' },
                },
                orderBy: [{ productName: 'asc' }, { id: 'asc' }],
                take: 3,
                select: { id: true, productName: true },
              })
            : [];
      return {
        medicine: null,
        pack: null,
        candidates: candidates.map((medicine) => ({
          medicineId: medicine.id,
          productName: medicine.productName,
        })),
        lastPurchase: null,
      };
    }
    const medicine = matches[0]!;
    const packs = medicine.presentations.flatMap((presentation) =>
      packConversions(presentation.packLevels as PackLevelNode[], at)
    );
    const chosen = choosePrintedPack(packs, line.pack.value);
    const last = chosen
      ? await db.pharmacyGoodsReceiptLine.findFirst({
          where: {
            organizationId,
            packLevelId: chosen.packLevelId,
            goodsReceipt: { status: 'POSTED' },
          },
          orderBy: [
            { goodsReceipt: { receivedAt: 'desc' } },
            { createdAt: 'desc' },
            { id: 'desc' },
          ],
          select: {
            printedMrpMinor: true,
            invoicedPricePerPackMinor: true,
            goodsReceipt: {
              select: { reference: true, receivedAt: true, supplier: { select: { name: true } } },
            },
          },
        })
      : null;
    return {
      medicine: { medicineId: medicine.id, productName: medicine.productName },
      pack: chosen
        ? {
            packLevelId: chosen.packLevelId,
            level: chosen.level,
            canonicalUnitsPerPack: chosen.canonicalUnitsPerPack,
          }
        : null,
      candidates: [],
      lastPurchase: last
        ? {
            reference: last.goodsReceipt.reference,
            receivedAt: last.goodsReceipt.receivedAt.toISOString(),
            supplierName: last.goodsReceipt.supplier.name,
            printedMrpMinor: last.printedMrpMinor,
            tradePriceMinor: last.invoicedPricePerPackMinor,
          }
        : null,
    };
  }

  // One line at a time: every scoped query opens its own tenant transaction,
  // and an invoice of many lines must not take the whole connection pool.
  const contexts: InvoiceLineContext[] = [];
  for (const line of extraction.lines) {
    contexts.push(await lineContext(line));
  }
  return contexts;
}

export const pharmacyInvoiceCaptureRouter = router({
  read: invoiceProcedure
    .input(invoiceCaptureReadInput)
    .mutation(async ({ ctx, input }): Promise<InvoiceCaptureProposal> => {
      const organizationId = ctx.entitlements.organizationId;
      const actorId = ctx.session.user.id;
      if (!organizationId || !(await actorCanProcure(ctx.db, actorId))) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission for this action.',
        });
      }
      const branch = await ctx.db.pharmacyBranch.findFirst({
        where: { id: input.branchId, organizationId, active: true },
        select: { id: true },
      });
      if (!branch) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That branch is not available.' });
      }
      const chosenSupplier = input.supplierId
        ? await ctx.db.pharmacySupplier.findFirst({
            where: { id: input.supplierId, organizationId },
            select: { id: true, name: true },
          })
        : null;
      if (input.supplierId && !chosenSupplier) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That supplier is not available.' });
      }

      const adapter = invoiceCaptureAdapterSeam.resolve();
      if (!adapter) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Reading invoices is not enabled for this workspace. Enter the lines by hand.',
        });
      }

      const limited = await rateLimit(
        `pharmacy-invoice-capture:${organizationId}:${actorId}`,
        INVOICE_CAPTURE_READS_PER_MINUTE,
        60_000
      );
      const tenantLimited = limited.ok
        ? await rateLimit(
            `pharmacy-invoice-capture:org:${organizationId}`,
            INVOICE_CAPTURE_TENANT_READS_PER_MINUTE,
            60_000
          )
        : limited;
      if (!tenantLimited.ok) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many invoices read in a minute. Wait a moment, or enter the lines by hand.',
        });
      }

      let bytes: Buffer;
      let content: Buffer;
      let mimeType: 'image/jpeg' | 'application/pdf';
      if (input.document.contentType === 'application/pdf') {
        bytes = readerPdf(input.document.dataBase64);
        content = bytes;
        mimeType = 'application/pdf';
      } else {
        bytes = decodeBoundedImageBase64(input.document.dataBase64);
        await assertSingleFrameImage(bytes, input.document.contentType);
        content = await readerImage(bytes);
        mimeType = 'image/jpeg';
      }
      const fileSha256 = createHash('sha256').update(bytes).digest('hex');
      const fileMeta = {
        branchId: input.branchId,
        fileSha256,
        fileBytes: bytes.length,
        fileType: mimeType,
        adapter: adapter.name,
      };

      let extraction: InvoiceExtraction;
      try {
        extraction = await adapter.extract({ content, mimeType, organizationId });
      } catch (error) {
        const reason = error instanceof InvoiceCaptureError ? error.reason : 'UNKNOWN';
        // Reason and adapter only: provider text can echo invoice content.
        console.error('[pharmacyInvoiceCapture.read] reader failed', {
          adapter: adapter.name,
          reason,
        });
        annotateAudit(ctx, {
          category: 'pharmacy.receiving',
          action: 'invoice_capture.read_failed',
          targetType: 'PharmacyBranch',
          targetId: input.branchId,
          metadata: { ...fileMeta, reason },
        });
        throw new TRPCError({
          code:
            error instanceof InvoiceCaptureError && error.reason === 'ADAPTER_UNAVAILABLE'
              ? 'PRECONDITION_FAILED'
              : 'BAD_GATEWAY',
          message: NOT_READ,
          cause: error,
        });
      }

      const at = new Date();
      let supplier = chosenSupplier;
      if (!supplier && extraction.supplier.value) {
        const named = await ctx.db.pharmacySupplier.findMany({
          where: {
            organizationId,
            name: { equals: extraction.supplier.value, mode: 'insensitive' },
          },
          orderBy: { id: 'asc' },
          take: 2,
          select: { id: true, name: true },
        });
        supplier = named.length === 1 ? named[0]! : null;
      }
      const duplicate =
        supplier && extraction.invoiceNumber.value
          ? await findDuplicateSupplierInvoice(ctx.db, {
              organizationId,
              supplierId: supplier.id,
              supplierInvoiceRef: extraction.invoiceNumber.value,
            })
          : null;

      const proposal = proposeInvoiceCapture(extraction, {
        supplier: supplier ? { supplierId: supplier.id, name: supplier.name } : null,
        duplicate: duplicate
          ? {
              goodsReceiptId: duplicate.id,
              reference: duplicate.reference,
              status: duplicate.status,
            }
          : null,
        lines: await lineContexts(ctx.db, organizationId, extraction, at),
      });

      annotateAudit(ctx, {
        category: 'pharmacy.receiving',
        action: 'invoice_capture.read',
        description: 'Distributor invoice read as a receiving suggestion. Nothing was posted.',
        targetType: 'PharmacyBranch',
        targetId: input.branchId,
        metadata: {
          ...fileMeta,
          adapterVersion: proposal.adapterVersion,
          supplierId: proposal.supplier.match?.supplierId ?? null,
          duplicateGoodsReceiptId: proposal.duplicate?.goodsReceiptId ?? null,
          lineCount: proposal.lines.length,
          matchedLines: proposal.lines.filter((line) => line.medicine !== null).length,
          priceDifferences: proposal.lines.filter(
            (line) =>
              line.warnings.includes('MRP_DIFFERS_FROM_LAST_PURCHASE') ||
              line.warnings.includes('TRADE_PRICE_DIFFERS_FROM_LAST_PURCHASE')
          ).length,
          warnings: proposal.warnings,
        },
      });
      return proposal;
    }),
});
