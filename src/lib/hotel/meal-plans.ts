import { businessDateToUtcDate, parseCutoffMinutes } from '../restaurant/business-date';

export type Meal = 'BREAKFAST' | 'LUNCH' | 'DINNER';

export type MealPlanMeal = Readonly<{
  meal: Meal;
  outlets: readonly string[];
  /** Property-local HH:MM; carried through for the future consumption policy. */
  cutoffTime: string;
  perPerson: boolean;
}>;

/** Copy a configured plan with createMealPlanSnapshot before confirming a reservation. */
export type MealPlanSnapshot = Readonly<{
  id: string;
  code: string;
  name: string;
  /** Explicit configuration, including MAP's lunch/dinner choice; code implies no defaults. */
  meals: readonly MealPlanMeal[];
}>;

/** A generation draft, without a persisted ID, redemption state or financial posting. */
export type MealEntitlement = Readonly<{
  date: string;
  meal: Meal;
  roomId: string;
  outlets: readonly string[];
  cutoffTime: string;
}> &
  (
    | Readonly<{ scope: 'PERSON'; stayPersonId: string }>
    | Readonly<{ scope: 'ROOM'; stayPersonId: null }>
  );

function assertIdentity(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace.`);
  }
}

/** Deep-copy and freeze the plan so subsequent configuration edits cannot change it. */
export function createMealPlanSnapshot(plan: MealPlanSnapshot): MealPlanSnapshot {
  assertIdentity(plan.id, 'Meal plan ID');
  assertIdentity(plan.code, 'Meal plan code');
  assertIdentity(plan.name, 'Meal plan name');
  const seen = new Set<Meal>();
  const meals = Array.from(plan.meals, (entry): MealPlanMeal => {
    if (!['BREAKFAST', 'LUNCH', 'DINNER'].includes(entry.meal) || seen.has(entry.meal)) {
      throw new Error('Each configured meal must be BREAKFAST, LUNCH or DINNER and occur once.');
    }
    seen.add(entry.meal);
    parseCutoffMinutes(entry.cutoffTime);
    if (typeof entry.perPerson !== 'boolean') {
      throw new Error('perPerson must be a boolean.');
    }
    for (const outlet of entry.outlets) assertIdentity(outlet, 'Outlet ID');
    if (new Set(entry.outlets).size !== entry.outlets.length) {
      throw new Error('Outlet IDs must be unique within a meal.');
    }
    return Object.freeze({
      meal: entry.meal,
      outlets: Object.freeze([...entry.outlets]),
      cutoffTime: entry.cutoffTime,
      perPerson: entry.perPerson,
    });
  });
  return Object.freeze({
    id: plan.id,
    code: plan.code,
    name: plan.name,
    meals: Object.freeze(meals),
  });
}

/**
 * Generate from a reservation's snapshot, never the current rate/meal plan.
 * Dates are property-local YYYY-MM-DD labels (existing parser: years 0100–9999),
 * not instants. Departure must follow arrival; day-use is outside this contract.
 * Breakfast runs after arrival through departure; other meals run from arrival
 * until the day before departure. Every configured meal therefore occurs once
 * per night, per supplied person, or once per room when perPerson is false.
 *
 * persons must contain at least one unique, actual hotel_stay_persons ID for this
 * room; roomId is the explicit assigned room identity. The future caller must
 * resolve both under trusted tenant/branch/stay scope. This helper cannot prove
 * ownership and never derives IDs from counts, positions or another person.
 *
 * Output order: date ascending, then snapshot meal order, then supplied person
 * order. Inputs are never mutated/frozen; output is detached and deeply frozen.
 * Outlet lists (including empty lists) and local cut-offs are preserved exactly;
 * no outlet authorization, current-clock eligibility or expiry is inferred here.
 * Persistence, room-scope uniqueness, RLS, redemption, billing and idempotency
 * belong to future consuming lanes. Repeated calls return equal draft values.
 */
export function generateEntitlements(
  snapshot: MealPlanSnapshot,
  arrival: string,
  departure: string,
  persons: readonly string[],
  roomId: string
): readonly MealEntitlement[] {
  const start = businessDateToUtcDate(arrival);
  const end = businessDateToUtcDate(departure);
  if (end <= start) {
    throw new Error('Departure must be after arrival.');
  }
  assertIdentity(roomId, 'Room ID');
  if (!Array.isArray(persons) || persons.length === 0) {
    throw new Error('At least one actual stay-person ID is required.');
  }
  for (const person of persons) assertIdentity(person, 'Stay-person ID');
  if (new Set(persons).size !== persons.length) {
    throw new Error('Stay-person IDs must be unique.');
  }
  const plan = createMealPlanSnapshot(snapshot);
  const entitlements: MealEntitlement[] = [];
  if (plan.meals.length === 0) return Object.freeze(entitlements);

  for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    for (const entry of plan.meals) {
      if (entry.meal === 'BREAKFAST' ? date === arrival : date === departure) continue;
      const common = {
        date,
        meal: entry.meal,
        roomId,
        outlets: entry.outlets,
        cutoffTime: entry.cutoffTime,
      };
      if (entry.perPerson) {
        for (const stayPersonId of persons) {
          entitlements.push(Object.freeze({ ...common, scope: 'PERSON', stayPersonId }));
        }
      } else {
        entitlements.push(Object.freeze({ ...common, scope: 'ROOM', stayPersonId: null }));
      }
    }
  }
  return Object.freeze(entitlements);
}
