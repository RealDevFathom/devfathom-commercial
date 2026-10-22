/** Quote a CSV cell and prevent spreadsheet formula execution. */
export function financeCsvCell(value: unknown): string {
  const text = String(value ?? '');
  const safe = /^\s*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
