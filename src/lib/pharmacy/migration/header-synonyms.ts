export const IMPORT_TARGET_FIELDS = [
  'product_name',
  'generic',
  'manufacturer',
  'sku',
  'barcode',
  'base_unit',
  'pack_size',
  'retail_price',
  'trade_price',
  'batch_no',
  'expiry',
  'opening_qty',
  'hsn_tax',
  'rack',
  'reorder_level',
  'customer',
  'supplier',
] as const;
export type ImportTargetField = (typeof IMPORT_TARGET_FIELDS)[number];

/** Evidence-led vendor and Roman-Urdu aliases. Target keys are stable preset data. */
export const HEADER_SYNONYMS: Readonly<Record<ImportTargetField, readonly string[]>> = {
  product_name: [
    'product name',
    'item name',
    'item-name',
    'medicine',
    'medicine name',
    'brand name',
    'dawai',
    'dawa',
    'naam',
  ],
  generic: ['generic', 'generic name', 'formula', 'salt'],
  manufacturer: ['manufacturer', 'manufacture name', 'company name', 'company', 'mfr'],
  sku: ['sku', 'part-no', 'part no', 'alias', 'code', 'item code'],
  barcode: ['barcode', 'gtin', 'ean'],
  base_unit: ['base unit', 'base_unit', 'baseunits', 'unit', 'uom'],
  pack_size: ['pack size', 'pack_size', 'box size', 'conversion factor', 'pack', 'packing'],
  retail_price: [
    'retail price',
    'sales price',
    'sale price',
    'mrp',
    'm.r.p.',
    'rp',
    'r.p.',
    'qeemat',
  ],
  trade_price: [
    'trade price',
    'purchase price',
    'purchase rate',
    'unit cost',
    'standard cost',
    'op.rate',
    'p.rate',
    'cost price',
    'tp',
    't.p.',
  ],
  batch_no: ['batch no', 'batch number', 'batch_no', 'batch', 'batchname', 'b.no', 'lot'],
  expiry: [
    'expiry',
    'expiry date',
    'exp',
    'exp.',
    'expiry_date',
    'expiryperiod',
    'mayaad',
    'mayad',
  ],
  opening_qty: [
    'opening qty',
    'opening quantity',
    'opening stock',
    'quantity on hand',
    'available quantity',
    'qty',
    'stock',
    'balance',
    'tadaad',
    'miqdar',
  ],
  hsn_tax: ['hsn', 'hsn/sac code', 'gst', 'gst %', 'tax', 'tax percentage'],
  rack: ['rack', 'location', 'item location', 'shelf', 'godown'],
  reorder_level: ['reorder level', 'reorder qty', 'minimum stock', 'min stock'],
  customer: ['customer', 'customer name', 'client', 'khata', 'udhaar'],
  supplier: ['supplier', 'supplier name', 'distributor', 'party', 'vendor'],
};

export function normalizeImportHeader(value: string): string {
  return value
    .normalize('NFKD')
    .toLocaleLowerCase('en')
    .replace(/[._/\\()\[\]-]+/g, ' ')
    .replace(/[^\p{L}\p{N}%]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
const LOOKUP = new Map<string, ImportTargetField>();
for (const field of IMPORT_TARGET_FIELDS)
  for (const alias of [field, ...HEADER_SYNONYMS[field]]) {
    const key = normalizeImportHeader(alias);
    if (!LOOKUP.has(key)) LOOKUP.set(key, field);
  }
export function autoMapImportHeaders(
  headers: readonly string[]
): Record<string, ImportTargetField> {
  const mapping: Record<string, ImportTargetField> = {};
  const claimed = new Set<ImportTargetField>();
  for (const header of headers) {
    const target = LOOKUP.get(normalizeImportHeader(header));
    if (target && !claimed.has(target)) {
      mapping[header] = target;
      claimed.add(target);
    }
  }
  return mapping;
}
export const REQUIRED_IMPORT_FIELDS: readonly ImportTargetField[] = ['product_name'];
export function missingRequiredFields(
  mapping: Readonly<Record<string, string>>
): ImportTargetField[] {
  const selected = new Set(Object.values(mapping));
  return REQUIRED_IMPORT_FIELDS.filter((field) => !selected.has(field));
}
