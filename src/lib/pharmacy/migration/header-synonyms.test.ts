import { describe, expect, it } from 'vitest';
import {
  autoMapImportHeaders,
  IMPORT_TARGET_FIELDS,
  normalizeImportHeader,
} from './header-synonyms';
const examples = {
  product_name: 'Dawai',
  generic: 'Formula',
  manufacturer: 'Mfr.',
  sku: 'Item Code',
  barcode: 'GTIN',
  base_unit: 'U.O.M.',
  pack_size: 'Packing',
  retail_price: 'M.R.P.',
  trade_price: 'T.P.',
  batch_no: 'B.No',
  expiry: 'Mayaad',
  opening_qty: 'Miqdar',
  hsn_tax: 'HSN/SAC Code',
  rack: 'Shelf',
  reorder_level: 'Min Stock',
  customer: 'Udhaar',
  supplier: 'Company',
} as const;
describe('pharmacy import header synonyms', () => {
  it.each(IMPORT_TARGET_FIELDS)('maps a representative %s heading', (field) => {
    expect(autoMapImportHeaders([examples[field]])).toEqual({ [examples[field]]: field });
  });
  it('normalises punctuation, case and spaces without fuzzy guessing', () => {
    expect(normalizeImportHeader('  Expiry_Date  ')).toBe('expiry date');
    expect(autoMapImportHeaders(['T. P.', 'Unknown notes'])).toEqual({ 'T. P.': 'trade_price' });
  });
});
