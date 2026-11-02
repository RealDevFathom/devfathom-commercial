import { csvCell } from '@/lib/csv';

/** Quote a value for CSV and prevent text cells from being evaluated as spreadsheet formulas. */
export function financeCsvCell(value: unknown): string {
  return csvCell(value);
}
