import { csvCell } from '@/lib/csv';

/** Quote a value for CSV and prevent text cells from being evaluated as spreadsheet formulas. */
export function financeCsvCell(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `"${value}"`;
  return csvCell(value);
}
