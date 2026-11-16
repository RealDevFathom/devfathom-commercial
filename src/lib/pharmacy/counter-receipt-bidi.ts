/** Split mixed receipt text into ordinary RTL text and LTR identifiers/numbers.
 * Include Urdu digits and decimal separators: ASCII-only isolation misses amounts.
 * Callers must still escape/render every segment as inert text.
 */
export function splitReceiptBidiText(value: string): string[] {
  return value.split(/([A-Za-z0-9۰-۹٠-٩][\x20-\x7e۰-۹٠-٩٫٬×−]*)/g);
}
