/**
 * DEV-912 — the one import template for a pharmacy's medicines.
 *
 * It goes through the existing staging and review path: its headers map automatically to the
 * staging fields (name, units per pack, MRP, purchase price, opening quantity, batch, expiry,
 * barcode), and every other column is kept on each staged row, where bulk creation reads the
 * generic name, strips per box, pack type and old code, and the NARCOTICS class rule (DEV-854)
 * reads the class. Only the medicine name is required; a blank cell is "not recorded", never an
 * error. The old desktop system's headers (Name, PackUnits, saleprice, purprice, QTY, aliasname,
 * classname) keep working.
 */
import { csvCell } from '@/lib/csv';

export type ImportTemplateColumn = {
  header: string;
  required: boolean;
  meaning: string;
  example: string;
};

export const MEDICINE_IMPORT_TEMPLATE_COLUMNS: readonly ImportTemplateColumn[] = [
  {
    header: 'Product name',
    required: true,
    meaning:
      'The name you sell the medicine by, with its strength if you use it, for example "Example Tablet 500mg".',
    example: 'Example Tablet 500mg (delete this row)',
  },
  {
    header: 'Generic name',
    required: false,
    meaning: 'The salt or generic name.',
    example: 'Example salt',
  },
  {
    header: 'Units per pack',
    required: false,
    meaning:
      'How many single tablets, capsules or sachets one pack holds, as a number. 1 for a single item or a bottle. The price of one tablet is worked out from this.',
    example: '100',
  },
  {
    header: 'Strips per box',
    required: false,
    meaning:
      'How many strips one box holds, when the pack is a box of strips. Leave blank otherwise.',
    example: '10',
  },
  {
    header: 'Pack type',
    required: false,
    meaning: 'Box, Strip, Carton or Unit.',
    example: 'Box',
  },
  {
    header: 'MRP',
    required: false,
    meaning: 'The retail price printed on one pack (SALEPRICE in the old system).',
    example: '350.00',
  },
  {
    header: 'Purchase price',
    required: false,
    meaning: 'What you pay the distributor for one pack (PURPRICE in the old system).',
    example: '300.00',
  },
  {
    header: 'Class',
    required: false,
    meaning:
      'The category or class from your old system. NARCOTICS makes the medicine a controlled medicine.',
    example: 'TABLETS',
  },
  {
    header: 'Supplier',
    required: false,
    meaning: 'The distributor you usually buy it from.',
    example: 'Example Distributors',
  },
  {
    header: 'Barcode',
    required: false,
    meaning: 'The barcode printed on the pack.',
    example: '',
  },
  {
    header: 'Legacy code',
    required: false,
    meaning: 'The item code in your old system, kept so you can find the medicine by it.',
    example: 'OLD-0001',
  },
  {
    header: 'Opening quantity',
    required: false,
    meaning:
      'How much you have now. When you upload you choose whether this counts packs or single units.',
    example: '5',
  },
  {
    header: 'Batch number',
    required: false,
    meaning: 'The batch printed on the stock you have now.',
    example: 'B123',
  },
  {
    header: 'Expiry date',
    required: false,
    meaning: 'The expiry printed on that stock, for example 2027-06-30 or 06/2027.',
    example: '2027-06-30',
  },
  {
    header: 'Shelf or rack',
    required: false,
    meaning: 'Where the stock is kept, for example A-3.',
    example: 'A-3',
  },
  {
    header: 'Tax rate %',
    required: false,
    meaning: "Only when it differs from your pharmacy's default rate.",
    example: '',
  },
  {
    header: 'Reorder level',
    required: false,
    meaning: 'Order more when stock falls to this many packs.',
    example: '20',
  },
];

export const MEDICINE_IMPORT_TEMPLATE_NOTE =
  'Only the product name is required. Leave a cell blank when you do not know it: it is stored as not recorded and the medicine can still be sold.';

/** The CSV template: the header row and one example row. Notes live beside the download. */
export function medicineImportTemplateCsv(): string {
  return (
    [
      MEDICINE_IMPORT_TEMPLATE_COLUMNS.map((column) => column.header),
      MEDICINE_IMPORT_TEMPLATE_COLUMNS.map((column) => column.example),
    ]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n') + '\r\n'
  );
}

/**
 * The Excel template: one worksheet (the upload accepts exactly one populated sheet) with the
 * header row, one example row, and a note on every header saying what the column means.
 */
export async function medicineImportTemplateXlsx(): Promise<Uint8Array> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Medicines');
  sheet.addRow(MEDICINE_IMPORT_TEMPLATE_COLUMNS.map((column) => column.header));
  sheet.addRow(MEDICINE_IMPORT_TEMPLATE_COLUMNS.map((column) => column.example));
  MEDICINE_IMPORT_TEMPLATE_COLUMNS.forEach((column, index) => {
    const cell = sheet.getRow(1).getCell(index + 1);
    cell.font = { bold: true };
    cell.note = `${column.required ? 'Required. ' : 'Optional. '}${column.meaning}`;
    // Every cell is text, so a code such as "0012" or a date keeps the spelling typed.
    sheet.getColumn(index + 1).numFmt = '@';
    sheet.getColumn(index + 1).width = Math.max(14, column.header.length + 4);
  });
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
