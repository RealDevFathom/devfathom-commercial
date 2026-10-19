/**
 * MEAL-01 / MEAL-02 — meal plans and the entitlements a stay generates from one.
 *
 * Three things live here and nowhere else:
 *
 * - the **shape of a meal plan** (`meals` = `[{meal, outlets[], cutoff_time,
 *   per_person}]`, 05 §1.2) as both a Zod contract and the `MealPlanSnapshot`
 *   type. The snapshot is the frozen copy a reservation room carries, which is
 *   what makes MEAL-01's "changing a meal plan never changes a confirmed
 *   reservation" true: the reservation reads its copy, never this table;
 * - the **default plans** a property is created with (H-D15: EP and CP are what
 *   is sold today; MAP and AP exist but start inactive); and
 * - `generateEntitlements`, MEAL-02's generator. It is a **pure function** — no
 *   database, no clock, no timezone conversion. It takes business dates as
 *   `YYYY-MM-DD` strings in the property's own zone and returns drafts in a
 *   deterministic order, so the same stay generates the same list on a retry and
 *   the caller can key an upsert on it.
 *
 * Naming rule for the vertical: every *column* is camelCase, and everything
 * *inside* a hotel JSONB document is the pack's snake_case. A snapshot is then a
 * literal copy of the plan's `meals`, and a channel push (CH-03) re-spells
 * nothing.
 */
import { z } from 'zod';

/** The three services a plan can cover. Order matters: see `MEAL_ORDER`. */
export const HOTEL_MEALS = ['BREAKFAST', 'LUNCH', 'DINNER'] as const;

export type HotelMeal = (typeof HOTEL_MEALS)[number];

/**
 * The order entitlements are generated in — the order the meals are served in,
 * not alphabetical. Deterministic output is what lets a retry of check-in
 * produce the same list rather than a second one.
 */
const MEAL_ORDER: Record<HotelMeal, number> = { BREAKFAST: 0, LUNCH: 1, DINNER: 2 };

/** Operator-facing names. UX rule 1: no surface prints a bare enum value. */
export const HOTEL_MEAL_LABELS: Record<HotelMeal, string> = {
  BREAKFAST: 'Breakfast',
  LUNCH: 'Lunch',
  DINNER: 'Dinner',
};

/**
 * The industry codes. A property may also invent its own, which is why `code` is
 * text in the database and this list is data rather than an enum.
 */
export const STANDARD_MEAL_PLAN_CODES = ['EP', 'CP', 'MAP', 'AP'] as const;

/** A stay longer than this is a data error, not a tenancy (APARTMENT lets run to a year). */
export const MAX_ENTITLEMENT_NIGHTS = 400;

/** 24-hour local time, as the property's own timezone reads it. */
const time24 = z
  .string()
  .trim()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use 24-hour time, e.g. 09:30.');

/** A business date in the property's own zone. Never a `Date`: no zone maths. */
const businessDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a business date, e.g. 2026-09-08.');

/**
 * One covered service. `outlets` empty means "any outlet of this property" —
 * H-D15 says breakfast is served at one outlet, but no outlet exists until the
 * restaurant side of the property is configured, so an empty list is the honest
 * default rather than a made-up reference.
 */
export const mealPlanEntryInput = z.object({
  meal: z.enum(HOTEL_MEALS),
  outlets: z.array(z.string().trim().min(1).max(191)).max(20).default([]),
  /** Null until the property sets a service cut-off; expiry policy is MEAL-02's. */
  cutoff_time: time24.nullable().default(null),
  /** False = the entitlement belongs to the room, not to an occupant. */
  per_person: z.boolean(),
});

export type MealPlanEntry = z.infer<typeof mealPlanEntryInput>;

/** The `meals` document: at most one entry per service, in service order. */
export const mealPlanMealsInput = z
  .array(mealPlanEntryInput)
  .max(HOTEL_MEALS.length)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.meal)) {
        ctx.addIssue({
          code: 'custom',
          message: `This plan already covers ${HOTEL_MEAL_LABELS[entry.meal].toLowerCase()}.`,
        });
        return;
      }
      seen.add(entry.meal);
    }
  })
  .transform(sortMeals);

/**
 * The plan code. Uppercase and short because it prints on a rate, a voucher and
 * a channel push, where `EP` and `ep` must never be two plans.
 */
export const mealPlanCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(16)
  .regex(
    /^[A-Z0-9][A-Z0-9_-]{0,15}$/,
    'Use uppercase letters, numbers, hyphens or underscores, e.g. CP.'
  );

const planName = z.string().trim().min(2).max(120);

export const mealPlanCreateInput = z.object({
  code: mealPlanCode,
  name: planName,
  /** Empty input is stored as null: an empty string reads as a translation. */
  nameUr: planName.nullable().optional(),
  meals: mealPlanMealsInput,
  active: z.boolean().default(true),
});

export type MealPlanCreateInput = z.infer<typeof mealPlanCreateInput>;

/** The code is deliberately absent: a plan's code is its identity on a voucher. */
export const mealPlanUpdateInput = z.object({
  id: z.string().trim().min(1).max(191),
  name: planName,
  nameUr: planName.nullable().optional(),
  meals: mealPlanMealsInput,
  active: z.boolean(),
});

export type MealPlanUpdateInput = z.infer<typeof mealPlanUpdateInput>;

export const mealPlanSetActiveInput = z.object({
  id: z.string().trim().min(1).max(191),
  active: z.boolean(),
});

/** Service order, so two plans with the same services serialise identically. */
export function sortMeals(entries: readonly MealPlanEntry[]): MealPlanEntry[] {
  return [...entries].sort((left, right) => MEAL_ORDER[left.meal] - MEAL_ORDER[right.meal]);
}

/**
 * A stored `meals` document on its way back out of JSONB. The database validates
 * the same shape (`hotel_meal_plan_meals_valid`), so this parse failing means the
 * row was written by something that bypassed both — worth an exception, not a
 * silent empty plan.
 */
export function parseMealPlanMeals(value: unknown): MealPlanEntry[] {
  return mealPlanMealsInput.parse(value ?? []);
}

/**
 * The frozen copy a reservation room stores (05 §1.4, `meal_snapshot jsonb`).
 * Snake_case throughout because it is a JSONB document, and it carries the plan
 * id only as provenance — nothing reads the plan back through it.
 */
export type MealPlanSnapshot = {
  meal_plan_id: string;
  code: string;
  name: string;
  name_ur: string | null;
  meals: MealPlanEntry[];
};

/** A meal-plan row as this module needs to read it. */
type MealPlanRow = {
  id: string;
  code: string;
  name: string;
  nameUr: string | null;
  meals: unknown;
};

/** Freeze a plan onto a reservation. Called when the reservation is priced. */
export function mealPlanSnapshot(plan: MealPlanRow): MealPlanSnapshot {
  return {
    meal_plan_id: plan.id,
    code: plan.code,
    name: plan.name,
    name_ur: plan.nameUr,
    meals: parseMealPlanMeals(plan.meals),
  };
}

/** One row of `hotel_meal_entitlements` (05 §1.4) before it has an id or a state. */
export type MealEntitlementDraft = {
  /** Null when the plan's entry is `per_person: false` — the room holds it. */
  stayPersonRef: string | null;
  meal: HotelMeal;
  /** The business date the entitlement is for, `YYYY-MM-DD`. */
  date: string;
  /** Empty = any outlet of the property. Copied, never aliased to the snapshot. */
  outlets: string[];
};

export type GenerateEntitlementsInput = {
  snapshot: MealPlanSnapshot;
  /** Business dates in the property's own zone. */
  arrival: string;
  departure: string;
  /** Stay-person references, in the order they should be generated. */
  persons: readonly string[];
};

/**
 * MEAL-02 — the entitlements a stay is owed under its frozen plan.
 *
 * The day rules are the ones a front desk already works to:
 *
 * - **arrival day: no breakfast.** The guest checks in at 14:00; breakfast that
 *   morning was never theirs;
 * - **departure day: breakfast only.** They leave at 12:00, so lunch and dinner
 *   that day belong to a stay they are not on;
 * - every day between gets every service the plan covers.
 *
 * That makes a full-board stay `persons × nights × meals` exactly — MEAL-02's
 * acceptance — because each service shifts by one day rather than being dropped:
 * N breakfasts on days 2..N+1, N lunches and N dinners on days 1..N.
 *
 * A zero-night stay (arrival = departure) is both an arrival day and a departure
 * day, so it generates nothing. Day-use sales carry their own extras rather than
 * a meal plan, and a day guest is never owed a breakfast they slept elsewhere for.
 *
 * Order is date, then service order, then the caller's person order, and room-level
 * entitlements (`per_person: false`) sort with the person-level ones for their
 * meal. Pure: no database, no clock, no timezone conversion.
 */
export function generateEntitlements(input: GenerateEntitlementsInput): MealEntitlementDraft[] {
  const arrival = businessDate.parse(input.arrival);
  const departure = businessDate.parse(input.departure);

  const arrivalDay = dayNumber(arrival);
  const departureDay = dayNumber(departure);
  if (departureDay < arrivalDay) {
    throw new RangeError(`Departure ${departure} is before arrival ${arrival}.`);
  }
  if (departureDay - arrivalDay > MAX_ENTITLEMENT_NIGHTS) {
    throw new RangeError(
      `A stay of ${departureDay - arrivalDay} nights is longer than the ${MAX_ENTITLEMENT_NIGHTS}-night limit.`
    );
  }

  if (input.persons.length === 0) {
    throw new RangeError('A stay has at least one person; entitlements need one to belong to.');
  }
  if (new Set(input.persons).size !== input.persons.length) {
    throw new RangeError('The same stay person was listed twice.');
  }

  const meals = sortMeals(parseMealPlanMeals(input.snapshot.meals));
  const drafts: MealEntitlementDraft[] = [];

  for (let day = arrivalDay; day <= departureDay; day += 1) {
    const date = isoDate(day);
    const isArrivalDay = day === arrivalDay;
    const isDepartureDay = day === departureDay;

    for (const entry of meals) {
      if (isArrivalDay && entry.meal === 'BREAKFAST') continue;
      if (isDepartureDay && entry.meal !== 'BREAKFAST') continue;

      if (!entry.per_person) {
        drafts.push({ stayPersonRef: null, meal: entry.meal, date, outlets: [...entry.outlets] });
        continue;
      }
      for (const stayPersonRef of input.persons) {
        drafts.push({ stayPersonRef, meal: entry.meal, date, outlets: [...entry.outlets] });
      }
    }
  }

  return drafts;
}

/**
 * Days since the epoch for a `YYYY-MM-DD` business date, rejecting dates the
 * calendar does not have (2026-02-30). `Date.UTC` is arithmetic on three
 * integers here, not a moment in time: no zone is ever consulted, which is why
 * adding one to the result is always the next business day.
 */
function dayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const stamp = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(stamp);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new RangeError(`${date} is not a date on the calendar.`);
  }
  return Math.round(stamp / 86_400_000);
}

/** The inverse of `dayNumber`. */
function isoDate(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * H-D15 — the plans a property opens with.
 *
 * EP and CP are what is sold today and are created active. MAP and AP are
 * created **inactive** rather than left out: a property that starts selling half
 * board enables a plan instead of inventing one, and every property in the estate
 * then means the same thing by "MAP".
 *
 * No cut-off times and no outlets are seeded. H-D15 fixes which plans are sold,
 * not when service closes or where it is served, and no outlet exists at a
 * property that has just been created — pre-filling either would be the "seed
 * data fakes configuration" move the onboarding checklist exists to refuse.
 */
export const DEFAULT_HOTEL_MEAL_PLANS: readonly {
  code: (typeof STANDARD_MEAL_PLAN_CODES)[number];
  name: string;
  nameUr: string;
  meals: MealPlanEntry[];
  active: boolean;
}[] = [
  {
    code: 'EP',
    name: 'Room only',
    nameUr: 'صرف کمرہ',
    meals: [],
    active: true,
  },
  {
    code: 'CP',
    name: 'Bed & breakfast',
    nameUr: 'کمرہ اور ناشتہ',
    meals: [{ meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: true }],
    active: true,
  },
  {
    code: 'MAP',
    name: 'Half board',
    nameUr: 'ناشتہ اور رات کا کھانا',
    meals: [
      { meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: true },
      { meal: 'DINNER', outlets: [], cutoff_time: null, per_person: true },
    ],
    active: false,
  },
  {
    code: 'AP',
    name: 'Full board',
    nameUr: 'ناشتہ، دوپہر اور رات کا کھانا',
    meals: [
      { meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: true },
      { meal: 'LUNCH', outlets: [], cutoff_time: null, per_person: true },
      { meal: 'DINNER', outlets: [], cutoff_time: null, per_person: true },
    ],
    active: false,
  },
];
