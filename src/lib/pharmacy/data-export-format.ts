/**
 * #716 — the owner "Download my data" archive format.
 *
 * PURE: no database, storage or clock access. The server collector hands this
 * module plain rows keyed by the column headers declared below, and it returns
 * the CSV files plus a README describing every column.
 *
 * COLUMN NAMES ARE THE IMPORT PRESET. Wherever a column carries a value the
 * migration wizard's Excel/CSV profiler understands, its header is the preset
 * name that profiler matches (`code`, `product`, `pack`, `barcode`, `batch`,
 * `expiry`, `mrp`, `cost`, `quantity`, `supplier`, `customer`, `balance` — see
 * `migration/excel-csv-profiler.ts`). Every other header is chosen so that it
 * normalizes to NONE of the profiler's synonyms, so an extra column can never
 * be mistaken for a mapped one when the file is imported back.
 *
 * FORMULA INJECTION IS NEUTRALISED. A text cell that a spreadsheet would
 * evaluate (leading `=`, `+`, `-`, `@`, tab or carriage return, after optional
 * whitespace) is prefixed with an apostrophe. A plain signed decimal is left as
 * it is: `-125.50` is a number, not a formula, and a khata credit balance must
 * still read back as money.
 */
import { registerPrintTotals, type RegisterPrintRow } from './register-print';

export type ExportCell = string | number | boolean | null | undefined;
export type ExportRow = Readonly<Record<string, ExportCell>>;

export type ExportColumn = { readonly header: string; readonly description: string };

export type ExportFileSpec = {
  readonly name: string;
  readonly title: string;
  /** True when the file is master data the migration wizard can import back. */
  readonly importable: boolean;
  readonly scope: string;
  readonly columns: readonly ExportColumn[];
};

const col = (header: string, description: string): ExportColumn => ({ header, description });

const MONEY = 'Pakistani rupees with two decimals (e.g. 1250.00).';

export const PHARMACY_EXPORT_FILES = {
  branches: {
    name: 'branches.csv',
    title: 'Branches',
    importable: false,
    scope: 'Every branch of the organization, active or not.',
    columns: [
      col('code', 'DevFathom branch identifier.'),
      col('branch_code', 'Short branch code shown on receipts.'),
      col('name', 'Branch name.'),
      col('city', 'City.'),
      col('province', 'Province code.'),
      col('active', 'true when the branch is active.'),
    ],
  },
  medicines: {
    name: 'medicines.csv',
    title: 'Medicines and packs',
    importable: true,
    scope:
      'One row per currently effective pack of every medicine presentation; a medicine with no pack yet has one row with a blank pack.',
    columns: [
      col('code', 'DevFathom pack identifier (or presentation identifier when no pack exists).'),
      col('product', 'Medicine product name.'),
      col('pack', 'Canonical (smallest sellable) units in one pack at this level.'),
      col('pack_level', 'Pack level name (for example BOX, STRIP, UNIT).'),
      col('barcode', 'First barcode registered for this pack, if any.'),
      col('presentation', 'Presentation description.'),
      col('dosage_form', 'Dosage form.'),
      col('route', 'Route of administration.'),
      col('brand_name', 'Brand name.'),
      col('manufacturer', 'Manufacturer.'),
      col('drap_registration_no', 'DRAP registration number.'),
      col('product_family', 'Product family.'),
      col('rx', 'Prescription-only flag.'),
      col('otc', 'Over-the-counter flag.'),
      col('restricted', 'Restricted flag.'),
      col('controlled', 'Controlled-drug flag.'),
      col('high_alert', 'High-alert flag.'),
      col('lasa', 'Look-alike / sound-alike flag.'),
      col('cold_chain', 'Cold-chain flag.'),
      col('saleable', 'Saleable flag.'),
      col('medicine_code', 'DevFathom medicine identifier.'),
      col('presentation_code', 'DevFathom presentation identifier.'),
    ],
  },
  stockLots: {
    name: 'stock-lots.csv',
    title: 'Stock lots',
    importable: true,
    scope:
      'One row per lot, location and disposition holding stock; a lot with no stock left has one row with quantity 0.',
    columns: [
      col('code', 'Row identifier: lot identifier, location code and disposition.'),
      col('product', 'Medicine product name.'),
      col('pack', 'Canonical units in one sealed pack of this lot.'),
      col('batch', 'Manufacturer batch number.'),
      col('expiry', 'Expiry date as received (YYYY-MM-DD, Pakistan time).'),
      col('quantity', 'On-hand quantity in canonical units.'),
      col('cost', `Landed cost of one canonical unit. ${MONEY}`),
      col('mrp', `Printed MRP of one pack. ${MONEY}`),
      col('supplier', 'Supplier the lot was received from.'),
      col('supplier_invoice', 'Supplier invoice reference.'),
      col('branch_code', 'Branch short code.'),
      col('location_code', 'Stock location code.'),
      col('location_name', 'Stock location name.'),
      col('disposition', 'AVAILABLE, QUARANTINE, DAMAGED, DESTROYED, IN_TRANSIT or RETURNED.'),
      col('sealed_packs', 'Sealed packs on hand.'),
      col('loose_units', 'Loose canonical units on hand.'),
      col('batch_state', 'Batch state (ACTIVE, RECALLED, ...).'),
      col('received_at', 'When the lot was received (ISO 8601, UTC).'),
      col('lot_code', 'DevFathom lot identifier.'),
      col('medicine_code', 'DevFathom medicine identifier.'),
    ],
  },
  customers: {
    name: 'customers.csv',
    title: 'Customers and khata balances',
    importable: true,
    scope: 'Every customer. balance is what the customer owes across the khata accounts they pay.',
    columns: [
      col('code', 'DevFathom customer identifier.'),
      col('customer', 'Customer display name.'),
      col('balance', `Khata balance owed: charges and dishonoured cheques less payments. ${MONEY}`),
      col('khata_accounts', 'Number of khata (family) accounts this customer pays.'),
      col('credit_limit', `Customer credit limit. ${MONEY}`),
      col('phone_last4', 'Last four digits of the phone number, when recorded.'),
      col('active', 'true when the customer is active.'),
      col('created_at', 'When the customer was created (ISO 8601, UTC).'),
    ],
  },
  khataLedger: {
    name: 'khata-ledger.csv',
    title: 'Khata ledger',
    importable: false,
    scope: 'Every khata charge, payment and dishonoured cheque, oldest first.',
    columns: [
      col('code', 'DevFathom khata event identifier.'),
      col('customer', 'Paying customer of the khata account.'),
      col('family_account', 'Khata (family) account name.'),
      col('family_account_code', 'DevFathom khata account identifier.'),
      col('branch_code', 'Branch short code.'),
      col('kind', 'CHARGE, PAYMENT or DISHONOURED_CHEQUE.'),
      col('amount', `Amount. ${MONEY}`),
      col('occurred_at', 'When it happened (ISO 8601, UTC).'),
      col('due_at', 'Due date of a charge (ISO 8601, UTC).'),
      col('settles_charge_code', 'For a payment, the charge it settles.'),
      col('note', 'Note.'),
    ],
  },
  suppliers: {
    name: 'suppliers.csv',
    title: 'Suppliers and balances',
    importable: true,
    scope:
      'Every supplier. balance is posted purchase bills (goods receipts not reversed) less posted supplier payments allocated to those bills.',
    columns: [
      col('code', 'DevFathom supplier identifier.'),
      col('supplier', 'Supplier name.'),
      col('balance', `Amount owed to the supplier. ${MONEY}`),
      col('purchased_total', `Posted purchase bills. ${MONEY}`),
      col('paid_total', `Posted payments allocated to those bills. ${MONEY}`),
      col('legal_name', 'Legal name.'),
      col('contact_name', 'Contact person.'),
      col('contact_phone', 'Contact phone.'),
      col('service_area', 'Districts or cities served.'),
      col('payment_terms_days', 'Net payment terms in days.'),
      col('credit_limit', `Credit limit. ${MONEY}`),
      col('authorized', 'true when the supplier is an authorized distributor.'),
      col('active', 'true when the supplier is active.'),
      col('created_at', 'When the supplier was created (ISO 8601, UTC).'),
    ],
  },
  sales: {
    name: 'sales.csv',
    title: 'Sales',
    importable: false,
    scope: 'Every sale in the requested date range (business date, Pakistan time), any status.',
    columns: [
      col('code', 'DevFathom sale identifier.'),
      col('sale_date', 'Business date (YYYY-MM-DD), or the Pakistan-time creation date when none.'),
      col('created_at', 'When the sale was opened (ISO 8601, UTC).'),
      col('completed_at', 'When the sale was completed (ISO 8601, UTC).'),
      col('receipt_no', 'Receipt number.'),
      col('branch_code', 'Branch short code.'),
      col('status', 'OPEN, HELD, QUOTATION, COMPLETED or VOID.'),
      col('customer', 'Customer display name, if any.'),
      col('customer_code', 'DevFathom customer identifier, if any.'),
      col('line_count', 'Number of lines.'),
      col('gross', `Sum of quantity times unit price. ${MONEY}`),
      col('discount', `Sum of line discounts. ${MONEY}`),
      col('net', `gross less discount. ${MONEY}`),
    ],
  },
  saleLines: {
    name: 'sale-lines.csv',
    title: 'Sale lines',
    importable: false,
    scope: 'Every line of the sales in sales.csv.',
    columns: [
      col('code', 'DevFathom sale line identifier.'),
      col('sale_code', 'Sale identifier (sales.csv code).'),
      col('sale_date', 'Business date of the sale.'),
      col('branch_code', 'Branch short code.'),
      col('product', 'Medicine product name.'),
      col('pack', 'Canonical units in one sale unit.'),
      col('sale_unit', 'PACK, STRIP or UNIT.'),
      col('sale_quantity', 'Quantity in sale units.'),
      col('quantity', 'Quantity in canonical units.'),
      col('unit_price', `Price of one sale unit. ${MONEY}`),
      col('cost', `Cost of one canonical unit. ${MONEY}`),
      col('gross', `sale_quantity times unit_price. ${MONEY}`),
      col('discount', `Line discount. ${MONEY}`),
      col('net', `gross less discount. ${MONEY}`),
      col('discount_kind', 'DISCOUNT or PROMOTION, if discounted.'),
      col('medicine_code', 'DevFathom medicine identifier.'),
      col('pack_level_code', 'DevFathom pack identifier.'),
    ],
  },
  purchaseOrders: {
    name: 'purchase-orders.csv',
    title: 'Purchase orders',
    importable: false,
    scope: 'Every purchase order.',
    columns: [
      col('code', 'DevFathom purchase order identifier.'),
      col('reference', 'Purchase order reference.'),
      col('supplier', 'Supplier name.'),
      col('branch_code', 'Branch short code, if branch-specific.'),
      col('status', 'Purchase order status.'),
      col('created_at', 'Created (ISO 8601, UTC).'),
      col('submitted_at', 'Submitted (ISO 8601, UTC).'),
      col('approved_at', 'Approved (ISO 8601, UTC).'),
      col('sent_at', 'Sent to supplier (ISO 8601, UTC).'),
      col('expected_delivery_at', 'Expected delivery (ISO 8601, UTC).'),
      col('freight', `Freight charge. ${MONEY}`),
      col('other_charges', `Other charges. ${MONEY}`),
      col('note', 'Note.'),
    ],
  },
  purchaseOrderLines: {
    name: 'purchase-order-lines.csv',
    title: 'Purchase order lines',
    importable: false,
    scope: 'Every line of every purchase order.',
    columns: [
      col('code', 'DevFathom purchase order line identifier.'),
      col('po_reference', 'Purchase order reference.'),
      col('line_no', 'Line number.'),
      col('supplier', 'Supplier name.'),
      col('product', 'Medicine product name.'),
      col('pack', 'Canonical units in one ordered pack.'),
      col('ordered_packs', 'Packs ordered (paid).'),
      col('bonus_packs', 'Bonus packs.'),
      col('quantity', 'Ordered canonical units.'),
      col('bonus_quantity', 'Bonus canonical units.'),
      col('list_price_per_pack', `List price per pack. ${MONEY}`),
      col('discount_bps', 'Discount in basis points.'),
      col('rebate_bps', 'Rebate in basis points.'),
      col('tax_bps', 'Tax in basis points.'),
      col('tax_creditable', 'true when the tax is input-claimable.'),
    ],
  },
  goodsReceipts: {
    name: 'goods-receipts.csv',
    title: 'Goods receipts (GRNs)',
    importable: false,
    scope: 'Every goods receipt.',
    columns: [
      col('code', 'DevFathom goods receipt identifier.'),
      col('reference', 'GRN reference.'),
      col('supplier', 'Supplier name.'),
      col('branch_code', 'Branch short code.'),
      col('status', 'DRAFT, POSTED, REVERSED or CANCELLED.'),
      col('po_reference', 'Purchase order reference, if any.'),
      col('supplier_invoice', 'Supplier invoice reference.'),
      col('supplier_invoice_date', 'Supplier invoice date (YYYY-MM-DD, Pakistan time).'),
      col('received_at', 'Received (ISO 8601, UTC).'),
      col('posted_at', 'Posted (ISO 8601, UTC).'),
      col('reversed_at', 'Reversed (ISO 8601, UTC).'),
      col('reversal_reason', 'Reversal reason.'),
      col('direct_purchase', 'true for a direct purchase without a purchase order.'),
      col('payable', `Bill value: lines net of discount plus tax. ${MONEY}`),
      col('distributor_ntn', 'Distributor NTN printed on the bill.'),
      col('distributor_strn', 'Distributor STRN printed on the bill.'),
      col('note', 'Note.'),
    ],
  },
  goodsReceiptLines: {
    name: 'goods-receipt-lines.csv',
    title: 'Goods receipt lines',
    importable: false,
    scope: 'Every line of every goods receipt.',
    columns: [
      col('code', 'DevFathom goods receipt line identifier.'),
      col('grn_reference', 'GRN reference.'),
      col('line_no', 'Line number.'),
      col('supplier', 'Supplier name.'),
      col('product', 'Medicine product name.'),
      col('pack', 'Canonical units in one received pack.'),
      col('batch', 'Batch number.'),
      col('expiry', 'Printed expiry (YYYY-MM-DD, Pakistan time).'),
      col('mrp', `Printed MRP of one pack. ${MONEY}`),
      col('cost', `Landed cost of one canonical unit. ${MONEY}`),
      col('quantity', 'Accepted canonical units.'),
      col('received_quantity', 'Received canonical units (excluding bonus).'),
      col('bonus_quantity', 'Bonus canonical units.'),
      col('rejected_quantity', 'Rejected canonical units.'),
      col('rejection_reason', 'Rejection reason.'),
      col('received_packs', 'Packs received (paid).'),
      col('bonus_packs', 'Bonus packs received.'),
      col('invoiced_price_per_pack', `Invoiced price per pack. ${MONEY}`),
      col('discount_bps', 'Discount in basis points.'),
      col('tax_bps', 'Tax in basis points.'),
      col('barcode', 'GS1 GTIN scanned at stock-in, if any.'),
      col('serial_number', 'GS1 serial scanned at stock-in, if any.'),
      col('lot_code', 'DevFathom lot identifier created on posting.'),
    ],
  },
  controlledRegister: {
    name: 'controlled-register.csv',
    title: 'Controlled-drug register',
    importable: false,
    scope:
      'Every controlled-register entry, per branch in serial order — the same rows, in the same order, as the printed register.',
    columns: [
      col('code', 'DevFathom register entry identifier.'),
      col('branch_code', 'Branch short code.'),
      col('serial_no', 'Register serial number (S. No.).'),
      col('recorded_at', 'Date and time recorded (ISO 8601, UTC).'),
      col('entry_type', 'Sale, Emergency sale, Purchase or Correction of <serial>, as printed.'),
      col('prescriber', 'Prescriber name.'),
      col('prescriber_reg_no', 'Prescriber registration number.'),
      col('patient', 'Patient, or counterparty for a purchase.'),
      col('patient_cnic', 'Patient CNIC, masked to the last four digits as printed.'),
      col('patient_address', 'Patient address.'),
      col('product', 'Drug.'),
      col('manufacturer', 'Manufacturer.'),
      col('quantity', 'Quantity in canonical units.'),
      col('balance_delta', 'Signed change in the sellable balance.'),
      col('batch', 'Batch number.'),
      col('qualified_person', 'Qualified person who witnessed the entry.'),
      col('pin_witnessed', 'true when the witness signed with a PIN.'),
      col('running_balance', 'Balance after this entry.'),
      col('rx_reference', 'Prescription file reference.'),
      col('rx_serial_written', 'true when the serial was written on the prescription.'),
      col('correction_reason', 'Correction reason.'),
      col('lot_code', 'DevFathom lot identifier.'),
    ],
  },
} as const satisfies Record<string, ExportFileSpec>;

export type PharmacyExportFileKey = keyof typeof PHARMACY_EXPORT_FILES;
export const PHARMACY_EXPORT_FILE_KEYS = Object.keys(
  PHARMACY_EXPORT_FILES
) as PharmacyExportFileKey[];

export type PharmacyExportDataset = Record<PharmacyExportFileKey, readonly ExportRow[]>;

export type PharmacyExportMeta = {
  organizationName: string;
  generatedAt: Date;
  salesFrom: string;
  salesTo: string;
};

const NUMERIC = /^-?\d+(?:\.\d+)?$/;
const FORMULA = /^[\s]*[=+\-@]|^[\t\r]/;

/** Neutralise a cell a spreadsheet would evaluate as a formula. */
export function neutralizeSpreadsheetFormula(text: string): string {
  if (NUMERIC.test(text)) return text;
  return FORMULA.test(text) ? `'${text}` : text;
}

export function exportCsvCell(value: ExportCell): string {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'string' ? neutralizeSpreadsheetFormula(value) : String(value);
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 CSV with CRLF line endings. The caller adds the UTF-8 BOM. */
export function exportRowsToCsv(spec: ExportFileSpec, rows: readonly ExportRow[]): string {
  const headers = spec.columns.map((column) => column.header);
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => exportCsvCell(row[header])).join(',')),
  ]
    .join('\r\n')
    .concat('\r\n');
}

/** Minor units to a two-decimal rupee amount; `null` stays blank. */
export function formatMinor(value: number | bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const minor = BigInt(value);
  const negative = minor < BigInt(0);
  const magnitude = negative ? -minor : minor;
  const whole = magnitude / BigInt(100);
  const fraction = (magnitude % BigInt(100)).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

const KARACHI_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** A calendar date in Pakistan time, as YYYY-MM-DD. */
export function formatKarachiDate(value: Date | null | undefined): string | null {
  return value ? KARACHI_DATE.format(value) : null;
}

/** A `@db.Date` column, which Prisma returns as UTC midnight. */
export function formatCalendarDate(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

export function formatInstant(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function registerTotalsByBranch(rows: readonly ExportRow[]) {
  const byBranch = new Map<string, RegisterPrintRow[]>();
  for (const row of rows) {
    const branch = String(row.branch_code ?? '');
    const list = byBranch.get(branch) ?? [];
    list.push({
      inventoryLotId: String(row.lot_code ?? ''),
      batchNumber: String(row.batch ?? ''),
      balanceDelta: Number(row.balance_delta ?? 0),
      runningBalance: Number(row.running_balance ?? 0),
      serial: Number(row.serial_no ?? 0),
    });
    byBranch.set(branch, list);
  }
  return [...byBranch.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([branch, entries]) => ({ branch, ...registerPrintTotals(entries) }));
}

export function buildPharmacyExportReadme(
  dataset: PharmacyExportDataset,
  meta: PharmacyExportMeta
): string {
  const lines: string[] = [
    'DevFathom pharmacy data export',
    '==============================',
    '',
    `Organization: ${meta.organizationName}`,
    `Generated:    ${meta.generatedAt.toISOString()}`,
    `Sales range:  ${meta.salesFrom} to ${meta.salesTo} (business date, Pakistan time, inclusive)`,
    '',
    'This archive is yours. Every file is UTF-8 CSV (comma-separated, double-quoted where',
    'needed, CRLF line endings, with a byte-order mark so spreadsheets open Urdu text).',
    '',
    'Re-importing',
    '------------',
    'Column names follow the DevFathom migration wizard (Excel/CSV source) import headers:',
    'code, product, pack, barcode, batch, expiry, mrp, cost, quantity, supplier, customer,',
    'balance. Files marked "importable" are master data that the wizard reads back one row',
    'per CSV row. Other files are history kept for your records and audits.',
    '',
    'Values',
    '------',
    '- Money is Pakistani rupees with two decimals; a negative balance is a credit.',
    '- Dates are YYYY-MM-DD in Pakistan time; timestamps are ISO 8601 in UTC.',
    '- Quantities are canonical (smallest sellable) units unless the column says packs.',
    "- A text cell that a spreadsheet would run as a formula (starting with =, +, -, @, tab",
    "  or carriage return) is prefixed with an apostrophe ('). Plain numbers are unchanged.",
    '',
    'Files',
    '-----',
  ];
  for (const key of PHARMACY_EXPORT_FILE_KEYS) {
    const spec: ExportFileSpec = PHARMACY_EXPORT_FILES[key];
    lines.push(
      '',
      `${spec.name} — ${spec.title}${spec.importable ? ' (importable)' : ''}`,
      `  Rows: ${dataset[key].length}`,
      `  Scope: ${spec.scope}`,
      '  Columns:'
    );
    for (const column of spec.columns) lines.push(`    ${column.header}: ${column.description}`);
  }
  const totals = registerTotalsByBranch(dataset.controlledRegister);
  lines.push('', 'Controlled-register totals (check against the printed register)', '-----');
  if (totals.length === 0) lines.push('No register entries.');
  for (const total of totals) {
    const closing = total.closing
      .map((row) => `${row.batchNumber} balance ${row.runningBalance}`)
      .join('; ');
    lines.push(
      `Branch ${total.branch}: ${total.rows} rows, in ${total.unitsIn}, out ${total.unitsOut}${
        closing ? `, closing ${closing}` : ''
      }`
    );
  }
  return lines.join('\r\n').concat('\r\n');
}

const BOM = '﻿';

export type PharmacyExportFile = { name: string; data: Buffer };

/** The archive's files in a fixed order: README first, then each CSV. */
export function buildPharmacyExportFiles(
  dataset: PharmacyExportDataset,
  meta: PharmacyExportMeta
): PharmacyExportFile[] {
  return [
    { name: 'README.txt', data: Buffer.from(BOM + buildPharmacyExportReadme(dataset, meta), 'utf8') },
    ...PHARMACY_EXPORT_FILE_KEYS.map((key) => ({
      name: PHARMACY_EXPORT_FILES[key].name,
      data: Buffer.from(BOM + exportRowsToCsv(PHARMACY_EXPORT_FILES[key], dataset[key]), 'utf8'),
    })),
  ];
}

export function pharmacyExportRowCounts(
  dataset: PharmacyExportDataset
): Record<PharmacyExportFileKey, number> {
  return Object.fromEntries(
    PHARMACY_EXPORT_FILE_KEYS.map((key) => [key, dataset[key].length])
  ) as Record<PharmacyExportFileKey, number>;
}
