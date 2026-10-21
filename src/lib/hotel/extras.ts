/**
 * PROP-05 — the extras and services catalog's shape rules, kept out of the router.
 *
 * PROP-05's acceptance criterion is that "every folio charge references a catalog
 * item or a manual reason", so this catalog is the named half of every charge a
 * property will ever post. Three things live here and nowhere else:
 *
 * - the **input contracts** the `hotelProperty.extras.*` procedures validate
 *   against, so the page, the router and the tests agree on what an extra may be;
 * - the **operator-facing vocabulary** — department and recurrence names with a
 *   sentence each, because no surface prints a bare enum value (UX rule 1); and
 * - the two **rules that are not expressible as a field type**: an offer price
 *   requires an item that may be offered, and a `PER_PERIOD` charge only means
 *   something on a rate plan billed by a period.
 *
 * Both rules are validation, never a branch. MODE-01 makes the property mode
 * configuration and forbids code outside the defaults/packaging layer from asking
 * what it is, so nothing here reads a mode: a serviced-apartment property gets
 * `PER_PERIOD` because it sells weekly and monthly rate plans, not because it is
 * in APARTMENT mode, and a hotel that lets one long-stay unit is served by the
 * same catalog.
 */
import { z, ZodRealError, type ZodError } from 'zod';

import { HotelDepartment, HotelExtraRecurrence } from '@/generated/prisma/enums';

/** The posting departments of `06-roles-reports` §4/§5, straight from the enum. */
export const HOTEL_DEPARTMENTS = Object.values(HotelDepartment);

export type HotelDepartmentValue = (typeof HOTEL_DEPARTMENTS)[number];

/** The recurrence shapes of PROP-05 ★ / RSV-09. */
export const HOTEL_EXTRA_RECURRENCES = Object.values(HotelExtraRecurrence);

export type HotelExtraRecurrenceValue = (typeof HOTEL_EXTRA_RECURRENCES)[number];

/** A catalog item that says nothing else charges once, when someone posts it. */
export const DEFAULT_HOTEL_EXTRA_RECURRENCE: HotelExtraRecurrenceValue = 'NONE';

/** Operator-facing department names. UX rule 1: no surface prints a bare code. */
export const HOTEL_DEPARTMENT_LABELS: Record<HotelDepartmentValue, string> = {
  ROOMS: 'Rooms',
  DAY_USE: 'Day use',
  FOOD_BEVERAGE: 'Food and beverage',
  MINIBAR: 'Minibar',
  LAUNDRY: 'Laundry',
  SPA: 'Spa',
  TRANSPORT: 'Transport',
  TELEPHONE: 'Telephone',
  BUSINESS_CENTRE: 'Business centre',
  BANQUET: 'Banquets and events',
  UTILITIES: 'Utilities',
  NO_SHOW: 'No-show revenue',
  CANCELLATION: 'Cancellation revenue',
  MISCELLANEOUS: 'Miscellaneous',
};

/** Operator-facing recurrence names, with what each one costs a guest. */
export const HOTEL_EXTRA_RECURRENCE_LABELS: Record<HotelExtraRecurrenceValue, string> = {
  NONE: 'One off',
  PER_NIGHT: 'Every night',
  PER_STAY: 'Once per stay',
  PER_PERSON: 'Per person',
  PER_PERIOD: 'Every billing period',
};

export const HOTEL_EXTRA_RECURRENCE_DESCRIPTIONS: Record<HotelExtraRecurrenceValue, string> = {
  NONE: 'Charged when someone posts it, and only then.',
  PER_NIGHT: 'Charged once for every night of the stay.',
  PER_STAY: 'Charged once, however long the stay is.',
  PER_PERSON: 'Charged once for every guest on the reservation.',
  PER_PERIOD:
    'Charged once on each billing period of a weekly or monthly stay — utilities, cleaning, parking.',
};

/**
 * The billing cycles a rate plan may be sold on (`05-data-model` §1.2). Declared
 * here as the contract the rates lane must match, because the rate-plan table
 * does not exist yet and this module has to be able to refuse a `PER_PERIOD`
 * charge on a nightly plan the day that table arrives.
 */
export const HOTEL_BILLING_CYCLES = ['NIGHTLY', 'WEEKLY', 'MONTHLY', 'SLOT'] as const;

export type HotelBillingCycle = (typeof HOTEL_BILLING_CYCLES)[number];

/**
 * The cycles that have a *period* to post against. A nightly plan bills every
 * night, and a day-use slot has no second billing event at all, so neither one can
 * ever produce the periodic posting `PER_PERIOD` describes.
 */
export const HOTEL_PERIODIC_BILLING_CYCLES: readonly HotelBillingCycle[] = ['WEEKLY', 'MONTHLY'];

/**
 * PROP-05 ★ / RSV-09 — may this recurrence post against a stay billed on `cycle`?
 *
 * The one interesting answer is `PER_PERIOD` on a nightly or slot cycle: false.
 * The rest are true, because a per-night, per-stay or per-person charge is
 * well defined however the room itself is billed.
 *
 * Exported as a predicate rather than applied at catalog time on purpose. An
 * extra is created before any reservation exists, so there is no cycle to check
 * it against yet; RSV-09's posting path and the rate-plan lane's
 * `includes_extras[]` call this before they attach an item to a plan.
 */
export function hotelExtraRecurrenceFitsBillingCycle(
  recurring: HotelExtraRecurrenceValue,
  cycle: HotelBillingCycle
): boolean {
  if (recurring !== 'PER_PERIOD') return true;
  return HOTEL_PERIODIC_BILLING_CYCLES.includes(cycle);
}

/** Why a pairing was refused, in words an operator can act on. */
export function hotelExtraRecurrenceRefusal(
  recurring: HotelExtraRecurrenceValue,
  cycle: HotelBillingCycle
): string | null {
  if (hotelExtraRecurrenceFitsBillingCycle(recurring, cycle)) return null;
  return `A charge billed every billing period cannot be attached to a ${cycle.toLowerCase()} rate plan, which has no billing period to charge on. Use ${HOTEL_EXTRA_RECURRENCE_LABELS.PER_NIGHT.toLowerCase()} or ${HOTEL_EXTRA_RECURRENCE_LABELS.PER_STAY.toLowerCase()} instead, or sell it on a weekly or monthly plan.`;
}

/**
 * Refuse the pairing, loudly. The posting and rate-plan lanes call this so a
 * `PER_PERIOD` item can never be silently posted once and forgotten.
 */
export function assertHotelExtraRecurrenceForBillingCycle(
  recurring: HotelExtraRecurrenceValue,
  cycle: HotelBillingCycle
): void {
  const refusal = hotelExtraRecurrenceRefusal(recurring, cycle);
  if (refusal) throw new Error(refusal);
}

/**
 * A code that appears on a folio line, in a GL export and in a channel payload.
 * Upper-cased on the way in so `laundry` and `LAUNDRY` cannot become two catalog
 * items in one property.
 */
export const hotelExtraCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(32)
  .regex(
    /^[A-Z0-9][A-Z0-9_-]{0,31}$/,
    'Use capital letters, numbers, hyphens or underscores, starting with a letter or number.'
  );

/**
 * The tax class the property's tax profile prices this charge at. Free text
 * rather than an enum because the classes belong to the profile — provincial and
 * effective-dated — and the catalog only names one.
 */
export const hotelTaxClass = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(32)
  .regex(
    /^[A-Z0-9][A-Z0-9_-]{0,31}$/,
    'Use the tax class code from this property’s tax profile, e.g. HOTEL or SERVICES.'
  );

/** PKR minor units. Never negative: a discount is a folio line, not a catalog item. */
const priceMinor = z.coerce
  .number()
  .int('Enter the price in paisa — a whole number.')
  .min(0)
  .max(2_147_483_647, 'The price cannot exceed PKR 21,474,836.47.');

/** A free-shape posting rule the folio lane fills in; never an array or a scalar. */
const postingRule = z.record(z.string(), z.unknown());

/**
 * Everything an operator says about one catalog item.
 *
 * The cross-field rule lives in `.superRefine` rather than in the router, so the
 * page's field-level errors and the API's rejection are the same rejection: an
 * offer price is only meaningful on an item that may be offered before arrival
 * (PROP-05 ★ / UPS-01), and the message lands on `upsellPriceMinor`.
 */
const hotelExtraFields = z.object({
  code: hotelExtraCode,
  name: z.string().trim().min(1).max(160),
  /** Urdu name, where the property publishes one. Blank means "not published". */
  nameUr: z
    .string()
    .trim()
    .max(160)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null)),
  priceMinor,
  taxClass: hotelTaxClass,
  department: z.enum(HotelDepartment),
  postingRule: postingRule.optional(),
  upsellable: z.boolean().default(false),
  upsellPriceMinor: priceMinor.nullable().optional().default(null),
  recurring: z.enum(HotelExtraRecurrence).default(DEFAULT_HOTEL_EXTRA_RECURRENCE),
  active: z.boolean().default(true),
});

/** The one cross-field rule of PROP-05 ★, applied to create and to edit alike. */
function refuseAnOfferPriceNothingCanQuote(
  value: { upsellable: boolean; upsellPriceMinor: number | null },
  ctx: z.RefinementCtx
) {
  if (value.upsellPriceMinor !== null && !value.upsellable)
    ctx.addIssue({
      code: 'custom',
      path: ['upsellPriceMinor'],
      message:
        'An offer price only means something on an item guests may be offered. Mark it upsellable, or clear the offer price.',
    });
}

export const hotelExtraInput = hotelExtraFields.superRefine(refuseAnOfferPriceNothingCanQuote);

export type HotelExtraInput = z.infer<typeof hotelExtraInput>;

/** Editing one item: the same rules, plus which item. */
export const hotelExtraUpdateInput = hotelExtraFields
  .extend({ id: z.string().trim().min(1).max(191) })
  .superRefine(refuseAnOfferPriceNothingCanQuote);

export type HotelExtraUpdateInput = z.infer<typeof hotelExtraUpdateInput>;

/** Retiring one item. The catalog is never deleted — folio lines reference it. */
export const hotelExtraArchiveInput = z.object({
  id: z.string().trim().min(1).max(191),
  active: z.boolean(),
});

/** How the catalog is listed: everything, or only what may still be charged. */
export const hotelExtraListInput = z
  .object({
    includeInactive: z.boolean().default(false),
    department: z.enum(HotelDepartment).optional(),
    upsellableOnly: z.boolean().default(false),
  })
  .default({ includeInactive: false, upsellableOnly: false });

/**
 * A rule the database enforces but the input schema cannot see — a code already
 * taken in this property — stated as a field error, so it reaches the form
 * through `data.validation` exactly like a shape failure does.
 */
export function hotelExtraFieldError(field: string, message: string): ZodError {
  // tRPC preserves Error instances; the plain ZodError constructor is not one
  // in the installed Zod version and loses its validation shape when wrapped.
  return new ZodRealError([{ code: 'custom', path: [field], message, input: undefined }]);
}

/** The department choices, already named for an operator. */
export const hotelDepartmentOptions = HOTEL_DEPARTMENTS.map((department) => ({
  value: department,
  label: HOTEL_DEPARTMENT_LABELS[department],
}));

/** The recurrence choices, with the sentence that says what each one charges. */
export const hotelExtraRecurrenceOptions = HOTEL_EXTRA_RECURRENCES.map((recurring) => ({
  value: recurring,
  label: HOTEL_EXTRA_RECURRENCE_LABELS[recurring],
  description: HOTEL_EXTRA_RECURRENCE_DESCRIPTIONS[recurring],
}));

/**
 * The price a pre-arrival offer quotes for this item (UPS-01). An upsellable item
 * with no offer price is offered at the shelf price; an item that may not be
 * offered has no offer price at all, which is what the caller must check before
 * sending anything.
 */
export function hotelExtraOfferPriceMinor(extra: {
  upsellable: boolean;
  priceMinor: number;
  upsellPriceMinor: number | null;
}): number | null {
  if (!extra.upsellable) return null;
  return extra.upsellPriceMinor ?? extra.priceMinor;
}
