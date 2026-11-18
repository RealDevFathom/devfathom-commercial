/**
 * DEV-854 — the legacy export's class column.
 *
 * In the legacy export the class column mostly holds distributor names, but one class is
 * NARCOTICS. The owner's rule: a row in that class is imported as a controlled medicine, with
 * no review hold. It is then sold under the existing controlled-medicine rules (pharmacist
 * verification per sale, controlled register). A pharmacist or owner corrects a wrong flag
 * through the existing catalogue edit path.
 *
 * Matching rule: the class value, trimmed and compared case-insensitively, equals "NARCOTICS".
 * Nothing else matches: a close spelling such as "NARCOTIC" or "NARCOTICS DRUGS" is a different
 * class and is left unflagged rather than guessed.
 */

export const LEGACY_CONTROLLED_CLASS = 'NARCOTICS';

/** Normalized header spellings of the legacy class column (`classname`, `Class Name`, `CLASS`). */
const CLASS_HEADERS: readonly string[] = ['classname', 'class'];

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True only when the legacy class is NARCOTICS, ignoring case and surrounding whitespace. */
export function isLegacyControlledClass(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().toUpperCase() === LEGACY_CONTROLLED_CLASS;
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
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}
