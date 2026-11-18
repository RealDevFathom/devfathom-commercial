/**
 * A money amount typed the way a shop owner writes it ("125.50", "1000", "0.05")
 * read as the integer minor units (paisa for PKR) the server stores. The digits
 * are combined as integers from the string itself, never through a float, so
 * 0.29 is 29 and 1000000.00 is 100000000 exactly.
 *
 * Blank is EMPTY so an optional field can mean "unknown". A sign, a third
 * decimal, separators or anything else is INVALID with the reason, never
 * rounded or guessed.
 */
export type AmountInput =
  | { status: 'EMPTY' }
  | { status: 'OK'; minor: number }
  | { status: 'INVALID'; reason: 'NEGATIVE' | 'DECIMALS' | 'FORMAT' | 'TOO_LARGE' };

const AMOUNT = /^(\d+)(?:\.(\d+))?$/;
const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

export function amountInputToMinor(raw: string): AmountInput {
  const value = raw.trim();
  if (value === '') return { status: 'EMPTY' };
  if (/^-/.test(value)) return { status: 'INVALID', reason: 'NEGATIVE' };
  const match = AMOUNT.exec(value);
  if (!match) return { status: 'INVALID', reason: 'FORMAT' };
  const fraction = match[2] ?? '';
  if (fraction.length > 2) return { status: 'INVALID', reason: 'DECIMALS' };
  const minor = BigInt(match[1]!) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));
  if (minor > MAX_MINOR) return { status: 'INVALID', reason: 'TOO_LARGE' };
  return { status: 'OK', minor: Number(minor) };
}

/** The plain-language message for an amount the parser refused. */
export function amountInputError(reason: Extract<AmountInput, { status: 'INVALID' }>['reason']) {
  switch (reason) {
    case 'NEGATIVE':
      return 'Enter an amount of 0 or more.';
    case 'DECIMALS':
      return 'Use at most 2 decimal places, for example 125.50.';
    case 'TOO_LARGE':
      return 'This amount is too large.';
    default:
      return 'Enter an amount using digits and an optional decimal point, for example 125.50.';
  }
}

/**
 * The unit beside an amount field: "rupees" for PKR, the currency code for any
 * other valid code, and a neutral word while no currency is chosen. A non-PKR
 * amount is never described in rupees or paisa.
 */
export function amountInputUnit(currency: string | null | undefined): string {
  const code = (currency ?? '').trim();
  if (code === 'PKR') return 'rupees';
  return /^[A-Z]{3}$/.test(code) ? code : 'chosen currency';
}
