import { Prisma } from '@/generated/prisma/client';

type MoneyInput = number | string | Prisma.Decimal;

/** Largest value supported by the application's Decimal(12,2) money columns. */
export const MAX_MONEY = 9_999_999_999.99;

const decimal = (value: MoneyInput) => new Prisma.Decimal(value);

/** Round a monetary value to cents using decimal half-up semantics. */
export function roundMoney(value: MoneyInput): number {
  return decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

/** Multiply decimal inputs before rounding so binary floating-point cannot change a half-cent. */
export function multiplyMoney(left: MoneyInput, right: MoneyInput): number {
  return roundMoney(decimal(left).times(decimal(right)));
}

/** Add monetary values as decimals and round the result to cents. */
export function sumMoney(values: MoneyInput[]): number {
  return roundMoney(
    values.reduce<Prisma.Decimal>((total, value) => total.plus(decimal(value)), decimal(0))
  );
}

/** Whether a derived value can safely be persisted in a Decimal(12,2) money column. */
export function isPersistableMoney(value: MoneyInput): boolean {
  const amount = decimal(value);
  return amount.isFinite() && !amount.isNegative() && amount.lessThanOrEqualTo(MAX_MONEY);
}
