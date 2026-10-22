const CENT_SCALE = 2;

type DecimalParts = { coefficient: bigint; scale: number };

function decimalParts(value: number): DecimalParts {
  if (!Number.isFinite(value)) throw new RangeError('Money value must be finite');

  const [mantissa, exponentText] = value.toString().toLowerCase().split('e');
  const exponent = Number(exponentText ?? 0);
  const negative = mantissa.startsWith('-');
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');

  return {
    coefficient: BigInt(`${negative ? '-' : ''}${digits}`),
    scale: fraction.length - exponent,
  };
}

function roundPartsToCents({ coefficient, scale }: DecimalParts): number {
  const zero = BigInt(0);
  const ten = BigInt(10);
  const negative = coefficient < zero;
  const magnitude = negative ? -coefficient : coefficient;
  const discardedPlaces = scale - CENT_SCALE;

  let cents: bigint;
  if (discardedPlaces <= 0) {
    cents = magnitude * ten ** BigInt(-discardedPlaces);
  } else {
    const divisor = ten ** BigInt(discardedPlaces);
    const quotient = magnitude / divisor;
    const remainder = magnitude % divisor;
    // Monetary HALF_UP: an exact half-cent rounds away from zero.
    cents = quotient + (remainder * BigInt(2) >= divisor ? BigInt(1) : zero);
  }

  return Number(negative ? -cents : cents) / 100;
}

/** Round a JavaScript number to cents using decimal HALF_UP semantics. */
export function roundMoney(value: number): number {
  return roundPartsToCents(decimalParts(value));
}

/** Multiply decimal inputs exactly, then round the result to cents HALF_UP. */
export function multiplyMoney(quantity: number, rate: number): number {
  const left = decimalParts(quantity);
  const right = decimalParts(rate);
  return roundPartsToCents({
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  });
}
