/**
 * MEAL-01 / MEAL-02 — the meal-plan contract and the entitlement generator.
 *
 * The generator is the whole reason this lane exists, so it is tested as an
 * arithmetic claim rather than a snapshot: MEAL-02's acceptance is "entitlement
 * count = persons × nights × meals", and that only holds because the arrival and
 * departure rules *shift* each service by a day instead of dropping it. Every
 * count below is derived from persons/nights/meals rather than typed out, so a
 * change to the day rules fails here with the arithmetic it broke.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HOTEL_MEAL_PLANS,
  MAX_ENTITLEMENT_NIGHTS,
  generateEntitlements,
  mealPlanCreateInput,
  mealPlanMealsInput,
  mealPlanSnapshot,
  parseMealPlanMeals,
  type HotelMeal,
  type MealEntitlementDraft,
  type MealPlanEntry,
  type MealPlanSnapshot,
} from './meal-plans';

/** A plan by the meals it covers, so a test names a board basis, not a document. */
function plan(
  code: string,
  meals: { meal: HotelMeal; per_person?: boolean; outlets?: string[] }[]
): MealPlanSnapshot {
  return {
    meal_plan_id: `plan_${code.toLowerCase()}`,
    code,
    name: code,
    name_ur: null,
    meals: meals.map((entry) => ({
      meal: entry.meal,
      outlets: entry.outlets ?? [],
      cutoff_time: null,
      per_person: entry.per_person ?? true,
    })),
  };
}

const EP = plan('EP', []);
const CP = plan('CP', [{ meal: 'BREAKFAST' }]);
const MAP = plan('MAP', [{ meal: 'BREAKFAST' }, { meal: 'DINNER' }]);
const AP = plan('AP', [{ meal: 'BREAKFAST' }, { meal: 'LUNCH' }, { meal: 'DINNER' }]);

function countOf(drafts: MealEntitlementDraft[], meal: HotelMeal): number {
  return drafts.filter((draft) => draft.meal === meal).length;
}

function datesOf(drafts: MealEntitlementDraft[], meal: HotelMeal): string[] {
  return [...new Set(drafts.filter((draft) => draft.meal === meal).map((draft) => draft.date))];
}

describe('generateEntitlements — MEAL-02 counts', () => {
  it('generates persons × nights × meals for a full-board stay', () => {
    const persons = ['sp_1', 'sp_2', 'sp_3'];
    const nights = 4;

    const drafts = generateEntitlements({
      snapshot: AP,
      arrival: '2026-09-08',
      departure: '2026-09-12',
      persons,
    });

    // The acceptance criterion itself, derived rather than typed.
    expect(drafts).toHaveLength(persons.length * nights * AP.meals.length);
    for (const meal of ['BREAKFAST', 'LUNCH', 'DINNER'] as const) {
      expect(countOf(drafts, meal)).toBe(persons.length * nights);
    }

    // Each service is shifted, not dropped: breakfast starts the morning after
    // arrival and includes the departure morning; lunch and dinner stop the
    // night before departure.
    expect(datesOf(drafts, 'BREAKFAST')).toEqual([
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
    ]);
    expect(datesOf(drafts, 'DINNER')).toEqual([
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
    ]);
    expect(datesOf(drafts, 'LUNCH')).toEqual(datesOf(drafts, 'DINNER'));
  });

  it('gives a half-board stay two services a night and nothing else', () => {
    const persons = ['sp_1', 'sp_2'];
    const nights = 3;

    const drafts = generateEntitlements({
      snapshot: MAP,
      arrival: '2026-09-08',
      departure: '2026-09-11',
      persons,
    });

    expect(drafts).toHaveLength(persons.length * nights * MAP.meals.length);
    expect(countOf(drafts, 'BREAKFAST')).toBe(persons.length * nights);
    expect(countOf(drafts, 'DINNER')).toBe(persons.length * nights);
    // A plan that does not cover lunch never produces one, on any day.
    expect(countOf(drafts, 'LUNCH')).toBe(0);
  });

  it('gives a one-night bed & breakfast stay exactly one breakfast per person', () => {
    const drafts = generateEntitlements({
      snapshot: CP,
      arrival: '2026-09-08',
      departure: '2026-09-09',
      persons: ['sp_1', 'sp_2'],
    });

    expect(drafts).toEqual([
      { stayPersonRef: 'sp_1', meal: 'BREAKFAST', date: '2026-09-09', outlets: [] },
      { stayPersonRef: 'sp_2', meal: 'BREAKFAST', date: '2026-09-09', outlets: [] },
    ]);
  });

  it('gives a one-night full-board stay dinner on arrival and breakfast on departure', () => {
    const drafts = generateEntitlements({
      snapshot: AP,
      arrival: '2026-09-08',
      departure: '2026-09-09',
      persons: ['sp_1'],
    });

    expect(drafts).toEqual([
      { stayPersonRef: 'sp_1', meal: 'LUNCH', date: '2026-09-08', outlets: [] },
      { stayPersonRef: 'sp_1', meal: 'DINNER', date: '2026-09-08', outlets: [] },
      { stayPersonRef: 'sp_1', meal: 'BREAKFAST', date: '2026-09-09', outlets: [] },
    ]);
  });

  it('never owes a breakfast on the arrival day or a dinner on the departure day', () => {
    const drafts = generateEntitlements({
      snapshot: AP,
      arrival: '2026-09-08',
      departure: '2026-09-10',
      persons: ['sp_1'],
    });

    expect(drafts.filter((d) => d.date === '2026-09-08').map((d) => d.meal)).toEqual([
      'LUNCH',
      'DINNER',
    ]);
    expect(drafts.filter((d) => d.date === '2026-09-10').map((d) => d.meal)).toEqual(['BREAKFAST']);
  });

  it('generates nothing for a room-only plan and nothing for a zero-night stay', () => {
    expect(
      generateEntitlements({
        snapshot: EP,
        arrival: '2026-09-08',
        departure: '2026-09-12',
        persons: ['sp_1'],
      })
    ).toEqual([]);

    // Arrival day and departure day at once: no breakfast, and breakfast only.
    expect(
      generateEntitlements({
        snapshot: AP,
        arrival: '2026-09-08',
        departure: '2026-09-08',
        persons: ['sp_1'],
      })
    ).toEqual([]);
  });

  it('crosses a month and a leap day without losing a night', () => {
    const drafts = generateEntitlements({
      snapshot: CP,
      arrival: '2028-02-27',
      departure: '2028-03-02',
      persons: ['sp_1'],
    });

    expect(drafts.map((draft) => draft.date)).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
      '2028-03-02',
    ]);
  });
});

describe('generateEntitlements — per_person and custom plans', () => {
  it('gives one entitlement per room per meal when a service is not per person', () => {
    const roomBreakfast = plan('CP-ROOM', [{ meal: 'BREAKFAST', per_person: false }]);
    const nights = 3;

    const drafts = generateEntitlements({
      snapshot: roomBreakfast,
      arrival: '2026-09-08',
      departure: '2026-09-11',
      persons: ['sp_1', 'sp_2', 'sp_3', 'sp_4'],
    });

    // Four occupants, still one breakfast a morning: the room holds it.
    expect(drafts).toHaveLength(nights);
    expect(drafts.every((draft) => draft.stayPersonRef === null)).toBe(true);
    expect(drafts.map((draft) => draft.date)).toEqual(['2026-09-09', '2026-09-10', '2026-09-11']);
  });

  it('mixes per-room and per-person services inside one custom plan', () => {
    const custom = plan('IFTAR', [
      { meal: 'BREAKFAST', per_person: false, outlets: ['outlet_terrace'] },
      { meal: 'DINNER', per_person: true, outlets: ['outlet_terrace', 'outlet_hall'] },
    ]);

    const drafts = generateEntitlements({
      snapshot: custom,
      arrival: '2026-09-08',
      departure: '2026-09-10',
      persons: ['sp_1', 'sp_2'],
    });

    // 2 nights: 2 room breakfasts + 2 nights × 2 persons of dinner.
    expect(drafts).toHaveLength(2 + 4);
    expect(countOf(drafts, 'BREAKFAST')).toBe(2);
    expect(countOf(drafts, 'DINNER')).toBe(4);
    // The covered outlets ride on the entitlement — that is what the restaurant
    // seam (MEAL-03) will look an in-house guest up against.
    for (const draft of drafts) {
      expect(draft.outlets).toEqual(
        draft.meal === 'BREAKFAST' ? ['outlet_terrace'] : ['outlet_terrace', 'outlet_hall']
      );
    }
  });

  it('copies the outlets rather than aliasing the snapshot', () => {
    const custom = plan('CUSTOM', [{ meal: 'DINNER', outlets: ['outlet_one'] }]);
    const drafts = generateEntitlements({
      snapshot: custom,
      arrival: '2026-09-08',
      departure: '2026-09-10',
      persons: ['sp_1'],
    });

    drafts[0]!.outlets.push('outlet_smuggled');
    expect(custom.meals[0]!.outlets).toEqual(['outlet_one']);
    expect(drafts[1]!.outlets).toEqual(['outlet_one']);
  });

  it('is deterministic: date, then service order, then the caller’s person order', () => {
    const input = {
      snapshot: AP,
      arrival: '2026-09-08',
      departure: '2026-09-10',
      persons: ['sp_b', 'sp_a'],
    } as const;

    const first = generateEntitlements(input);
    const second = generateEntitlements(input);
    expect(second).toEqual(first);

    expect(
      first.slice(0, 5).map((draft) => `${draft.date} ${draft.meal} ${draft.stayPersonRef}`)
    ).toEqual([
      '2026-09-08 LUNCH sp_b',
      '2026-09-08 LUNCH sp_a',
      '2026-09-08 DINNER sp_b',
      '2026-09-08 DINNER sp_a',
      '2026-09-09 BREAKFAST sp_b',
    ]);

    // Order does not depend on how the plan document happened to be written:
    // the same services listed backwards generate the same list.
    const reversed: MealPlanSnapshot = { ...AP, meals: [...AP.meals].reverse() };
    expect(generateEntitlements({ ...input, snapshot: reversed })).toEqual(first);
  });
});

describe('generateEntitlements — refusals', () => {
  const base = { snapshot: CP, arrival: '2026-09-08', departure: '2026-09-10' };

  it('refuses a departure before the arrival', () => {
    expect(() =>
      generateEntitlements({
        snapshot: CP,
        arrival: '2026-09-10',
        departure: '2026-09-08',
        persons: ['sp_1'],
      })
    ).toThrow(/before arrival/);
  });

  it('refuses a date the calendar does not have', () => {
    expect(() =>
      generateEntitlements({ ...base, arrival: '2026-02-30', persons: ['sp_1'] })
    ).toThrow(/not a date on the calendar/);
    expect(() =>
      generateEntitlements({ ...base, arrival: '08-09-2026', persons: ['sp_1'] })
    ).toThrow();
  });

  it('refuses a stay with no persons and one that lists a person twice', () => {
    expect(() => generateEntitlements({ ...base, persons: [] })).toThrow(/at least one person/);
    expect(() => generateEntitlements({ ...base, persons: ['sp_1', 'sp_1'] })).toThrow(
      /listed twice/
    );
  });

  it('refuses a stay longer than the generator’s limit', () => {
    const departure = new Date(Date.UTC(2026, 8, 8) + (MAX_ENTITLEMENT_NIGHTS + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(() =>
      generateEntitlements({ snapshot: CP, arrival: '2026-09-08', departure, persons: ['sp_1'] })
    ).toThrow(new RegExp(`${MAX_ENTITLEMENT_NIGHTS}-night limit`));
  });

  it('refuses a snapshot whose document is not a plan', () => {
    const corrupt = { ...CP, meals: [{ meal: 'BRUNCH' }] as unknown as MealPlanEntry[] };
    expect(() =>
      generateEntitlements({
        snapshot: corrupt,
        arrival: '2026-09-08',
        departure: '2026-09-10',
        persons: ['sp_1'],
      })
    ).toThrow();
  });
});

describe('the meal-plan document', () => {
  it('fills the optional members and sorts services into serving order', () => {
    const meals = mealPlanMealsInput.parse([
      { meal: 'DINNER', per_person: true },
      { meal: 'BREAKFAST', per_person: false, cutoff_time: '10:30', outlets: ['outlet_one'] },
    ]);

    expect(meals).toEqual([
      { meal: 'BREAKFAST', outlets: ['outlet_one'], cutoff_time: '10:30', per_person: false },
      { meal: 'DINNER', outlets: [], cutoff_time: null, per_person: true },
    ]);
  });

  it('refuses two of the same service, an unknown service and a bad cut-off', () => {
    expect(() =>
      mealPlanMealsInput.parse([
        { meal: 'BREAKFAST', per_person: true },
        { meal: 'BREAKFAST', per_person: false },
      ])
    ).toThrow(/already covers breakfast/);
    expect(() => mealPlanMealsInput.parse([{ meal: 'BRUNCH', per_person: true }])).toThrow();
    expect(() =>
      mealPlanMealsInput.parse([{ meal: 'LUNCH', per_person: true, cutoff_time: '2pm' }])
    ).toThrow();
    // `per_person` is a decision, never a default: a plan has to say.
    expect(() => mealPlanMealsInput.parse([{ meal: 'LUNCH' }])).toThrow();
  });

  it('uppercases a code and refuses one no voucher could print', () => {
    expect(mealPlanCreateInput.parse({ code: 'cp', name: 'Bed & breakfast', meals: [] }).code).toBe(
      'CP'
    );
    for (const code of ['', 'a plan', '-CP', 'TOO-LONG-A-PLAN-CODE']) {
      expect(() =>
        mealPlanCreateInput.parse({ code, name: 'Bed & breakfast', meals: [] })
      ).toThrow();
    }
    // Active unless the property says otherwise.
    expect(
      mealPlanCreateInput.parse({ code: 'CP', name: 'Bed & breakfast', meals: [] }).active
    ).toBe(true);
  });

  it('freezes a plan row into the snapshot a reservation will carry', () => {
    const snapshot = mealPlanSnapshot({
      id: 'plan_1',
      code: 'CP',
      name: 'Bed & breakfast',
      nameUr: 'کمرہ اور ناشتہ',
      meals: [{ meal: 'BREAKFAST', per_person: true, outlets: [], cutoff_time: null }],
    });

    // Snake_case throughout: the snapshot is a literal copy of the JSONB, not a
    // re-spelling of it, which is what lets a channel push reuse it.
    expect(snapshot).toEqual({
      meal_plan_id: 'plan_1',
      code: 'CP',
      name: 'Bed & breakfast',
      name_ur: 'کمرہ اور ناشتہ',
      meals: [{ meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: true }],
    });
  });

  it('reads an absent document as a plan that covers nothing', () => {
    expect(parseMealPlanMeals(null)).toEqual([]);
    expect(parseMealPlanMeals([])).toEqual([]);
    expect(() => parseMealPlanMeals({ meal: 'BREAKFAST' })).toThrow();
  });
});

describe('the plans a property opens with (H-D15)', () => {
  it('sells room-only and bed & breakfast, and keeps half and full board in reserve', () => {
    const byCode = Object.fromEntries(DEFAULT_HOTEL_MEAL_PLANS.map((p) => [p.code, p] as const));
    expect(Object.keys(byCode).sort()).toEqual(['AP', 'CP', 'EP', 'MAP']);

    expect(byCode.EP!.active).toBe(true);
    expect(byCode.EP!.meals).toEqual([]);
    expect(byCode.CP!.active).toBe(true);
    expect(byCode.CP!.meals.map((entry) => entry.meal)).toEqual(['BREAKFAST']);

    // Available but not sold until an operator turns them on.
    expect(byCode.MAP!.active).toBe(false);
    expect(byCode.MAP!.meals.map((entry) => entry.meal)).toEqual(['BREAKFAST', 'DINNER']);
    expect(byCode.AP!.active).toBe(false);
    expect(byCode.AP!.meals.map((entry) => entry.meal)).toEqual(['BREAKFAST', 'LUNCH', 'DINNER']);
  });

  it('is bilingual, per person, and invents no outlet or cut-off', () => {
    for (const defaultPlan of DEFAULT_HOTEL_MEAL_PLANS) {
      expect(defaultPlan.nameUr.trim().length).toBeGreaterThan(0);
      // The document each default carries is exactly what the contract accepts.
      expect(mealPlanMealsInput.parse(defaultPlan.meals)).toEqual(defaultPlan.meals);
      for (const entry of defaultPlan.meals) {
        expect(entry.per_person).toBe(true);
        // No outlet exists at a property that was created a moment ago, and
        // H-D15 fixes which plans are sold, not when service closes.
        expect(entry.outlets).toEqual([]);
        expect(entry.cutoff_time).toBeNull();
      }
    }
  });

  it('generates the board basis its name claims', () => {
    const asSnapshot = (code: string): MealPlanSnapshot => {
      const defaultPlan = DEFAULT_HOTEL_MEAL_PLANS.find((p) => p.code === code)!;
      return {
        meal_plan_id: `plan_${code}`,
        code,
        name: defaultPlan.name,
        name_ur: defaultPlan.nameUr,
        meals: defaultPlan.meals,
      };
    };
    const stay = { arrival: '2026-09-08', departure: '2026-09-11', persons: ['sp_1', 'sp_2'] };

    expect(generateEntitlements({ ...stay, snapshot: asSnapshot('EP') })).toHaveLength(0);
    expect(generateEntitlements({ ...stay, snapshot: asSnapshot('CP') })).toHaveLength(2 * 3);
    expect(generateEntitlements({ ...stay, snapshot: asSnapshot('MAP') })).toHaveLength(2 * 3 * 2);
    expect(generateEntitlements({ ...stay, snapshot: asSnapshot('AP') })).toHaveLength(2 * 3 * 3);
  });
});
