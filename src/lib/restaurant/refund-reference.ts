/** Optional card-machine refund reference. It must never carry a card number, so any
 * 13-19 digit run (spaces and dashes ignored) is refused, as is anything that passes
 * the Luhn check at those lengths. Shared by the route schema and the refund engine. */
export const REFUND_REFERENCE_MAX_LENGTH = 40;
const ALLOWED = /^[A-Za-z0-9/-]+$/;

function luhn(digits: string): boolean {
  let total = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
}

/** Maps every Unicode decimal digit (Arabic-Indic, fullwidth, ...) to its ASCII digit so a
 * card number written in another script cannot slip past the digit-run check. */
function asciiDigits(value: string): string {
  return value.normalize('NFKC').replace(/\p{Nd}/gu, (char) => {
    const code = char.codePointAt(0)!;
    let start = code;
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    return String((code - start) % 10);
  });
}

/** Returns an error message, or null when the (already trimmed) reference is acceptable. */
export function refundReferenceProblem(value: string): string | null {
  if (value.length === 0) return null;
  const compact = asciiDigits(value).replace(/[^\p{L}\p{N}]/gu, '');
  const runs = compact.match(/\d+/g) ?? [];
  for (const run of runs) {
    // Any 13+ digit run is refused outright; the Luhn test is kept as an explicit
    // second guard for 13-19 digit runs.
    if ((run.length >= 13 && run.length <= 19 && luhn(run)) || run.length >= 13) {
      return 'The card machine refund reference must not contain a card number.';
    }
  }
  if (value.length > REFUND_REFERENCE_MAX_LENGTH) {
    return `The card machine refund reference must be at most ${REFUND_REFERENCE_MAX_LENGTH} characters.`;
  }
  if (!ALLOWED.test(value)) {
    return 'The card machine refund reference may only contain letters, digits, dash and slash.';
  }
  return null;
}
