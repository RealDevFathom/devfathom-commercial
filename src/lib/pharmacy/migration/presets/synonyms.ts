/** Canonical import fields understood by the migration staging pipeline. */
export const HEADER_SYNONYMS = {
  product_name: [
    'name',
    'item name',
    'item-name',
    'medicine',
    'medicine name',
    'brand name',
    'product',
    'product/service',
  ],
  generic: ['generic', 'generic name', 'formula', 'salt'],
  manufacturer: ['manufacturer', 'manufacture name', 'company', 'company name', 'mfr'],
  sku: ['sku', 'item code', 'code', 'part-no', 'part no', 'alias'],
  barcode: ['barcode', 'gtin', 'ean'],
  base_unit: ['base_unit', 'base unit', 'baseunits', 'unit', 'uom', 'per'],
  pack_size: [
    'pack_size',
    'pack size',
    'box_size',
    'box size',
    'pack',
    'packing',
    'conversion factor',
    'conversion factor for base units',
  ],
  retail_price: [
    'retail price',
    'rp',
    'm.r.p',
    'mrp',
    'sales price/rate',
    'sales price',
    'sale price',
    'base_price',
    'pack_price',
    'box_price',
    'standard selling price',
  ],
  trade_price: [
    'trade price',
    'tp',
    't.p.',
    'cost price',
    'purchase price',
    'purchase cost',
    'purchase rate',
    'p.rate',
    'rate',
    'op.rate',
    'standard cost',
    'unit_cost',
  ],
  batch_no: ['batch', 'batch no', 'batch no.', 'batch_no', 'batchname', 'lot'],
  expiry: ['expiry', 'expiry date', 'expiryperiod', 'exp', 'exp. date'],
  opening_qty: [
    'opening_qty',
    'opening qty',
    'opening stock',
    'quantity on hand',
    'qty',
    'stock',
    'balance',
    'available quantity',
  ],
  rack: ['rack', 'location', 'item location', 'shelf', 'godown'],
  reorder_level: ['reorder_level', 'reorder level', 'reorder qty', 'min stock'],
  customer_name: ['customer', 'customer name', 'customer full name'],
  supplier_name: ['supplier', 'supplier name', 'vendor'],
  phone: ['phone', 'mobile', 'whatsapp'],
  email: ['email', 'email address'],
  address: ['address', 'bill street'],
  cnic: ['cnic'],
  ntn: ['ntn'],
  credit_limit: ['credit limit'],
  credit_days: ['credit days'],
  balance_owed: ['balance owed', 'balance', 'udhaar', 'khata'],
} as const;

export type PresetTargetField = keyof typeof HEADER_SYNONYMS;
export type ColumnMapping = Readonly<Record<string, PresetTargetField>>;

export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[()*]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const LOOKUP = new Map<string, PresetTargetField>();
const AMBIGUOUS_HEADERS = new Set<string>();
for (const [target, aliases] of Object.entries(HEADER_SYNONYMS)) {
  for (const header of [target, ...aliases]) {
    const normalized = normalizeHeader(header);
    const existing = LOOKUP.get(normalized);
    if (existing && existing !== target) {
      LOOKUP.delete(normalized);
      AMBIGUOUS_HEADERS.add(normalized);
    } else if (!AMBIGUOUS_HEADERS.has(normalized)) {
      LOOKUP.set(normalized, target as PresetTargetField);
    }
  }
}

/** Resolve one unambiguous source header; domain-crossing aliases require explicit review. */
export function lookupHeaderSynonym(header: string): PresetTargetField | undefined {
  return LOOKUP.get(normalizeHeader(header));
}

export function mapHeadersBySynonym(headers: readonly string[]): ColumnMapping {
  const mapping: Record<string, PresetTargetField> = {};
  for (const header of headers) {
    const target = lookupHeaderSynonym(header);
    if (target) mapping[header] = target;
  }
  return Object.freeze(mapping);
}
