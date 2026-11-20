/**
 * PH-MIG / MIG-01 (P0, Excel/CSV) — the generic spreadsheet profiler.
 *
 * This adapter has no fixed column map. Pharmacies hand over a sheet a staff
 * member built, so the columns are located by matching each header against a
 * synonym list. Matching is EXACT after normalization (casefold, strip anything
 * that is not a letter or a digit) rather than substring-based: "balance qty"
 * and "balance" are different columns, and a substring match would file a stock
 * count as a party balance.
 *
 * Ambiguity resolves to NOT MAPPED. When two headers claim the same field, the
 * first wins and the second is left alone; when a header matches no synonym it
 * stays unmapped and its cells still reach `rawPayload`, so nothing from the
 * source is lost even when it is not understood.
 */
import type { ColumnMap, SourceField, SourceProfiler } from './profiler';
import type { SourceTable } from './source-values';

/**
 * Header synonyms per logical field, as seen in Pakistani pharmacy spreadsheets
 * (English headers, occasionally abbreviated).
 *
 * TO CONFIRM IN PHASE 0: this list is drawn from the formats named in the PRD
 * and from common retail abbreviations, not from a corpus of real customer
 * files. Extend it from the first real handovers; an unmatched header costs a
 * mapping, never a wrong mapping.
 *
 * DEV-851 adds the headers of the legacy desktop catalogue export seen in the
 * first real handover (18,933 products): `Name`, `PackUnits` and `purprice`
 * (`saleprice` and `QTY` were already known). Its `aliasname` legacy code is
 * deliberately left unmapped: it is not guaranteed unique, and it is kept
 * verbatim in every row's source evidence, where the review screen shows and
 * searches it.
 *
 * DEV-912 adds the headers of the medicine import template (`Units per pack`,
 * `Opening quantity`; its `Product name` was already known); its other columns are kept in each row's source evidence.
 */
const HEADER_SYNONYMS: Readonly<Record<SourceField, readonly string[]>> = {
  sourceKey: ['id', 'code', 'itemcode', 'productcode', 'sr', 'srno', 'serial', 'sno'],
  product: [
    'product',
    'productname',
    'item',
    'itemname',
    'description',
    'medicine',
    'drug',
    'name',
  ],
  pack: [
    'pack',
    'packsize',
    'packing',
    'packunits',
    'unitsperpack',
    'uom',
    'unit',
    'unitofmeasure',
  ],
  barcode: ['barcode', 'ean', 'ean13', 'upc', 'gtin'],
  batch: ['batch', 'batchno', 'batchnumber', 'lot', 'lotno', 'lotnumber'],
  expiry: ['expiry', 'expirydate', 'exp', 'expdate', 'expdt', 'expiredate'],
  mrp: ['mrp', 'retailprice', 'saleprice', 'sellingprice', 'rate'],
  cost: ['cost', 'costprice', 'tradeprice', 'tp', 'purchaseprice', 'purchaserate', 'purprice'],
  quantity: [
    'qty',
    'quantity',
    'stock',
    'stockqty',
    'onhand',
    'balanceqty',
    'closingqty',
    'openingquantity',
  ],
  supplier: ['supplier', 'vendor', 'distributor', 'suppliername'],
  customer: ['customer', 'client', 'customername', 'account'],
  balance: ['balance', 'closingbalance', 'outstanding', 'amountdue', 'openingbalance'],
};

const FIELD_ORDER = Object.keys(HEADER_SYNONYMS) as SourceField[];

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A sheet is recognised when it maps at least one field that carries importable
 * content. A sheet whose only mapped column is a serial number is a table of
 * nothing, and profiling it would create rows with no target.
 */
const CONTENT_FIELDS: readonly SourceField[] = ['product', 'barcode', 'supplier', 'customer'];

export const excelCsvProfiler: SourceProfiler = {
  kind: 'EXCEL_CSV',
  version: 'excel-csv/1',

  resolveColumns(table: SourceTable): ColumnMap | null {
    if (table.headers.length === 0) return null;

    const normalized = table.headers.map(normalizeHeader);
    const columnMap: ColumnMap = {};

    // Field-major, so a header that could serve two fields is claimed by the
    // field declared first and the outcome does not depend on column order.
    for (const field of FIELD_ORDER) {
      const synonyms = HEADER_SYNONYMS[field];
      const index = normalized.findIndex(
        (header, position) =>
          synonyms.includes(header) && !Object.values(columnMap).includes(position)
      );
      if (index !== -1) columnMap[field] = index;
    }

    const hasContent = CONTENT_FIELDS.some((field) => columnMap[field] !== undefined);
    return hasContent ? columnMap : null;
  },
};
