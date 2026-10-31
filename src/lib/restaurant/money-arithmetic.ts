// Match the generated Node client's CommonJS Decimal singleton while keeping
// the arithmetic entrypoint browser-safe. Prisma publishes both CJS and ESM
// utility instances; mixing them breaks instanceof-based money consumers.
import { Decimal } from '@prisma/client/runtime/index-browser.js';

export { Decimal };

/**
 * M5-L1 / C2 — the money Decimal core. The SINGLE arithmetic path for every
 * downstream money lane (bills, tenders, payments, refunds, drawers, close).
 *
 * Rules this module exists to enforce:
 *   - Every monetary value is a `Decimal` (decimal.js), never a JS float.
 *     There is no `parseFloat`, `Number()` arithmetic, or `toBeCloseTo` here or
 *     in anything built on it; equality is EXACT (Decimal string equality).
 *   - The scale is 2 decimal places. `roundMoney` is the one rounding function,
 *     and it rounds ROUND_HALF_UP (BUILD-ASSUMPTIONS).
 *   - `allocate` splits a total across integer weights so the shares sum to the
 *     total EXACTLY, using the pinned largest-remainder rule (C4): base share =
 *     floor(total × weight ÷ Σweights) at cent granularity; the remaining cents
 *     are handed out one per share in DESCENDING fractional-remainder order, ties
 *     broken by ASCENDING share index. The result is deterministic and
 *     reproducible for identical input.
 */

/** Rounding mode for all money rounding — ROUND_HALF_UP at 2dp (C2). The
 * cent-granularity floor in `allocate` uses integer `divToInt`/`mod`, so no
 * separate truncation mode is needed. */
const ROUND_HALF_UP = Decimal.ROUND_HALF_UP;

/** The number of decimal places every money value carries. */
export const MONEY_SCALE = 2;

/** A value that can be interpreted as money: a Decimal, or its exact string/int
 * representation. Pass Decimals or strings — a JS float that already lost
 * precision upstream cannot be recovered here. */
export type MoneyInput = Decimal | string | number;

/** Construct a Decimal from a money input. Throws on a non-finite value so a
 * NaN/Infinity never silently propagates through a total. */
export function money(value: MoneyInput): Decimal {
  const decimal = value instanceof Decimal ? value : new Decimal(value);
  if (!decimal.isFinite()) {
    throw new RangeError(`money() received a non-finite value: ${String(value)}`);
  }
  return decimal;
}

/** The canonical zero. */
export const ZERO: Decimal = new Decimal(0);

/** a + b (exact; two 2dp values add exactly). */
export function add(a: MoneyInput, b: MoneyInput): Decimal {
  return money(a).plus(money(b));
}

/** a − b (exact). */
export function sub(a: MoneyInput, b: MoneyInput): Decimal {
  return money(a).minus(money(b));
}

/** a × b. The exact product; the caller applies `roundMoney` when the operand
 * scales can push the result past 2dp (e.g. a fractional multiplier). A money
 * value times an integer quantity is already exact at 2dp. */
export function multiply(a: MoneyInput, b: MoneyInput): Decimal {
  return money(a).times(money(b));
}

/** Σ values (exact), starting from zero. */
export function sum(values: readonly MoneyInput[]): Decimal {
  return values.reduce<Decimal>((total, value) => total.plus(money(value)), ZERO);
}

/** Round to 2dp, ROUND_HALF_UP — the one money rounding (C2). */
export function roundMoney(value: MoneyInput): Decimal {
  return money(value).toDecimalPlaces(MONEY_SCALE, ROUND_HALF_UP);
}

/** The display/wire form of a money value: always 2dp ("28.00", "-0.50"). */
export function formatMoney(value: MoneyInput): string {
  return money(value).toFixed(MONEY_SCALE, ROUND_HALF_UP);
}

/** -1 | 0 | 1 for a<b | a==b | a>b (exact numeric comparison). */
export function compare(a: MoneyInput, b: MoneyInput): -1 | 0 | 1 {
  return money(a).comparedTo(money(b)) as -1 | 0 | 1;
}

/** Exact equality (Decimal string equality — never epsilon). */
export function equals(a: MoneyInput, b: MoneyInput): boolean {
  return money(a).equals(money(b));
}

/** True iff the value is exactly zero. */
export function isZero(value: MoneyInput): boolean {
  return money(value).isZero();
}

/** True iff the value is strictly negative. */
export function isNegative(value: MoneyInput): boolean {
  return money(value).isNegative();
}

/**
 * Allocate `total` across `weights` so the shares sum to `total` EXACTLY, using
 * the pinned largest-remainder rule (C4). `weights` are non-negative integers
 * (the relative shares — `[1, 1, 1]` for an even 3-way split; `[2, 1, 1]` for a
 * ½/¼/¼ split). The work is done in integer cents so the remainder ordering is
 * exact and the outcome is byte-identical across runs.
 *
 * Returns one 2dp Decimal per weight, in input order, with Σ shares ≡
 * roundMoney(total).
 */
export function allocate(total: MoneyInput, weights: readonly number[]): Decimal[] {
  if (weights.length === 0) {
    throw new RangeError('allocate() requires at least one weight.');
  }
  for (const weight of weights) {
    if (!Number.isInteger(weight) || weight < 0) {
      throw new RangeError(`allocate() weights must be non-negative integers; got ${weight}.`);
    }
  }
  const totalWeight = weights.reduce((acc, weight) => acc + weight, 0);
  if (totalWeight === 0 && money(total).isZero()) {
    return weights.map(() => new Decimal(0));
  }
  if (totalWeight <= 0) {
    throw new RangeError('allocate() requires the weights to sum to a positive value.');
  }

  // Work in integer cents: total is money, so ×100 is an exact integer.
  const totalCents = roundMoney(total).times(100);
  const weightSum = new Decimal(totalWeight);

  // base_i = floor(totalCents × weight_i ÷ Σweights); remainder_i = the exact
  // integer modulus that ranks who receives a leftover cent.
  const parts = weights.map((weight, index) => {
    const product = totalCents.times(weight);
    const base = product.divToInt(weightSum);
    const remainder = product.mod(weightSum);
    return { index, base, remainder };
  });

  const allocatedCents = parts.reduce<Decimal>((acc, part) => acc.plus(part.base), ZERO);
  // Leftover cents to distribute: total minus the floored shares. Non-negative
  // and strictly less than the number of shares, so it fits a JS integer.
  const leftoverCents = totalCents.minus(allocatedCents).toNumber();

  // Descending remainder, ties broken by ascending original index (C4).
  const order = [...parts].sort((a, b) => {
    const byRemainder = b.remainder.comparedTo(a.remainder);
    return byRemainder !== 0 ? byRemainder : a.index - b.index;
  });
  const extraCent = new Set<number>();
  for (let i = 0; i < leftoverCents; i += 1) {
    extraCent.add(order[i]!.index);
  }

  return parts.map((part) => {
    const cents = extraCent.has(part.index) ? part.base.plus(1) : part.base;
    return cents.dividedBy(100).toDecimalPlaces(MONEY_SCALE, ROUND_HALF_UP);
  });
}
