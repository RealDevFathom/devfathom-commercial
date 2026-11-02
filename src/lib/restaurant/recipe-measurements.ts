import { Prisma } from '@/generated/prisma/client';

export const RECIPE_MEASUREMENT_SPECS = {
  conversionFactor: {
    label: 'Unit conversion factor',
    domain: 'positive',
    precision: 18,
    scale: 6,
  },
  yieldQuantity: { label: 'Recipe yield quantity', domain: 'positive', precision: 12, scale: 3 },
  lineQuantity: { label: 'Recipe line quantity', domain: 'positive', precision: 12, scale: 4 },
  referenceCost: { label: 'Reference cost', domain: 'nonnegative', precision: 12, scale: 4 },
} as const;

export type RecipeMeasurementSpec =
  (typeof RECIPE_MEASUREMENT_SPECS)[keyof typeof RECIPE_MEASUREMENT_SPECS];

// Leading zeroes do not consume database precision; bound the input separately.
export const RECIPE_MEASUREMENT_MAX_LENGTH = 256;
export const RECIPE_MEASUREMENT_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export function parseRecipeMeasurement(value: string, spec: RecipeMeasurementSpec): Prisma.Decimal {
  const { label, domain, precision, scale } = spec;
  if (value.length > RECIPE_MEASUREMENT_MAX_LENGTH || !RECIPE_MEASUREMENT_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid decimal.`);
  }
  let parsed: Prisma.Decimal;
  try {
    parsed = new Prisma.Decimal(value);
  } catch {
    throw new Error(`${label} must be a valid decimal.`);
  }
  const valid =
    parsed.isFinite() &&
    parsed.decimalPlaces() <= scale &&
    parsed.abs().lessThan(new Prisma.Decimal(10).pow(precision - scale)) &&
    (domain === 'positive' ? parsed.greaterThan(0) : parsed.greaterThanOrEqualTo(0));
  if (!valid) {
    throw new Error(`${label} must be ${domain}.`);
  }
  return parsed;
}
