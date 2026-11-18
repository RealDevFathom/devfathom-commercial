/**
 * DEV-854 — the legacy export's class column.
 *
 * In the legacy export the class column mostly holds distributor names, but one class is
 * NARCOTICS. The owner's rule: a row in that class is imported as a controlled medicine, with
 * no review hold. It is then sold under the existing controlled-medicine rules (pharmacist
 * verification per sale, controlled register). A pharmacist or owner corrects a wrong flag
 * through the existing catalogue edit path.
 *
 * Matching rule: the class value, trimmed (`normalizeLegacyText`) and compared
 * case-insensitively, equals "NARCOTICS".
 * Nothing else matches: a close spelling such as "NARCOTIC" or "NARCOTICS DRUGS" is a different
 * class and is left unflagged rather than guessed.
 */

export const LEGACY_CONTROLLED_CLASS = 'NARCOTICS';

/**
 * DEV-925: the one whitespace rule for legacy class values and product names, shared by this
 * code and the database lookups in `legacy-controlled.ts` (passed to PostgreSQL `regexp_replace`).
 * It is the set JavaScript's `trim()` and `\s` use: tabs, line breaks, no-break spaces and the
 * other Unicode spaces, written out so PostgreSQL does not fall back to its own, narrower rule.
 */
export const LEGACY_WHITESPACE_RUN =
  '[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+';

const WHITESPACE_RUN = new RegExp(LEGACY_WHITESPACE_RUN, 'g');

/**
 * Every whitespace run becomes one space, then the leading and trailing space is removed.
 * The SQL twin is `btrim(regexp_replace(value, LEGACY_WHITESPACE_RUN, ' ', 'g'), ' ')`.
 */
export function normalizeLegacyText(value: string): string {
  return value.replace(WHITESPACE_RUN, ' ').replace(/^ | $/g, '');
}

/** Normalized header spellings of the legacy class column (`classname`, `Class Name`, `CLASS`). */
const CLASS_HEADERS: readonly string[] = ['classname', 'class'];

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True only when the legacy class is NARCOTICS, ignoring case and surrounding whitespace. */
export function isLegacyControlledClass(value: string | null | undefined): boolean {
  return (
    typeof value === 'string' &&
    normalizeLegacyText(value).toUpperCase() === LEGACY_CONTROLLED_CLASS
  );
}

/** The class value of one source row, read from its original header. */
export function legacyClassValue(rawPayload: unknown): string | null {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return null;
  for (const wanted of CLASS_HEADERS) {
    for (const [header, value] of Object.entries(rawPayload)) {
      if (normalizeHeader(header) === wanted && typeof value === 'string') return value;
    }
  }
  return null;
}

/** Whether a source row's legacy class makes it a controlled medicine (any class header). */
export function isLegacyControlledRow(rawPayload: unknown): boolean {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return false;
  return Object.entries(rawPayload).some(
    ([header, value]) =>
      CLASS_HEADERS.includes(normalizeHeader(header)) &&
      typeof value === 'string' &&
      isLegacyControlledClass(value)
  );
}

/** Catalogue product-name comparison key: trimmed, inner whitespace collapsed, case-folded. */
export function legacyProductNameKey(name: string): string {
  return normalizeLegacyText(name).toLowerCase();
}
