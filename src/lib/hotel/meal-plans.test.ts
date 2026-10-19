// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  createMealPlanSnapshot,
  generateEntitlements,
  type Meal,
  type MealPlanMeal,
  type MealPlanSnapshot,
} from './meal-plans';

function plan(meals: readonly Meal[], code = 'CUSTOM'): MealPlanSnapshot {
  return {
    id: 'meal-plan-1',
    code,
    name: 'Configured meals',
    meals: meals.map((meal) => ({
      meal,
      outlets: ['outlet-1'],
      cutoffTime: meal === 'BREAKFAST' ? '10:30' : '22:00',
      perPerson: true,
    })),
  };
}

const persons = ['stay-person-a', 'stay-person-b'] as const;
const arrival = '2026-09-12';
const departure = '2026-09-14';
const roomId = 'room-101';

describe('meal-plan snapshot', () => {
  it('detaches and freezes every level without freezing or mutating configuration', () => {
    const configured = {
      id: 'plan-1',
      code: 'CP',
      name: 'Breakfast',
      meals: [
        { meal: 'BREAKFAST' as const, outlets: ['cafe'], cutoffTime: '10:30', perPerson: true },
      ],
    };
    const before = structuredClone(configured);
    const snapshot = createMealPlanSnapshot(configured);
    expect(snapshot).toEqual(before);
    expect(configured).toEqual(before);
    expect(Object.isFrozen(configured.meals[0].outlets)).toBe(false);
    configured.name = 'New name';
    configured.meals[0].outlets.push('new-outlet');
    configured.meals[0].cutoffTime = '09:00';
    configured.meals.length = 0;
    expect(snapshot).toEqual(before);
    for (const value of [snapshot, snapshot.meals, snapshot.meals[0], snapshot.meals[0].outlets]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Reflect.set(snapshot.meals[0], 'cutoffTime', '11:00')).toBe(false);
    expect(Reflect.set(snapshot.meals[0].outlets, '0', 'changed')).toBe(false);
    expect(generateEntitlements(snapshot, arrival, departure, persons, roomId)).toHaveLength(4);
  });

  it.each(['24:00', '10:60', '9:00', '10:30:00', ''])(
    'rejects invalid cut-off %j',
    (cutoffTime) => {
      const snapshot = plan(['BREAKFAST']);
      expect(() =>
        createMealPlanSnapshot({ ...snapshot, meals: [{ ...snapshot.meals[0], cutoffTime }] })
      ).toThrow();
    }
  );

  it.each([
    { meal: 'SNACK' },
    { perPerson: 'true' },
    { outlets: [''] },
    { outlets: ['cafe', 'cafe'] },
    { outlets: new Array<string>(1) },
  ])('rejects invalid meal configuration %j', (override) => {
    const snapshot = plan(['BREAKFAST']);
    const meal = { ...snapshot.meals[0], ...override } as MealPlanMeal;
    expect(() => createMealPlanSnapshot({ ...snapshot, meals: [meal] })).toThrow();
  });

  it('rejects duplicate meal definitions before generating duplicate grants', () => {
    expect(() =>
      generateEntitlements(plan(['BREAKFAST', 'BREAKFAST']), arrival, departure, persons, roomId)
    ).toThrow(/occur once/);
  });

  it('rejects sparse meal definitions when taking a snapshot', () => {
    expect(() =>
      createMealPlanSnapshot({ ...plan([]), meals: new Array<MealPlanMeal>(1) })
    ).toThrow();
  });

  it.each(['id', 'code', 'name'] as const)('rejects an empty plan %s', (field) => {
    expect(() => createMealPlanSnapshot({ ...plan([]), [field]: '' })).toThrow(/non-empty/);
  });
});

describe('entitlement generation', () => {
  it.each([
    ['EP', [], 0],
    ['CP', ['BREAKFAST'], 4],
    ['MAP', ['BREAKFAST', 'DINNER'], 8],
    ['MAP', ['BREAKFAST', 'LUNCH'], 8],
    ['AP', ['BREAKFAST', 'LUNCH', 'DINNER'], 12],
    ['CUSTOM', ['LUNCH'], 4],
    ['CUSTOM', ['LUNCH', 'DINNER'], 8],
  ] as const)('%s with %j grants persons × nights × meals', (code, meals, count) => {
    const result = generateEntitlements(plan(meals, code), arrival, departure, persons, roomId);
    expect(result).toHaveLength(count);
    expect(new Set(result.map((row) => `${row.date}/${row.meal}/${row.stayPersonId}`)).size).toBe(
      count
    );
    expect(
      result.every(
        (row) =>
          row.scope === 'PERSON' && persons.includes(row.stayPersonId as (typeof persons)[number])
      )
    ).toBe(true);
  });

  it('uses explicit meals even when the code names a different standard plan', () => {
    const result = generateEntitlements(
      plan(['DINNER'], 'CP'),
      arrival,
      departure,
      persons,
      roomId
    );
    expect(result.map((row) => row.meal)).toEqual(['DINNER', 'DINNER', 'DINNER', 'DINNER']);
  });

  it('enforces exact one-night arrival/departure boundaries', () => {
    const result = generateEntitlements(
      plan(['BREAKFAST', 'LUNCH', 'DINNER']),
      arrival,
      '2026-09-13',
      ['actual-person'],
      roomId
    );
    expect(result.map(({ date, meal, stayPersonId }) => ({ date, meal, stayPersonId }))).toEqual([
      { date: arrival, meal: 'LUNCH', stayPersonId: 'actual-person' },
      { date: arrival, meal: 'DINNER', stayPersonId: 'actual-person' },
      { date: '2026-09-13', meal: 'BREAKFAST', stayPersonId: 'actual-person' },
    ]);
  });

  it('orders by date, configured meals, then supplied persons, including full interior days', () => {
    const result = generateEntitlements(
      plan(['DINNER', 'BREAKFAST', 'LUNCH']),
      arrival,
      departure,
      persons,
      roomId
    );
    expect(result.map((row) => [row.date, row.meal, row.stayPersonId])).toEqual([
      [arrival, 'DINNER', persons[0]],
      [arrival, 'DINNER', persons[1]],
      [arrival, 'LUNCH', persons[0]],
      [arrival, 'LUNCH', persons[1]],
      ['2026-09-13', 'DINNER', persons[0]],
      ['2026-09-13', 'DINNER', persons[1]],
      ['2026-09-13', 'BREAKFAST', persons[0]],
      ['2026-09-13', 'BREAKFAST', persons[1]],
      ['2026-09-13', 'LUNCH', persons[0]],
      ['2026-09-13', 'LUNCH', persons[1]],
      [departure, 'BREAKFAST', persons[0]],
      [departure, 'BREAKFAST', persons[1]],
    ]);
  });

  it('emits one grant per room meal, retaining actual person IDs only for per-person meals', () => {
    const snapshot = plan(['BREAKFAST', 'DINNER']);
    const mixed = {
      ...snapshot,
      meals: [snapshot.meals[0], { ...snapshot.meals[1], perPerson: false }],
    };
    const result = generateEntitlements(
      mixed,
      arrival,
      departure,
      [...persons, 'person-c'],
      roomId
    );
    expect(result.filter((row) => row.scope === 'PERSON')).toHaveLength(6);
    expect(result.filter((row) => row.scope === 'ROOM')).toEqual([
      {
        date: arrival,
        meal: 'DINNER',
        roomId,
        outlets: ['outlet-1'],
        cutoffTime: '22:00',
        scope: 'ROOM',
        stayPersonId: null,
      },
      {
        date: '2026-09-13',
        meal: 'DINNER',
        roomId,
        outlets: ['outlet-1'],
        cutoffTime: '22:00',
        scope: 'ROOM',
        stayPersonId: null,
      },
    ]);
    const otherRoom = generateEntitlements(mixed, arrival, departure, persons, 'room-202');
    expect(otherRoom.every((row) => row.roomId === 'room-202')).toBe(true);
  });

  it('makes all-room plans independent of person count without borrowing a person identity', () => {
    const snapshot = plan(['BREAKFAST', 'LUNCH', 'DINNER']);
    const perRoom = {
      ...snapshot,
      meals: snapshot.meals.map((entry) => ({ ...entry, perPerson: false })),
    };
    const single = generateEntitlements(perRoom, arrival, departure, ['person-a'], roomId);
    expect(single).toHaveLength(6);
    expect(single).toEqual(generateEntitlements(perRoom, arrival, departure, persons, roomId));
    expect(single.every((row) => row.scope === 'ROOM' && row.stayPersonId === null)).toBe(true);
  });

  it('preserves outlet and cut-off policy, detaches/freeze results, and never mutates inputs', () => {
    const snapshot = plan(['BREAKFAST']);
    const before = structuredClone(snapshot);
    const people = [...persons];
    const result = generateEntitlements(snapshot, arrival, departure, people, roomId);
    expect(snapshot).toEqual(before);
    expect(people).toEqual(persons);
    expect(Object.isFrozen(snapshot)).toBe(false);
    expect(Object.isFrozen(snapshot.meals[0].outlets)).toBe(false);
    expect(Object.isFrozen(people)).toBe(false);
    expect(result).toEqual(generateEntitlements(snapshot, arrival, departure, people, roomId));
    expect(result[0]).toMatchObject({ outlets: ['outlet-1'], cutoffTime: '10:30', roomId });
    expect(result[0].outlets).not.toBe(snapshot.meals[0].outlets);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every((row) => Object.isFrozen(row) && Object.isFrozen(row.outlets))).toBe(true);
    expect(Reflect.set(result[0].outlets, '0', 'changed')).toBe(false);
    expect(Reflect.set(result[0], 'stayPersonId', 'fabricated')).toBe(false);
  });

  it('accepts frozen inputs and preserves empty outlet policy and midnight cut-off', () => {
    const snapshot = plan(['BREAKFAST']);
    const frozen = createMealPlanSnapshot({
      ...snapshot,
      meals: [{ ...snapshot.meals[0], outlets: [], cutoffTime: '00:00' }],
    });
    const result = generateEntitlements(
      frozen,
      arrival,
      departure,
      Object.freeze([...persons]),
      roomId
    );
    expect(result).toHaveLength(4);
    expect(result.every((row) => row.cutoffTime === '00:00' && row.outlets.length === 0)).toBe(
      true
    );
  });

  it.each([
    ['2028-02-28', '2028-03-01', ['2028-02-29', '2028-03-01']],
    ['2026-12-31', '2027-01-02', ['2027-01-01', '2027-01-02']],
    ['2026-03-07', '2026-03-09', ['2026-03-08', '2026-03-09']],
    ['2026-10-31', '2026-11-02', ['2026-11-01', '2026-11-02']],
    ['0100-01-01', '0100-01-02', ['0100-01-02']],
    ['9999-12-30', '9999-12-31', ['9999-12-31']],
  ])('walks calendar boundaries %s to %s', (start, end, dates) => {
    const result = generateEntitlements(plan(['BREAKFAST']), start, end, ['person-a'], roomId);
    expect(result.map((row) => row.date)).toEqual(dates);
  });

  it.each([
    '2026-02-29',
    '2026-04-31',
    '2026-00-10',
    '2026-13-01',
    '2026-09-00',
    '2026-9-12',
    '2026-09-12T00:00:00Z',
    '0099-01-01',
    '10000-01-01',
    '',
  ])('rejects invalid boundary %j on either end, including EP', (invalid) => {
    expect(() => generateEntitlements(plan([]), invalid, departure, persons, roomId)).toThrow();
    expect(() => generateEntitlements(plan([]), arrival, invalid, persons, roomId)).toThrow();
  });

  it.each([arrival, '2026-09-11'])('rejects same-day/reversed departure %s', (end) => {
    expect(() => generateEntitlements(plan([]), arrival, end, persons, roomId)).toThrow(
      /after arrival/
    );
  });

  it.each([
    { invalid: [] },
    { invalid: [''] },
    { invalid: [' person-a'] },
    { invalid: ['person-a', 'person-a'] },
    { invalid: [2] },
    { invalid: new Array<string>(1) },
  ])('rejects missing, invalid or duplicate persons %j', ({ invalid }) => {
    expect(() =>
      generateEntitlements(plan(['DINNER']), arrival, departure, invalid as string[], roomId)
    ).toThrow();
  });

  it('rejects a count instead of inventing person references', () => {
    expect(() =>
      generateEntitlements(plan(['DINNER']), arrival, departure, 2 as unknown as string[], roomId)
    ).toThrow(/actual stay-person/);
  });

  it.each(['', ' room-101', undefined])('requires explicit valid room identity %j', (invalid) => {
    expect(() =>
      generateEntitlements(plan(['DINNER']), arrival, departure, persons, invalid as string)
    ).toThrow(/Room ID/);
  });
});
