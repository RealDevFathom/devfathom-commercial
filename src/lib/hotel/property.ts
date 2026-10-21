/**
 * PROP-01 / MODE-01 — the property record's shape rules, kept out of the router.
 *
 * Two things live here and nowhere else:
 *
 * - the **input contracts** the `hotelProperty` router validates against, so the
 *   page, the router and the tests all agree on what a property may be told; and
 * - the **mode list**, which is data. MODE-01 is explicit that a mode selects
 *   defaults and that "no code path branches on it beyond defaults", so this
 *   module validates a mode and never asks what it is. The defaults each mode
 *   implies arrive in H1-02 and belong in that defaults layer.
 */
import { z } from 'zod';

import { HotelPropertyMode } from '@/generated/prisma/enums';

/** The five modes of PRD §5.16, straight from the generated enum. */
export const HOTEL_PROPERTY_MODES = Object.values(HotelPropertyMode);

export type HotelPropertyModeValue = (typeof HOTEL_PROPERTY_MODES)[number];

/** H-D14: a property that has not said otherwise operates as a hotel. */
export const DEFAULT_HOTEL_PROPERTY_MODE: HotelPropertyModeValue = 'HOTEL';

/** Operator-facing names. UX rule 1: no surface prints a bare enum value. */
export const HOTEL_PROPERTY_MODE_LABELS: Record<HotelPropertyModeValue, string> = {
  HOTEL: 'Hotel',
  HOSTEL: 'Hostel',
  APARTMENT: 'Serviced apartments',
  RESORT: 'Resort',
  VENUE: 'Venue',
};

/** One line each, so choosing a mode is not a guess. */
export const HOTEL_PROPERTY_MODE_DESCRIPTIONS: Record<HotelPropertyModeValue, string> = {
  HOTEL: 'Rooms sold by the night, with a front desk and a nightly audit.',
  HOSTEL: 'Beds sold individually in shared rooms; room occupancy is derived from the beds.',
  APARTMENT: 'Units let by the week or month, with recurring charges and tenancy documents.',
  RESORT: 'Rooms by the night plus day-use slots sold against the same inventory.',
  VENUE: 'Function spaces and events only — no rooms and no availability days.',
};

/** 24-hour local time, as the property's own timezone reads it. */
const time24 = z
  .string()
  .trim()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use 24-hour time, e.g. 09:30.');

/**
 * The public direct-booking path segment. Lowercase and hyphenated because it
 * appears in a URL a guest is given, and unique per organization in the database
 * so two properties of one chain cannot publish the same one.
 */
export const bookingEngineSlug = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(64)
  .regex(
    /^[a-z0-9]([a-z0-9-]{1,62})[a-z0-9]$/,
    'Use lowercase letters, numbers and hyphens, starting and ending with a letter or number.'
  );

const languageTag = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2}(-[a-z0-9]{2,8})?$/, 'Use a language tag such as en or ur.');

/** A free-shape policy document a later lane fills in; never an array or scalar. */
const policyObject = z.record(z.string(), z.unknown());

export const hotelPropertyModeInput = z.object({
  mode: z.enum(HotelPropertyMode),
});

/**
 * Is `value` a timezone this runtime's `Intl` accepts? Pure and non-throwing, so
 * the update contract and the activation evidence apply one rule. The value is
 * probed exactly as given — the update contract trims before it gets here, and
 * a stored zone is judged as stored. Nothing is aliased, canonicalized or
 * defaulted: an unknown or missing zone is simply not a recorded fact. Same
 * probe as the platform command contract, kept here so Hotel code does not
 * import platform code.
 */
export function isValidHotelTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * PROP-01's editable facts. `mode` is deliberately absent: it moves through
 * `modes.set`, which is its own audited decision rather than one field of a
 * settings save.
 */
export const hotelPropertyUpdateInput = z.object({
  name: z.string().trim().min(2).max(160),
  addressLine: z.string().trim().min(1).max(300),
  city: z.string().trim().min(1).max(120),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => isValidHotelTimezone(value), 'Choose a valid IANA timezone.'),
  starCategory: z.coerce.number().int().min(1).max(7).nullable().optional(),
  checkInTime: time24,
  checkOutTime: time24,
  auditTime: time24,
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, e.g. PKR.'),
  taxProfileId: z.string().trim().min(1).max(191).nullable().optional(),
  languages: z.array(languageTag).min(1).max(8),
  bookingEngineSlug,
  overbookPolicy: policyObject.optional(),
  journeySettings: policyObject.optional(),
  mealAllocationPolicy: policyObject.optional(),
  businessDatePolicy: policyObject.optional(),
});

export type HotelPropertyUpdateInput = z.infer<typeof hotelPropertyUpdateInput>;

/** Prisma representation of the calendar day currently shown at a property. */
export function hotelLocalBusinessDate(timezone: string, instant: Date = new Date()): Date {
  if (!isValidHotelTimezone(timezone) || Number.isNaN(instant.valueOf())) {
    throw new RangeError('A valid instant and IANA timezone are required');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  return new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00.000Z`);
}

/**
 * The slug a newly provisioned property starts with, derived from the workspace
 * slug the operator already chose. Deterministic, so provisioning never has to
 * ask for one and two properties of one organization never collide by accident.
 */
export function defaultBookingEngineSlug(organizationSlug: string, propertyName: string): string {
  const base = `${organizationSlug}-${propertyName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  // A workspace slug is already 3+ URL-safe characters, but a name of only
  // punctuation could still shorten the result below the database CHECK.
  return base.length >= 3 ? base : `${base}-property`.slice(0, 64);
}
