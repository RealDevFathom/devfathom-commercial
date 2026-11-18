import { z } from 'zod';

export const IMPORT_MAX_BYTES = 1024 * 1024;
export const IMPORT_MAX_ROWS = 250;
export const IMPORT_FIELDS = [
  ['sourceRef', 'Source reference', true],
  ['pack', 'Pack barcode or pack ID', true],
  // DEV-853: legacy stock often has neither; a blank cell is "not recorded".
  ['batch', 'Manufacturing batch', false],
  ['expiry', 'Expiry (YYYY-MM or YYYY-MM-DD)', false],
  ['mrp', 'Printed MRP per pack (PKR)', true],
  ['cost', 'Cost per base unit (PKR)', true],
  ['expected', 'Exported base units', true],
  ['counted', 'Physically counted base units', true],
  ['varianceNote', 'Variance explanation', false],
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number][0];
export type ImportMapping = Partial<Record<ImportField, number>>;

export const ownerUploadInput = z.object({
  fileName: z.string().trim().min(1).max(160).regex(/\.(csv|xlsx)$/i),
  content: z.string().min(4).max(Math.ceil(IMPORT_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((value) => value.length % 4 === 0, 'Upload a complete base64 file.'),
}).strict();
export const ownerImportInput = ownerUploadInput.extend({
  branchId: z.string().min(1).max(128),
  stockLocationId: z.string().min(1).max(128),
  mapping: z.object({
    sourceRef: z.number().int().min(0).max(39).optional(),
    pack: z.number().int().min(0).max(39).optional(),
    batch: z.number().int().min(0).max(39).optional(),
    expiry: z.number().int().min(0).max(39).optional(),
    mrp: z.number().int().min(0).max(39).optional(),
    cost: z.number().int().min(0).max(39).optional(),
    expected: z.number().int().min(0).max(39).optional(),
    counted: z.number().int().min(0).max(39).optional(),
    varianceNote: z.number().int().min(0).max(39).optional(),
  }).strict(),
}).strict();
export type OwnerImportInput = z.infer<typeof ownerImportInput>;

export const OPENING_TEMPLATE = 'Source reference,Pack barcode or pack ID,Manufacturing batch,Expiry,Printed MRP per pack,Cost per tablet/unit,Exported base units,Physically counted base units,Variance explanation\n';

export function suggestImportMapping(headers: readonly string[]): ImportMapping {
  const synonyms: Record<ImportField, string[]> = {
    sourceRef: ['sourcereference', 'sourceref', 'id', 'code'],
    pack: ['packbarcodeorpackid', 'barcode', 'packid', 'packlevelid'],
    batch: ['manufacturingbatch', 'batch', 'batchnumber', 'batchno'],
    expiry: ['expiry', 'expirydate'], mrp: ['mrp', 'printedmrp', 'printedmrpperpack', 'saleprice', 'sourcesaleprice'], cost: ['cost', 'unitcost', 'costpertabletunit', 'costperbaseunit', 'costpertabletunitpkr', 'costperbaseunitpkr'],
    expected: ['exportedbaseunits', 'expected', 'exported', 'qty'],
    counted: ['physicallycountedbaseunits', 'counted', 'physicalcount'],
    varianceNote: ['varianceexplanation', 'variancenote'],
  };
  const mapping: ImportMapping = {};
  for (const [field] of IMPORT_FIELDS) {
    const index = headers.findIndex((header, position) =>
      synonyms[field].includes(header.toLowerCase().replace(/[^a-z0-9]/g, '')) &&
      !Object.values(mapping).includes(position));
    if (index >= 0) mapping[field] = index;
  }
  return mapping;
}
