/** Quote a value for CSV and prevent text cells from being evaluated as spreadsheet formulas. */
export function financeCsvCell(value: unknown): string {
  const text = String(value ?? '');
  const safeText = typeof value === 'string' && /^\s*[=+\-@]/u.test(text) ? `'${text}` : text;

  return `"${safeText.replace(/"/g, '""')}"`;
}
