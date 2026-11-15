/**
 * DEV-93 — the owner's full data export ("no lock-in"): file and column contract.
 *
 * Every file is a UTF-8 CSV. Where a file can be re-imported, its headers are the
 * exact names the migration wizard's spreadsheet profiler recognises
 * (`migration/excel-csv-profiler.ts`): `code`, `product`, `pack`, `barcode`,
 * `batch`, `expiry`, `mrp`, `cost`, `quantity`, `supplier`, `customer` and
 * `balance`. No other header is allowed to normalise onto one of those names,
 * so a file never maps a column onto the wrong field.
 *
 * Every cell goes through `csvCell`, which neutralises spreadsheet formulas and
 * flattens control characters (the same rule as the accounts CSVs).
 */
import { csvCell } from '@/lib/csv';
import { buildZip } from '@/lib/zip';

export type ExportCell = string | number | boolean | Date | null | undefined;
export type ExportRow = Record<string, ExportCell>;

export type ExportColumn = { header: string; description: string };
export type ExportFileSpec = {
  name: string;
  description: string;
  columns: readonly ExportColumn[];
};

const MONEY = 'Rupees with two decimals (stored as paisa, never rounded).';

export const OWNER_DATA_EXPORT_FILES = {
  medicines: {
    name: 'medicines.csv',
    description:
      'Medicines and their packs: one row per pack level. Re-imports through the migration wizard as products, packs and barcodes.',
    columns: [
      { header: 'code', description: 'Pack level id (stable DevFathom identifier).' },
      { header: 'product', description: 'Medicine product name.' },
      {
        header: 'pack',
        description: 'Base units in one of this pack, e.g. "10 units" (what the importer counts).',
      },
      { header: 'pack_level', description: 'Pack level and presentation, e.g. "strip · tablet".' },
      { header: 'barcode', description: 'Barcodes for this pack, separated by spaces.' },
      { header: 'medicine_id', description: 'Medicine id shared by every pack of the medicine.' },
      { header: 'brand', description: 'Brand name.' },
      { header: 'manufacturer', description: 'Manufacturer.' },
      { header: 'drap_registration', description: 'DRAP registration number.' },
      { header: 'units_per_parent', description: 'Units of this pack inside its parent pack.' },
      { header: 'product_family', description: 'DevFathom product family.' },
      { header: 'rx', description: 'true when a prescription is required.' },
      { header: 'otc', description: 'true when sold over the counter.' },
      { header: 'controlled', description: 'true when recorded in the controlled register.' },
      { header: 'saleable', description: 'true when the medicine can be sold.' },
    ],
  },
  stockLots: {
    name: 'stock_lots.csv',
    description:
      'Stock on hand by lot, location and disposition. Re-imports through the migration wizard as batches with expiry, MRP, cost and quantity.',
    columns: [
      { header: 'code', description: 'Stock lot id.' },
      { header: 'product', description: 'Medicine product name.' },
      {
        header: 'pack',
        description:
          'Base units in one pack of this lot, e.g. "10 units" (what the importer counts).',
      },
      { header: 'pack_level', description: 'Pack level and presentation the lot was received in.' },
      { header: 'batch', description: 'Manufacturer batch number.' },
      { header: 'expiry', description: 'Expiry date (YYYY-MM-DD).' },
      { header: 'mrp', description: `Printed MRP per pack. ${MONEY}` },
      { header: 'cost', description: `Landed cost per base unit. ${MONEY}` },
      { header: 'quantity', description: 'Units on hand at this location (base units).' },
      { header: 'supplier', description: 'Supplier the lot was received from.' },
      { header: 'branch', description: 'Branch code.' },
      { header: 'location', description: 'Stock location code.' },
      { header: 'disposition', description: 'AVAILABLE, QUARANTINE, DAMAGED and so on.' },
      { header: 'supplier_invoice', description: 'Supplier invoice reference.' },
    ],
  },
  customers: {
    name: 'customers.csv',
    description:
      'Customers with their khata (credit) balance. Re-imports through the migration wizard as customers with opening balances.',
    columns: [
      { header: 'code', description: 'Customer id.' },
      { header: 'customer', description: 'Customer name as shown at the counter.' },
      {
        header: 'balance',
        description: `Khata balance owed on accounts this customer pays for. ${MONEY}`,
      },
      { header: 'credit_limit', description: `Customer credit limit. ${MONEY}` },
      { header: 'phone_last4', description: 'Last four digits of the phone number.' },
      { header: 'active', description: 'true when the customer is active.' },
      { header: 'created_at', description: 'When the customer was added (ISO 8601, UTC).' },
    ],
  },
  khataLedger: {
    name: 'khata_ledger.csv',
    description: 'Every khata ledger event behind the customer balances.',
    columns: [
      { header: 'account_id', description: 'Khata (family) account id.' },
      { header: 'account_name', description: 'Khata account name.' },
      { header: 'payer_customer_id', description: 'Customer id that pays this account.' },
      { header: 'branch', description: 'Branch code.' },
      { header: 'kind', description: 'CHARGE, PAYMENT or DISHONOURED_CHEQUE.' },
      { header: 'amount', description: `Event amount. ${MONEY}` },
      { header: 'occurred_at', description: 'When it happened (ISO 8601, UTC).' },
      { header: 'due_at', description: 'When a charge falls due (ISO 8601, UTC).' },
      { header: 'note', description: 'Free-text note.' },
    ],
  },
  suppliers: {
    name: 'suppliers.csv',
    description:
      'Suppliers with the value of goods received from each. Re-imports through the migration wizard as supplier parties.',
    columns: [
      { header: 'code', description: 'Supplier id.' },
      { header: 'supplier', description: 'Supplier name.' },
      {
        header: 'goods_received_value',
        description: `Landed value of posted, unreversed goods receipts. Supplier payments are kept in the bookkeeping ledger, not per supplier. ${MONEY}`,
      },
      {
        header: 'supplier_credits',
        description: `Credit notes recorded from this supplier. ${MONEY}`,
      },
      { header: 'legal_name', description: 'Registered legal name.' },
      { header: 'contact_name', description: 'Contact person.' },
      { header: 'contact_phone', description: 'Contact phone.' },
      { header: 'payment_terms_days', description: 'Payment terms in days.' },
      { header: 'credit_limit', description: `Credit limit. ${MONEY}` },
      { header: 'authorized', description: 'true when the supplier is an authorised distributor.' },
      { header: 'active', description: 'true when the supplier is active.' },
    ],
  },
  sales: {
    name: 'sales.csv',
    description: 'Completed and voided sales inside the requested date range.',
    columns: [
      { header: 'sale_id', description: 'Sale id.' },
      { header: 'branch', description: 'Branch code.' },
      { header: 'receipt_number', description: 'Receipt number.' },
      { header: 'business_date', description: 'Business date (YYYY-MM-DD).' },
      { header: 'completed_at', description: 'When the sale completed (ISO 8601, UTC).' },
      { header: 'status', description: 'COMPLETED or VOID.' },
      { header: 'customer_id', description: 'Customer id, when the sale named one.' },
      { header: 'original_sale_id', description: 'Sale this one replaces, when any.' },
      { header: 'gross', description: `Sum of line gross amounts. ${MONEY}` },
      { header: 'discount', description: `Sum of line discounts. ${MONEY}` },
      { header: 'net', description: `gross minus discount. ${MONEY}` },
    ],
  },
  saleLines: {
    name: 'sale_lines.csv',
    description: 'The lines of every sale in sales.csv.',
    columns: [
      { header: 'sale_id', description: 'Sale id (sales.csv).' },
      { header: 'line_id', description: 'Sale line id.' },
      { header: 'medicine_id', description: 'Medicine id (medicines.csv).' },
      { header: 'medicine_name', description: 'Medicine product name.' },
      { header: 'pack_level_id', description: 'Pack level id (medicines.csv code).' },
      { header: 'sale_unit', description: 'Unit the line was sold in.' },
      { header: 'sold_quantity', description: 'Quantity in the sale unit.' },
      { header: 'base_units', description: 'Quantity in base units.' },
      { header: 'unit_price', description: `Price per sale unit. ${MONEY}` },
      { header: 'gross', description: `Line gross amount. ${MONEY}` },
      { header: 'discount', description: `Line discount. ${MONEY}` },
      { header: 'net', description: `gross minus discount. ${MONEY}` },
      { header: 'unit_cost', description: `Cost per base unit. ${MONEY}` },
    ],
  },
  purchaseOrders: {
    name: 'purchase_orders.csv',
    description: 'Purchase orders raised to suppliers.',
    columns: [
      { header: 'purchase_order_id', description: 'Purchase order id.' },
      { header: 'reference', description: 'Purchase order reference.' },
      { header: 'supplier_id', description: 'Supplier id (suppliers.csv).' },
      { header: 'branch', description: 'Branch code, when the order is for one branch.' },
      { header: 'status', description: 'Purchase order status.' },
      { header: 'created_at', description: 'Created (ISO 8601, UTC).' },
      { header: 'approved_at', description: 'Approved (ISO 8601, UTC).' },
      { header: 'sent_at', description: 'Sent to the supplier (ISO 8601, UTC).' },
      { header: 'expected_delivery_at', description: 'Expected delivery (ISO 8601, UTC).' },
    ],
  },
  goodsReceipts: {
    name: 'goods_receipts.csv',
    description: 'Goods received notes (GRNs).',
    columns: [
      { header: 'goods_receipt_id', description: 'GRN id.' },
      { header: 'reference', description: 'GRN reference.' },
      { header: 'branch', description: 'Branch code.' },
      { header: 'supplier_id', description: 'Supplier id (suppliers.csv).' },
      { header: 'purchase_order_id', description: 'Purchase order id, when any.' },
      { header: 'supplier_invoice', description: 'Supplier invoice reference.' },
      { header: 'supplier_invoice_date', description: 'Supplier invoice date (YYYY-MM-DD).' },
      { header: 'status', description: 'GRN status.' },
      { header: 'received_at', description: 'Received (ISO 8601, UTC).' },
      { header: 'posted_at', description: 'Posted (ISO 8601, UTC).' },
      { header: 'reversed_at', description: 'Reversed (ISO 8601, UTC).' },
      { header: 'freight', description: `Freight on the receipt. ${MONEY}` },
    ],
  },
  goodsReceiptLines: {
    name: 'goods_receipt_lines.csv',
    description: 'The lines of every GRN in goods_receipts.csv.',
    columns: [
      { header: 'goods_receipt_id', description: 'GRN id (goods_receipts.csv).' },
      { header: 'line_number', description: 'Line number on the GRN.' },
      { header: 'medicine_id', description: 'Medicine id (medicines.csv).' },
      { header: 'medicine_name', description: 'Medicine product name.' },
      { header: 'pack_level_id', description: 'Pack level id (medicines.csv code).' },
      { header: 'received_batch', description: 'Manufacturer batch number.' },
      { header: 'printed_expiry', description: 'Printed expiry (YYYY-MM-DD).' },
      { header: 'printed_mrp', description: `Printed MRP per pack. ${MONEY}` },
      { header: 'received_packs', description: 'Packs received.' },
      { header: 'bonus_packs', description: 'Bonus packs received.' },
      { header: 'accepted_units', description: 'Base units accepted into stock.' },
      { header: 'rejected_units', description: 'Base units rejected.' },
      { header: 'price_per_pack', description: `Invoiced price per pack. ${MONEY}` },
      { header: 'discount_bps', description: 'Discount in basis points.' },
      { header: 'tax_bps', description: 'Tax in basis points.' },
      { header: 'unit_cost', description: `Landed cost per base unit. ${MONEY}` },
      { header: 'stock_lot_id', description: 'Stock lot created (stock_lots.csv code).' },
    ],
  },
  controlledRegister: {
    name: 'controlled_register.csv',
    description:
      'Every controlled-drug register entry, per branch in serial order: the same rows as the register screen and its print.',
    columns: [
      { header: 'branch', description: 'Branch code.' },
      { header: 'register_serial', description: 'Register serial number within the branch.' },
      { header: 'recorded_at', description: 'When the entry was recorded (ISO 8601, UTC).' },
      { header: 'entry_kind', description: 'SALE, PURCHASE, CORRECTION and so on.' },
      { header: 'medicine_name', description: 'Medicine product name.' },
      { header: 'manufacturer', description: 'Manufacturer.' },
      { header: 'register_batch', description: 'Batch number.' },
      { header: 'quantity_units', description: 'Quantity in base units.' },
      { header: 'balance_change', description: 'Signed change to the running balance.' },
      { header: 'running_balance', description: 'Running balance after the entry.' },
      { header: 'patient', description: 'Patient name.' },
      { header: 'prescriber', description: 'Prescriber name.' },
      { header: 'prescriber_reg_no', description: 'Prescriber registration number.' },
      { header: 'counterparty', description: 'Supplier or other counterparty.' },
      { header: 'rx_serial_written', description: 'true when the Rx serial was written.' },
      { header: 'emergency', description: 'true for an emergency supply.' },
      { header: 'corrects_serial', description: 'Serial of the entry this one corrects.' },
      { header: 'correction_reason', description: 'Reason for a correction.' },
      { header: 'recorded_by', description: 'Name of the person who recorded it.' },
      { header: 'witnessed_by', description: 'Name of the witness.' },
    ],
  },
} as const satisfies Record<string, ExportFileSpec>;

export type OwnerDataExportFileKey = keyof typeof OWNER_DATA_EXPORT_FILES;
export type OwnerDataExportRows = Record<OwnerDataExportFileKey, readonly ExportRow[]>;

export type OwnerDataExportView = {
  id: string;
  status: string;
  requestedAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  downloadable: boolean;
  rowCounts: Record<string, number> | null;
};

export type OwnerDataExportMeta = {
  organizationName: string;
  generatedAt: Date;
  salesFrom: Date | null;
  salesTo: Date | null;
  /** Organization zone the picked sales dates are read in (UTC when absent). */
  timeZone?: string;
};

/** Paisa to a rupee string with exactly two decimals, by integer arithmetic. */
export function formatMinor(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '';
  if (!Number.isSafeInteger(minor)) throw new Error('Money must be an integer number of paisa.');
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(minor);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

export function formatDateOnly(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : '';
}

function cellText(value: ExportCell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * A plain number (including a negative one) cannot be a formula, so it is
 * written as-is; every other value gets `csvCell`'s formula neutralisation.
 * Prefixing `-25.00` with an apostrophe would lose a credit balance on re-import.
 */
function exportCell(value: ExportCell): string {
  const text = cellText(value);
  return PLAIN_NUMBER.test(text) ? `"${text}"` : csvCell(text);
}

/** One CSV document: BOM, header row, then every row in the spec's column order. */
export function exportCsv(spec: ExportFileSpec, rows: readonly ExportRow[]): string {
  const lines = [spec.columns.map((column) => csvCell(column.header)).join(',')];
  for (const row of rows) {
    lines.push(spec.columns.map((column) => exportCell(row[column.header])).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function exportReadme(meta: OwnerDataExportMeta, rows: OwnerDataExportRows): string {
  const range =
    meta.salesFrom || meta.salesTo
      ? `${formatDateOnly(meta.salesFrom) || 'the beginning'} to ${formatDateOnly(meta.salesTo) || 'today'}`
      : 'all dates';
  const sections = (Object.keys(OWNER_DATA_EXPORT_FILES) as OwnerDataExportFileKey[]).map((key) => {
    const spec: ExportFileSpec = OWNER_DATA_EXPORT_FILES[key];
    return [
      `## ${spec.name} (${rows[key].length} rows)`,
      '',
      spec.description,
      '',
      '| Column | Meaning |',
      '| --- | --- |',
      ...spec.columns.map((column) => `| ${column.header} | ${column.description} |`),
    ].join('\n');
  });
  return [
    `# DevFathom data export — ${meta.organizationName.replace(/[\r\n]+/g, ' ')}`,
    '',
    `Generated ${meta.generatedAt.toISOString()}. Sales cover ${range}${meta.salesFrom || meta.salesTo ? ` (dates read in ${meta.timeZone ?? 'UTC'})` : ''}.`,
    '',
    'Every file is UTF-8 CSV with a header row. Ids are stable, so files join on them.',
    'A cell that a spreadsheet would read as a formula starts with an apostrophe.',
    'medicines.csv, stock_lots.csv, customers.csv and suppliers.csv use the column names the',
    'DevFathom migration wizard reads, so they can be imported back in.',
    '',
    ...sections.flatMap((section) => [section, '']),
  ].join('\n');
}

/** The whole archive: README.md plus one CSV per file spec. */
export function buildOwnerDataExportZip(
  meta: OwnerDataExportMeta,
  rows: OwnerDataExportRows
): Buffer {
  return buildZip([
    { name: 'README.md', data: exportReadme(meta, rows) },
    ...(Object.keys(OWNER_DATA_EXPORT_FILES) as OwnerDataExportFileKey[]).map((key) => ({
      name: OWNER_DATA_EXPORT_FILES[key].name,
      data: exportCsv(OWNER_DATA_EXPORT_FILES[key], rows[key]),
    })),
  ]);
}

export function exportRowCounts(rows: OwnerDataExportRows): Record<string, number> {
  return Object.fromEntries(
    (Object.keys(OWNER_DATA_EXPORT_FILES) as OwnerDataExportFileKey[]).map((key) => [
      OWNER_DATA_EXPORT_FILES[key].name,
      rows[key].length,
    ])
  );
}
