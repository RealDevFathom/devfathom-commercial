import { expect, it } from 'vitest';
import { cateringGrowthInput, growthSourceHash } from './growth-source';
import { growthSourceFixture } from '../../../tests/fixtures/restaurant-growth-source';
import { parseRestaurantGrowthSnapshot } from './growth-snapshot';
it.each([0, 9, 10, 200, 201])('admits complete cohort at size %s only within bounds', (count) => {
  const input = cateringGrowthInput(growthSourceFixture(count));
  expect(input.facts).toHaveLength(count >= 10 && count <= 200 ? 1 : 0);
  if (input.facts.length)
    expect(input.facts[0]).toMatchObject({
      value: String(count),
      cohortSize: count,
      coverage: 'COMPLETE',
    });
});
it('counts bookings separately from distinct contributing customers', () => {
  const p = growthSourceFixture(11);
  p.source.periods[0].bookings[10].customer = 'customer-0';
  p.source.periods[0].bookings[10].customerId = 'customer-0';
  expect(cateringGrowthInput(p).facts[0]).toMatchObject({ value: '11', cohortSize: 10 });
  for (const row of p.source.periods[0].bookings) row.customer = row.customerId = 'customer-0';
  expect(cateringGrowthInput(p).facts).toEqual([]);
});
it.each([
  { customer: null },
  { customerId: null },
  { customer: 'foreign' },
  { anonymized: true },
  { quoteId: null },
  { approvedId: 'different' },
  { quoteRevision: 2 },
  { approvalRevision: 2 },
  { approvalId: null },
  { eventId: null },
  { transitionTo: 'CANCELLED' },
  { transitionCreated: null },
  { date: '2026-09-30' },
  { date: '2026-10-02' },
  { customerUpdated: null },
])('withholds entire period for incomplete membership/confirmation %j', (change) => {
  const p = growthSourceFixture(11);
  Object.assign(p.source.periods[0].bookings[0], change);
  expect(cateringGrowthInput(p).facts).toEqual([]);
});
it('withholds duplicate booking IDs, malformed data and missing fields', () => {
  const p = growthSourceFixture();
  p.source.periods[0].bookings[0].id = p.source.periods[0].bookings[1].id;
  expect(cateringGrowthInput(p).facts).toEqual([]);
  p.source.periods[0].bookings[0].updated = 'invalid';
  expect(() => cateringGrowthInput(p)).toThrow();
  expect(() => cateringGrowthInput({} as never)).toThrow();
});
it('independently admits comparison without inventing missing-period zero', () => {
  const p = growthSourceFixture();
  p.source.periods[1].bookings = p.source.periods[0].bookings.map((row) => ({
    ...row,
    date: '2026-09-30',
  }));
  p.source.periods[0].bookings = [];
  expect(cateringGrowthInput(p).facts.map((f) => [f.ref, f.period])).toEqual([
    ['e2', 'COMPARISON'],
  ]);
});
it('watermark uses persisted changes, stable across read clock/key order', () => {
  const p = growthSourceFixture(),
    input = cateringGrowthInput(p);
  expect(input.facts[0].freshAt).toBe(
    new Date(Number(p.source.periods[0].bookings[0].updated) * 1000).toISOString()
  );
  expect(growthSourceHash(p)).toBe(
    growthSourceHash(Object.fromEntries(Object.entries(p).reverse()))
  );
  const snapshot = {
    ...input,
    _restaurant: {
      version: 'restaurant-growth-v2',
      fingerprint: 'actor request',
      provenance: p,
      sourceHash: growthSourceHash(p),
      failureReason: null,
    },
  };
  expect(parseRestaurantGrowthSnapshot(JSON.parse(JSON.stringify(snapshot))).input).toEqual(input);
  expect(() => parseRestaurantGrowthSnapshot({ ...snapshot, unknown: true })).toThrow();
});
it.each(['id', 'customer', 'quoteId', 'quoteHash', 'eventId', 'updated'] as const)(
  'equal counts cannot conceal changed %s',
  (key) => {
    const p = growthSourceFixture(),
      before = growthSourceHash(p);
    p.source.periods[0].bookings[0][key] += '1';
    expect(growthSourceHash(p)).not.toBe(before);
  }
);
