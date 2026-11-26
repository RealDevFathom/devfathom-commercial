import { Workbook, ValueType } from 'exceljs';
import { expect, it } from 'vitest';
import { reportWorkbook } from './visual-report-workbook';
it('exports spreadsheet numbers with their units and keeps missing values distinct', () => {
  const row = { key: 'a', label: 'Group', amount: 1000, base: 2000, excluded: 1, value: 1000 };
  const money = reportWorkbook('Sales', 'Main', [row], 'money', 'PKR').worksheets[0]!;
  expect(money.getCell('B4').value).toBe(10);
  expect(money.getCell('B4').numFmt).toContain('PKR');
  const margin = reportWorkbook(
    'Margin',
    'Main',
    [
      { ...row, value: 50 },
      { ...row, value: null },
    ],
    'percent',
    'PKR',
    'Revenue'
  ).worksheets[0]!;
  expect(margin.getCell('B4').value).toBe(0.5);
  expect(margin.getCell('C4').value).toBe(20);
  expect(margin.getCell('B5').value).toBe('Unavailable');
});

it('round-trips leading spreadsheet punctuation as literal label text', async () => {
  const labels = ['=Sample', '+Sample', '-Sample', '@Sample'];
  const rows = labels.map((label) => ({
    key: label,
    label,
    value: 1,
    amount: 1,
    base: 0,
    excluded: 0,
  }));
  const exported = reportWorkbook('Returns', 'Synthetic branch', rows, 'units', null);
  const reopened = new Workbook();
  await reopened.xlsx.load(await exported.xlsx.writeBuffer());
  for (const [index, label] of labels.entries()) {
    const cell = reopened.worksheets[0]!.getCell(index + 4, 1);
    expect(cell.type).toBe(ValueType.String);
    expect(cell.value).toBe(label);
    expect(cell.formula).toBeUndefined();
  }
});
