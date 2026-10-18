// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  assertHotelExtraRecurrenceForBillingCycle,
  hotelExtraInput,
  hotelExtraOfferPriceMinor,
  hotelExtraRecurrenceFitsBillingCycle,
  hotelExtraRecurrenceRefusal,
  hotelExtraUpdateInput,
  type HotelBillingCycle,
  type HotelExtraRecurrenceValue,
} from './extras';

// Explicit expectations keep the matrix independent of the production predicate.
const recurrenceCases = [
  { recurring: 'NONE', cycle: 'NIGHTLY', fits: true },
  { recurring: 'NONE', cycle: 'WEEKLY', fits: true },
  { recurring: 'NONE', cycle: 'MONTHLY', fits: true },
  { recurring: 'NONE', cycle: 'SLOT', fits: true },
  { recurring: 'PER_NIGHT', cycle: 'NIGHTLY', fits: true },
  { recurring: 'PER_NIGHT', cycle: 'WEEKLY', fits: true },
  { recurring: 'PER_NIGHT', cycle: 'MONTHLY', fits: true },
  { recurring: 'PER_NIGHT', cycle: 'SLOT', fits: true },
  { recurring: 'PER_STAY', cycle: 'NIGHTLY', fits: true },
  { recurring: 'PER_STAY', cycle: 'WEEKLY', fits: true },
  { recurring: 'PER_STAY', cycle: 'MONTHLY', fits: true },
  { recurring: 'PER_STAY', cycle: 'SLOT', fits: true },
  { recurring: 'PER_PERSON', cycle: 'NIGHTLY', fits: true },
  { recurring: 'PER_PERSON', cycle: 'WEEKLY', fits: true },
  { recurring: 'PER_PERSON', cycle: 'MONTHLY', fits: true },
  { recurring: 'PER_PERSON', cycle: 'SLOT', fits: true },
  { recurring: 'PER_PERIOD', cycle: 'NIGHTLY', fits: false },
  { recurring: 'PER_PERIOD', cycle: 'WEEKLY', fits: true },
  { recurring: 'PER_PERIOD', cycle: 'MONTHLY', fits: true },
  { recurring: 'PER_PERIOD', cycle: 'SLOT', fits: false },
] as const satisfies ReadonlyArray<{
  recurring: HotelExtraRecurrenceValue;
  cycle: HotelBillingCycle;
  fits: boolean;
}>;

describe('Hotel extra recurrence compatibility', () => {
  it.each(recurrenceCases)('$recurring on $cycle: fits=$fits', ({ recurring, cycle, fits }) => {
    expect(hotelExtraRecurrenceFitsBillingCycle(recurring, cycle)).toBe(fits);

    const refusal = hotelExtraRecurrenceRefusal(recurring, cycle);
    const assertPairing = () => assertHotelExtraRecurrenceForBillingCycle(recurring, cycle);
    if (fits) {
      expect(refusal).toBeNull();
      expect(assertPairing).not.toThrow();
    } else {
      expect(refusal).toContain(`${cycle.toLowerCase()} rate plan`);
      expect(refusal).toContain('weekly or monthly');
      if (refusal === null) throw new Error('Expected a recurrence refusal.');
      expect(assertPairing).toThrowError(new Error(refusal));
    }
  });
});

describe('Hotel extra offer-price selection', () => {
  it.each([
    {
      label: 'disabled without an offer price',
      upsellable: false,
      priceMinor: 12_500,
      upsellPriceMinor: null,
      expected: null,
    },
    {
      label: 'disabled with a retained offer price',
      upsellable: false,
      priceMinor: 12_500,
      upsellPriceMinor: 9_000,
      expected: null,
    },
    {
      label: 'shelf-price fallback',
      upsellable: true,
      priceMinor: 12_500,
      upsellPriceMinor: null,
      expected: 12_500,
    },
    {
      label: 'explicit offer price',
      upsellable: true,
      priceMinor: 12_500,
      upsellPriceMinor: 9_000,
      expected: 9_000,
    },
    {
      label: 'explicit zero offer price',
      upsellable: true,
      priceMinor: 12_500,
      upsellPriceMinor: 0,
      expected: 0,
    },
    {
      label: 'zero shelf-price fallback',
      upsellable: true,
      priceMinor: 0,
      upsellPriceMinor: null,
      expected: 0,
    },
  ])('$label', ({ expected, upsellable, priceMinor, upsellPriceMinor }) => {
    const extra = Object.freeze({ upsellable, priceMinor, upsellPriceMinor });
    expect(hotelExtraOfferPriceMinor(extra)).toBe(expected);
  });
});

const catalogItem = {
  code: 'LAUNDRY',
  name: 'Laundry',
  priceMinor: 12_500,
  taxClass: 'SERVICES',
  department: 'LAUNDRY',
} as const;

const priceCases = [
  { amount: 0, accepted: true },
  { amount: 2_147_483_647, accepted: true },
  { amount: -1, accepted: false },
  { amount: 0.5, accepted: false },
  { amount: 2_147_483_648, accepted: false },
] as const;

describe.each([
  { operation: 'create', schema: hotelExtraInput, input: catalogItem },
  { operation: 'update', schema: hotelExtraUpdateInput, input: { ...catalogItem, id: 'extra-1' } },
])('Hotel extra $operation validation', ({ schema, input }) => {
  it('defaults to a one-off charge without a pre-arrival offer', () => {
    expect(schema.parse(input)).toMatchObject({
      recurring: 'NONE',
      upsellable: false,
      upsellPriceMinor: null,
    });
  });

  it.each([0, 9_000])('rejects offer price %i when upselling is disabled', (upsellPriceMinor) => {
    const result = schema.safeParse({ ...input, upsellable: false, upsellPriceMinor });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ code: 'custom', path: ['upsellPriceMinor'] })
      );
    }
  });

  it('allows an upsellable item to use its shelf price', () => {
    const extra = schema.parse({ ...input, upsellable: true, upsellPriceMinor: null });
    expect(hotelExtraOfferPriceMinor(extra)).toBe(catalogItem.priceMinor);
  });

  describe.each(['priceMinor', 'upsellPriceMinor'] as const)('%s Int32 boundaries', (field) => {
    it.each(priceCases)('$amount: accepted=$accepted', ({ amount, accepted }) => {
      const result = schema.safeParse({ ...input, upsellable: true, [field]: amount });
      expect(result.success).toBe(accepted);
      if (result.success) {
        expect(result.data[field]).toBe(amount);
      } else {
        expect(result.error.issues).toContainEqual(expect.objectContaining({ path: [field] }));
      }
    });
  });
});
