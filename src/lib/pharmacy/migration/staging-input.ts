import { z } from 'zod';
import { ownerUploadInput } from './owner-import-input';

// Base64 plus mapping must fit the server action request limit.
export const STAGING_MAX_BYTES = 512 * 1024;

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
export const stagingUploadInput = ownerUploadInput
  .extend({
    branchId: z.string().min(1).max(128),
    content: ownerUploadInput.shape.content.max(Math.ceil(STAGING_MAX_BYTES / 3) * 4),
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
export type StagingInput = z.infer<typeof stagingInput>;
export type StagingUploadInput = z.infer<typeof stagingUploadInput>;
