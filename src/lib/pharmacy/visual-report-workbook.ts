import { Workbook } from 'exceljs';
import type { ChartRow } from './visual-chart';

export function reportWorkbook(
  title: string,
  scope: string,
  rows: readonly ChartRow[],
  unit: 'money' | 'percent' | 'units',
  currency: string | null,
  baseLabel?: string
) {
  const book = new Workbook(),
    sheet = book.addWorksheet('Report');
  const moneyFormat = '"' + (currency ?? 'Currency unconfirmed') + '" #,##0.00';
  sheet.addRow([title]);
  sheet.addRow([scope]);
  sheet.addRow(['Group', 'Value', ...(baseLabel ? [baseLabel] : []), 'Excluded lines']);
  for (const row of rows) {
    const output = sheet.addRow([
      row.label,
      row.value === null ? 'Unavailable' : unit === 'units' ? row.value : row.value / 100,
      ...(baseLabel ? [row.base / 100] : []),
      row.excluded,
    ]);
    output.getCell(2).numFmt =
      unit === 'percent' ? '0.00%' : unit === 'units' ? '#,##0' : moneyFormat;
    if (baseLabel) output.getCell(3).numFmt = moneyFormat;
  }
  sheet.columns.forEach((column) => {
    column.width = 34;
  });
  return book;
}
