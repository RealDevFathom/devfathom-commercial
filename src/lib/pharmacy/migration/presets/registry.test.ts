import { describe, expect, it } from 'vitest';
import {
  PROVISIONAL_NOTE,
  applyPreset,
  detectPreset,
  listPresets,
  lookupHeaderSynonym,
  parseMappedRow,
  parseTallyXml,
} from './registry';

const fixtures: ReadonlyArray<[string, string[]]> = [
  [
    'medipos',
    [
      'name',
      'generic',
      'sku',
      'base_unit',
      'pack_size',
      'opening_qty',
      'batch_no',
      'expiry',
      'unit_cost',
    ],
  ],
  [
    'tally-excel',
    [
      'ITEM-NAME',
      'Conversion Factor for Base Units',
      'Maintain in batches',
      'Batch',
      'Expiry date',
      'Opening Qty',
    ],
  ],
  ['marg-erp', ['Item Name', 'Company', 'Batch', 'Expiry', 'MRP', 'Qty']],
  ['busy', ['Item Name', 'Alias', 'Group', 'Unit', 'HSN', 'Opening Stock']],
  [
    'local-pk',
    ['Medicine Name', 'Generic', 'Company', 'Packing', 'Batch No', 'Expiry', 'TP', 'Stock'],
  ],
  [
    'quickbooks-products',
    [
      'Product/Service',
      'Type',
      'Memo/Description',
      'Purchase price',
      'Sales price',
      'Quantity on hand',
    ],
  ],
  ['quickbooks-customers', ['Customer', 'Customer full name', 'Email', 'Phone', 'Bill street']],
  ['quickbooks-suppliers', ['Supplier', 'Company', 'Email', 'Phone', 'Bill street']],
];

describe('pharmacy import preset registry', () => {
  it.each(fixtures)('detects %s fixture headers', (presetId, headers) => {
    expect(detectPreset(headers)).toEqual({ presetId, confidence: 1 });
  });

  it('falls back to generic synonym mapping', () => {
    expect(detectPreset(['Brand Name', 'Lot', 'Available Quantity']).presetId).toBe(
      'generic-register'
    );
    expect(applyPreset('generic-register', ['Brand Name', 'Lot', 'Available Quantity'])).toEqual({
      'Brand Name': 'product_name',
      Lot: 'batch_no',
      'Available Quantity': 'opening_qty',
    });
    expect(lookupHeaderSynonym(' M.R.P (*) ')).toBe('retail_price');
  });

  it('marks inferred presets provisional and forces review', () => {
    for (const id of ['marg-erp', 'busy', 'local-pk']) {
      const preset = listPresets().find((candidate) => candidate.id === id);
      expect(preset).toMatchObject({
        status: 'PROVISIONAL',
        note: PROVISIONAL_NOTE,
        forceMappingReview: true,
      });
    }
    expect(listPresets().find(({ id }) => id === 'medipos')).toMatchObject({
      status: 'VERIFIED',
      forceMappingReview: false,
    });
  });

  it('uses the existing exact readers for mapped values', () => {
    const mapping = applyPreset('medipos', ['name', 'opening_qty', 'expiry', 'unit_cost']);
    expect(
      parseMappedRow(
        { name: 'Panadol', opening_qty: '120', expiry: '11/2027', unit_cost: '2.50' },
        mapping
      )
    ).toEqual({
      product_name: 'Panadol',
      opening_qty: 120n,
      expiry: new Date('2027-11-30T00:00:00.000Z'),
      trade_price: 250n,
    });
  });

  it('rejects an unknown preset instead of silently applying generic rules', () => {
    expect(() => applyPreset('typo', ['Name'])).toThrow(RangeError);
  });
});

describe('Tally XML parser', () => {
  it('reads STOCKITEM and batch allocations including YYYYMMDD expiry', () => {
    const xml = `<ENVELOPE><STOCKITEM NAME="Panadol 500"><NAME>Panadol 500</NAME><BASEUNITS>Tablet</BASEUNITS><OPENINGBALANCE>100 Nos</OPENINGBALANCE><BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>PN-24</BATCHNAME><EXPIRYPERIOD>20271130</EXPIRYPERIOD><ACTUALQTY>100 Nos</ACTUALQTY></BATCHALLOCATIONS.LIST></STOCKITEM></ENVELOPE>`;
    expect(parseTallyXml(xml)).toEqual([
      {
        name: 'Panadol 500',
        baseUnit: 'Tablet',
        openingBalance: '100 Nos',
        batches: [
          {
            batchName: 'PN-24',
            expiry: new Date('2027-11-30T00:00:00.000Z'),
            quantity: '100 Nos',
            godown: 'Main Location',
          },
        ],
      },
    ]);
  });
});
