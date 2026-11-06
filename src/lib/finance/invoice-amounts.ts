/**
 * DEV-252 / #448: the ONE invoice money calculation. Every invoice writer (the
 * finance router's create and edit, `POST /api/v1/invoices`, the assistant's
 * createInvoice tool, invoice-from-contract) and both invoice forms' live
 * previews call this, so a persisted invoice and the figures its author saw
 * cannot drift by a cent.
 *
 * The contract, in integer cents (BigInt — never binary floating point):
 *
 *   1. each line amount = quantity × rate, multiplied exactly in decimal and
 *      rounded to cents half-up (away from zero) — that rounded amount is what
 *      is persisted on the line;
 *   2. subtotal = the sum of those rounded line amounts, so the persisted lines
 *      always add up to the persisted subtotal exactly;
 *   3. discount and tax are currency AMOUNTS (not rates), each rounded to cents
 *      half-up — tax has always been an amount on every invoice surface;
 *   4. total = subtotal − discount + tax.
 *
 * Negative values, a discount larger than the subtotal, and any figure outside
 * the Decimal(12,2) column range are refused rather than clamped.
 *
 * Inputs are read through their shortest decimal spelling (`String(0.335)` is
 * "0.335"), the same reading Prisma's Decimal applies, so 3 × 0.335 is exactly
 * 1.005 and rounds to 1.01. Pure and dependency-free: safe in client bundles.
 */

// BigInt() rather than `0n` literals: the project still targets ES2017.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);

/** Largest Decimal(12,2) value, in cents: 9,999,999,999.99. */
export const MAX_INVOICE_CENTS = BigInt('999999999999');

export const INVOICE_AMOUNT_RANGE_MESSAGE = 'Derived invoice amount exceeds the allowed range';
export const INVOICE_NEGATIVE_MESSAGE = 'Invoice amounts cannot be negative.';
export const DISCOUNT_EXCEEDS_SUBTOTAL_MESSAGE = 'Discount cannot be more than the subtotal.';

type Decimal = { units: bigint; scale: number }; // value = units / 10^scale

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;

/** Exact decimal reading of a finite number (or numeric string); null when it is not one. */
function parseDecimal(value: number | string): Decimal | null {
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const match = DECIMAL.exec(typeof value === 'number' ? String(value) : value.trim());
  if (!match) return null;
  const [, sign, whole = '', fraction = '', exponent] = match;
  if (!whole && !fraction) return null;
  const shift = exponent ? Number(exponent) : 0;
  if (!Number.isSafeInteger(shift) || Math.abs(shift) > 400) return null;
  let units = BigInt(whole + fraction || '0');
  let scale = fraction.length - shift;
  if (scale < 0) {
    units *= TEN ** BigInt(-scale);
    scale = 0;
  }
  return { units: sign === '-' ? -units : units, scale };
}

/** Round a decimal to whole cents, half away from zero (decimal ROUND_HALF_UP). */
function roundToCents({ units, scale }: Decimal): bigint {
  if (scale <= 2) return units * TEN ** BigInt(2 - scale);
  const divisor = TEN ** BigInt(scale - 2);
  const magnitude = units < ZERO ? -units : units;
  const cents = magnitude / divisor + ((magnitude % divisor) * TWO >= divisor ? ONE : ZERO);
  return units < ZERO ? -cents : cents;
}

/** A money value in whole cents, rounded half-up; null when it is not a finite number. */
export function moneyToCents(value: number | string): bigint | null {
  const decimal = parseDecimal(value);
  return decimal ? roundToCents(decimal) : null;
}

/** Whole cents back to a 2-decimal number (exact for every Decimal(12,2) value). */
export function centsToMoney(cents: bigint): number {
  return Number(cents) / 100;
}

/** quantity × rate, multiplied exactly and rounded to cents half-up. */
export function lineAmountCents(quantity: number | string, rate: number | string): bigint | null {
  const q = parseDecimal(quantity);
  const r = parseDecimal(rate);
  if (!q || !r) return null;
  return roundToCents({ units: q.units * r.units, scale: q.scale + r.scale });
}

export type InvoiceLineInput = { description: string; quantity: number; rate: number };
export type InvoiceLine = InvoiceLineInput & { amount: number };

export type InvoiceAmounts = {
  items: InvoiceLine[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
};

export type InvoiceAmountsField = 'items' | 'subtotal' | 'discount' | 'tax' | 'total';

export type InvoiceAmountsResult =
  | { ok: true; amounts: InvoiceAmounts }
  | { ok: false; field: InvoiceAmountsField; message: string };

const inRange = (cents: bigint) => cents >= ZERO && cents <= MAX_INVOICE_CENTS;

/** Compute (and validate) an invoice's persisted money from its lines, discount and tax. */
export function computeInvoiceAmounts(input: {
  items: readonly InvoiceLineInput[];
  discount?: number | null;
  tax?: number | null;
}): InvoiceAmountsResult {
  const fail = (field: InvoiceAmountsField, message: string): InvoiceAmountsResult => ({
    ok: false,
    field,
    message,
  });

  const items: InvoiceLine[] = [];
  let subtotal = ZERO;
  for (const item of input.items) {
    const amount = lineAmountCents(item.quantity, item.rate);
    if (amount === null || item.quantity < 0 || item.rate < 0) {
      return fail('items', INVOICE_NEGATIVE_MESSAGE);
    }
    if (!inRange(amount)) return fail('items', INVOICE_AMOUNT_RANGE_MESSAGE);
    subtotal += amount;
    items.push({
      description: item.description,
      quantity: item.quantity,
      rate: item.rate,
      amount: centsToMoney(amount),
    });
  }
  if (!inRange(subtotal)) return fail('subtotal', INVOICE_AMOUNT_RANGE_MESSAGE);

  const discountInput = input.discount ?? 0;
  const discount = moneyToCents(discountInput);
  if (discount === null || discountInput < 0) return fail('discount', INVOICE_NEGATIVE_MESSAGE);
  const taxInput = input.tax ?? 0;
  const tax = moneyToCents(taxInput);
  if (tax === null || taxInput < 0) return fail('tax', INVOICE_NEGATIVE_MESSAGE);
  if (discount > subtotal) return fail('discount', DISCOUNT_EXCEEDS_SUBTOTAL_MESSAGE);
  if (!inRange(tax)) return fail('tax', INVOICE_AMOUNT_RANGE_MESSAGE);

  const total = subtotal - discount + tax;
  if (!inRange(total)) return fail('total', INVOICE_AMOUNT_RANGE_MESSAGE);

  return {
    ok: true,
    amounts: {
      items,
      subtotal: centsToMoney(subtotal),
      discount: centsToMoney(discount),
      tax: centsToMoney(tax),
      total: centsToMoney(total),
    },
  };
}
