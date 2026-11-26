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
