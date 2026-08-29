import { Decimal } from '@prisma/client/runtime/index-browser';

/** Client-safe money arithmetic shared by server money and offline promotions. */
const ROUND_HALF_UP = Decimal.ROUND_HALF_UP;

export { Decimal };
export const MONEY_SCALE = 2;
export type MoneyInput = Decimal | string | number;

export function money(value: MoneyInput): Decimal {
  const decimal = value instanceof Decimal ? value : new Decimal(value);
  if (!decimal.isFinite()) {
    throw new RangeError(`money() received a non-finite value: ${String(value)}`);
  }
  return decimal;
}

export const ZERO: Decimal = new Decimal(0);

export function add(a: MoneyInput, b: MoneyInput): Decimal {
  return money(a).plus(money(b));
}

export function sub(a: MoneyInput, b: MoneyInput): Decimal {
  return money(a).minus(money(b));
}

export function multiply(a: MoneyInput, b: MoneyInput): Decimal {
  return money(a).times(money(b));
}

export function sum(values: readonly MoneyInput[]): Decimal {
  return values.reduce<Decimal>((total, value) => total.plus(money(value)), ZERO);
}

export function roundMoney(value: MoneyInput): Decimal {
  return money(value).toDecimalPlaces(MONEY_SCALE, ROUND_HALF_UP);
}

export function compare(a: MoneyInput, b: MoneyInput): -1 | 0 | 1 {
  return money(a).comparedTo(money(b)) as -1 | 0 | 1;
}

export function equals(a: MoneyInput, b: MoneyInput): boolean {
  return money(a).equals(money(b));
}

export function isZero(value: MoneyInput): boolean {
  return money(value).isZero();
}

export function isNegative(value: MoneyInput): boolean {
  return money(value).isNegative();
}

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
  if (totalWeight <= 0) {
    throw new RangeError('allocate() requires the weights to sum to a positive value.');
  }

  const totalCents = roundMoney(total).times(100);
  const weightSum = new Decimal(totalWeight);
  const parts = weights.map((weight, index) => {
    const product = totalCents.times(weight);
    const base = product.divToInt(weightSum);
    const remainder = product.mod(weightSum);
    return { index, base, remainder };
  });
  const allocatedCents = parts.reduce<Decimal>((acc, part) => acc.plus(part.base), ZERO);
  const leftoverCents = totalCents.minus(allocatedCents).toNumber();
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
