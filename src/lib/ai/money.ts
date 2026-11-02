/**
 * Integer US-dollar minor units (cents) for the AI spend report.
 *
 * BigInt values are built with BigInt(...) rather than literals: the TypeScript
 * target is below ES2020, which rejects `0n`-style literals.
 */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const ZERO = BigInt(0);

/** A non-negative database bigint as a safe JavaScript integer, or a RangeError. */
export function safeMinorFromBigInt(value: bigint, label: string): number {
  if (value < ZERO || value > MAX_SAFE) {
    throw new RangeError(`${label} is outside the safe minor-unit range.`);
  }
  return Number(value);
}

export function addSafeMinor(left: number, right: number, label: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
    throw new RangeError(`${label} contains an invalid minor-unit value.`);
  }
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`${label} exceeds the safe minor-unit range.`);
  }
  return total;
}

/**
 * Whole cents for a USD amount such as a configured cap (DECIMAL(12,4) or an
 * environment value), rounded half up. Display only: cap enforcement compares
 * the unrounded amounts.
 */
export function minorFromUsd(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite, non-negative amount.`);
  }
  const minor = Math.round(value * 100);
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`${label} exceeds the safe minor-unit range.`);
  }
  return minor;
}
