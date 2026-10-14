import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { calculateTaxAmount, TaxConfigurationError } from '@/lib/tax/calculator';

export const HOTEL_TAX_PROVINCES = [
  'PUNJAB',
  'SINDH',
  'KP',
  'BALOCHISTAN',
  'ICT',
  'GB',
  'AJK',
] as const;

const minorAmountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const optionalReferenceSchema = z.string().trim().min(1).nullable().optional();

/**
 * Configuration projection, not a second profile/version model. `productClass`
 * and `priceMode` follow the platform's product-class tax rules. Publication,
 * effective-date resolution and tenant/branch authorization stay with callers.
 * H-D05: missing/null configuration is allowed in drafts, never inferred from province.
 */
export const hotelTaxProfileSchema = z.object({
  productClass: z.literal('HOTEL'),
  province: z.enum(HOTEL_TAX_PROVINCES).nullable().optional(),
  roomServicesTaxBps: z.number().int().min(0).max(10_000).nullable().optional(),
  priceMode: z.enum(['EXCLUSIVE', 'INCLUSIVE']).nullable().optional(),
  // Each amount is an explicitly configured, additional levy for this room-night.
  // No inferred per-bed count, percentage, compounding or levy exemption policy.
  levies: z
    .array(z.object({ code: z.string().trim().min(1).max(80), amountMinor: minorAmountSchema }))
    .refine((levies) => new Set(levies.map((levy) => levy.code)).size === levies.length, {
      message: 'Levy codes must be unique',
    })
    .nullable()
    .optional(),
  ntn: optionalReferenceSchema,
  strn: optionalReferenceSchema,
  eInvoiceEnabled: z.boolean().nullable().default(false),
  integrationId: optionalReferenceSchema,
  submissionMode: z.enum(['SIMULATED', 'REAL']).nullable().default('SIMULATED'),
});

export type HotelTaxProfileInput = z.input<typeof hotelTaxProfileSchema>;

/** Validates configuration shape only; does not establish legal or go-live readiness. */
export function validateHotelTaxProfile(input: unknown) {
  return hotelTaxProfileSchema.parse(input);
}

function toMinor(amount: Prisma.Decimal): number {
  const minor = amount.times(100);
  const value = minor.toNumber();
  if (!minor.isInteger() || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Room-night tax result exceeds safe integer minor units');
  }
  return value;
}

/**
 * Quote one room-night using the platform's exact Decimal, ROUND_HALF_UP at 2dp.
 * Explicit zero bps and [] levies are supported; missing decisions fail closed.
 * Levies are supplied final minor-unit amounts, added separately to room services tax.
 * Extras must use their own product-class rules through the existing tax engine.
 */
export function computeRoomNightTax(profile: HotelTaxProfileInput, amountMinor: number) {
  const config = validateHotelTaxProfile(profile);
  minorAmountSchema.parse(amountMinor);
  if (
    config.province == null ||
    config.roomServicesTaxBps == null ||
    config.priceMode == null ||
    config.levies == null
  ) {
    throw new TaxConfigurationError(
      'Room-night tax requires province, roomServicesTaxBps, priceMode and explicit levies'
    );
  }

  const room = calculateTaxAmount({
    consideration: new Prisma.Decimal(String(amountMinor)).div(100),
    rate: new Prisma.Decimal(String(config.roomServicesTaxBps)).div(10_000),
    priceMode: config.priceMode,
  });
  const levyTotal = config.levies
    .reduce((total, levy) => total.plus(String(levy.amountMinor)), new Prisma.Decimal(0))
    .div(100);

  return {
    netMinor: toMinor(room.net),
    servicesTaxMinor: toMinor(room.tax),
    levies: config.levies,
    levyTotalMinor: toMinor(levyTotal),
    taxMinor: toMinor(room.tax.plus(levyTotal)),
    grossMinor: toMinor(room.gross.plus(levyTotal)),
  };
}
