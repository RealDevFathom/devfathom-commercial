const UNSAFE_CSV_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
const FORMULA_PREFIX = /^[\s\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]*[=+\-@]/u;

/** Flatten record-breaking controls and prevent spreadsheet formula evaluation. */
export function csvSafeText(value: unknown): string {
  const clean = String(value ?? '').replace(UNSAFE_CSV_CONTROL, ' ');
  return FORMULA_PREFIX.test(clean) ? `'${clean}` : clean;
}

/** Serialize one consistently quoted, injection-safe CSV cell. */
export function csvCell(value: unknown): string {
  return `"${csvSafeText(value).replaceAll('"', '""')}"`;
}
