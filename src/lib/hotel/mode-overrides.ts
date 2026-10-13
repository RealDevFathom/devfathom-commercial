import { z } from 'zod';

import type { HotelModeConfiguration } from './modes';

/**
 * A supplied object replaces ALL explicit overrides; {} resets to mode defaults.
 * Omit the object to preserve stored overrides, including false and empty arrays.
 * These are configuration choices, never capability or entitlement grants.
 */
export const hotelModeOverridesInput = z
  .strictObject({
    inventoryKinds: z.array(z.enum(['ROOM', 'BED', 'UNIT'])),
    billingCycles: z.array(z.enum(['NIGHTLY', 'WEEKLY', 'MONTHLY', 'SLOT'])),
    dayUse: z.boolean(),
    functionSpaces: z.boolean(),
    dormPolicies: z.boolean(),
    recurringExtras: z.boolean(),
    tenancyDocuments: z.boolean(),
    bookingEngineLayout: z.enum(['ROOMS', 'BEDS', 'UNITS', 'ROOMS_AND_SLOTS', 'FUNCTIONS']),
    reportKeys: z.array(z.string()),
  } satisfies Record<keyof HotelModeConfiguration, z.ZodType>)
  .partial()
  .transform((overrides) => {
    // Zod returns a fresh object. Undefined is absence, not persisted JSON.
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) Reflect.deleteProperty(overrides, key);
    }
    return overrides;
  });

/** SQL NULL / missing legacy storage means no overrides; malformed JSON fails. */
export function readHotelModeOverrides(value: unknown) {
  return hotelModeOverridesInput.parse(value == null ? {} : value);
}
