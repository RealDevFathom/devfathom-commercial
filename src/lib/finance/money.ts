type DecimalParts = {
  coefficient: bigint;
  scale: number;
};

const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_TWO = BigInt(2);
const BIGINT_TEN = BigInt(10);

function decimalParts(value: number): DecimalParts {
  if (!Number.isFinite(value)) throw new RangeError('Money values must be finite');

  const match = String(value).match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) throw new RangeError(`Invalid money value: ${value}`);

  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  const sign = match[1] === '-' ? -BIGINT_ONE : BIGINT_ONE;

  return {
    coefficient: sign * BigInt(`${match[2]}${fraction}`),
    scale: fraction.length - exponent,
  };
}

function toCents({ coefficient, scale }: DecimalParts): bigint {
  const shift = scale - 2;
  if (shift <= 0) return coefficient * BIGINT_TEN ** BigInt(-shift);

  const divisor = BIGINT_TEN ** BigInt(shift);
  const absolute = coefficient < BIGINT_ZERO ? -coefficient : coefficient;
  const quotient = absolute / divisor;
  const remainder = absolute % divisor;
  const rounded = quotient + (remainder * BIGINT_TWO >= divisor ? BIGINT_ONE : BIGINT_ZERO);
  return coefficient < BIGINT_ZERO ? -rounded : rounded;
}

/** Round a numeric money input to cents using decimal half-up semantics. */
export function roundMoney(value: number): number {
  return Number(toCents(decimalParts(value))) / 100;
}

/**
 * Multiply decimal inputs before rounding to avoid binary floating-point changing
 * a half-cent boundary (for example, JavaScript represents 1.005 * 100 below 100.5).
 */
export function multiplyMoney(left: number, right: number): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  return Number(
    toCents({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale })
  ) / 100;
}
