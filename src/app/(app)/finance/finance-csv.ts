/** Quote a CSV cell and prevent spreadsheet formula execution. */
export function financeCsvCell(value: unknown): string {
  const text = String(value ?? '');
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
