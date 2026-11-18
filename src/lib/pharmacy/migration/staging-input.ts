import { z } from 'zod';
import { ownerUploadInput } from './owner-import-input';

/**
 * DEV-851: a whole legacy catalogue export (about 19,000 products) is staged as
 * one batch. The file travels gzip-compressed so it fits one server action
 * request; the server decompresses it under `STAGING_MAX_FILE_BYTES` before
 * parsing, and the source hash is taken from the original, uncompressed bytes.
 */
export const STAGING_MAX_ROWS = 20_000;
/** Largest original CSV/XLSX file, after decompression. */
export const STAGING_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Largest file as sent: base64 of it, plus the mapping, must fit `next.config` `bodySizeLimit`. */
export const STAGING_MAX_UPLOAD_BYTES = Math.floor(2.5 * 1024 * 1024);
/** Largest total size an uploaded XLSX archive may expand to while it is read. */
export const STAGING_MAX_XLSX_EXPANDED_BYTES = 48 * 1024 * 1024;

export const STAGING_FIELDS = [
  ['product', 'Medicine name'],
  ['pack', 'Units per pack'],
  ['quantity', 'Quantity'],
  ['batch', 'Batch number'],
  ['expiry', 'Expiry'],
  ['mrp', 'MRP'],
  ['cost', 'Cost'],
  ['barcode', 'Barcode'],
] as const;
const column = z.number().int().min(0).max(39);
export const stagingUploadInput = z
  .object({
    fileName: ownerUploadInput.shape.fileName,
    content: z
      .string()
      .min(4)
      .max(Math.ceil(STAGING_MAX_UPLOAD_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((value) => value.length % 4 === 0, 'Upload a complete base64 file.'),
    /** `gzip` when the browser compressed the file before sending it. */
    encoding: z.enum(['identity', 'gzip']).default('identity'),
    branchId: z.string().min(1).max(128),
  })
  .strict();
export const stagingInput = stagingUploadInput
  .extend({
    quantityUnit: z.enum(['PACKS', 'UNITS']),
    mapping: z
      .object({
        product: column,
        quantity: column,
        pack: column.optional(),
        batch: column.optional(),
        expiry: column.optional(),
        mrp: column.optional(),
        cost: column.optional(),
        barcode: column.optional(),
      })
      .strict(),
  })
  .strict();
export type StagingInput = z.input<typeof stagingInput>;
export type StagingUploadInput = z.input<typeof stagingUploadInput>;
