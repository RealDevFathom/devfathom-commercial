import { Prisma } from '@/generated/prisma/client';

type MoneyInput = number | string | Prisma.Decimal;

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
  return roundMoney(values.reduce((total, value) => total.plus(decimal(value)), decimal(0)));
}
