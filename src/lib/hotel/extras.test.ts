/**
 * PROP-05 — the extras catalog's validation rules.
 *
 * The two that matter are the two a column type cannot state:
 *
 *  - an **offer price requires an offerable item** (PROP-05 ★ / UPS-01), and the
 *    rejection lands on `upsellPriceMinor` so the form can point at it; and
 *  - **`PER_PERIOD` needs a period** — a charge that posts on a billing cycle is
 *    meaningless on a nightly or slot-billed plan (RSV-09).
 *
 * The second is asserted as a pure function of `(recurrence, billing cycle)` and
 * never of a property mode. MODE-01 forbids branching on the mode outside the
 * defaults layer, and the rule is genuinely about the cycle: a hotel that lets
 * one unit by the month gets the same answer a serviced-apartment block does.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HOTEL_EXTRA_RECURRENCE,
  HOTEL_BILLING_CYCLES,
  HOTEL_DEPARTMENTS,
  HOTEL_DEPARTMENT_LABELS,
  HOTEL_EXTRA_RECURRENCES,
  HOTEL_EXTRA_RECURRENCE_DESCRIPTIONS,
  HOTEL_EXTRA_RECURRENCE_LABELS,
  assertHotelExtraRecurrenceForBillingCycle,
  hotelDepartmentOptions,
  hotelExtraInput,
  hotelExtraOfferPriceMinor,
  hotelExtraRecurrenceFitsBillingCycle,
  hotelExtraRecurrenceOptions,
  hotelExtraRecurrenceRefusal,
  hotelExtraUpdateInput,
  type HotelBillingCycle,
  type HotelExtraRecurrenceValue,
} from './extras';

const valid = {
  code: 'LAUNDRY',
  name: 'Laundry service',
  nameUr: 'کپڑے دھلائی',
  priceMinor: 45_000,
  taxClass: 'SERVICES',
  department: 'LAUNDRY' as const,
};

describe('hotel extra input', () => {
  it('accepts the smallest complete catalog item and applies the pack defaults', () => {
    const parsed = hotelExtraInput.parse(valid);
    // A catalog item that says nothing else charges once, when posted; it is not
    // offered before arrival; and it is sellable the moment it is created.
    expect(parsed.recurring).toBe(DEFAULT_HOTEL_EXTRA_RECURRENCE);
    expect(parsed.recurring).toBe('NONE');
    expect(parsed.upsellable).toBe(false);
    expect(parsed.upsellPriceMinor).toBeNull();
    expect(parsed.active).toBe(true);
  });

  it('upper-cases the code and the tax class so one property cannot hold both cases', () => {
    const parsed = hotelExtraInput.parse({ ...valid, code: ' laundry ', taxClass: 'services' });
    expect(parsed.code).toBe('LAUNDRY');
    expect(parsed.taxClass).toBe('SERVICES');
  });

  it('keeps the Urdu name and turns a blank one into "not published"', () => {
    expect(hotelExtraInput.parse(valid).nameUr).toBe('کپڑے دھلائی');
    expect(hotelExtraInput.parse({ ...valid, nameUr: '   ' }).nameUr).toBeNull();
    expect(hotelExtraInput.parse({ ...valid, nameUr: null }).nameUr).toBeNull();
  });

  it.each([
    ['a code with a space', { code: 'LATE CHECKOUT' }],
    ['a lowercase-only code that is really a sentence', { code: 'late checkout for guests!' }],
    ['a blank name', { name: '   ' }],
    ['a tax class with punctuation', { taxClass: 'SERVICES!' }],
    ['a department outside the closed set', { department: 'ROOM_SERVICE' }],
    ['a recurrence outside the closed set', { recurring: 'PER_WEEK' }],
    ['a price in rupees rather than paisa', { priceMinor: 450.5 }],
    ['a negative price', { priceMinor: -1 }],
  ])('refuses %s', (_label, patch) => {
    expect(hotelExtraInput.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('refuses an offer price on an item that may not be offered, on the offer price field', () => {
    const result = hotelExtraInput.safeParse({
      ...valid,
      upsellable: false,
      upsellPriceMinor: 39_000,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['upsellPriceMinor']]);
  });

  it('accepts an offerable item with and without its own offer price', () => {
    expect(
      hotelExtraInput.parse({ ...valid, upsellable: true, upsellPriceMinor: 39_000 })
        .upsellPriceMinor
    ).toBe(39_000);
    // Offerable at the shelf price is a real configuration, not an omission.
    expect(hotelExtraInput.parse({ ...valid, upsellable: true }).upsellPriceMinor).toBeNull();
  });

  it('applies the same offer-price rule when an item is edited', () => {
    expect(
      hotelExtraUpdateInput.safeParse({
        ...valid,
        id: 'extra_1',
        upsellable: false,
        upsellPriceMinor: 1,
      }).success
    ).toBe(false);
    expect(hotelExtraUpdateInput.parse({ ...valid, id: 'extra_1' }).id).toBe('extra_1');
  });

  it.each(['priceMinor', 'upsellPriceMinor'] as const)(
    'limits %s to nonnegative PostgreSQL INTEGER values on create and update',
    (field) => {
      for (const schema of [hotelExtraInput, hotelExtraUpdateInput]) {
        const input = { ...valid, id: 'extra_1', upsellable: true };
        for (const value of [0, 2_147_483_647]) {
          expect(schema.parse({ ...input, [field]: value })[field]).toBe(value);
        }
        for (const value of [-1, 0.5, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
          const result = schema.safeParse({ ...input, [field]: value });
          expect(result.success).toBe(false);
          expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([field]);
        }
      }
    }
  );

  it('refuses an edit that does not say which item', () => {
    expect(hotelExtraUpdateInput.safeParse({ ...valid, id: '  ' }).success).toBe(false);
  });

  it('takes a posting rule as an object and nothing else', () => {
    expect(
      hotelExtraInput.parse({ ...valid, postingRule: { on: 'CHECK_IN' } }).postingRule
    ).toEqual({ on: 'CHECK_IN' });
    expect(hotelExtraInput.safeParse({ ...valid, postingRule: ['CHECK_IN'] }).success).toBe(false);
    expect(hotelExtraInput.safeParse({ ...valid, postingRule: 'CHECK_IN' }).success).toBe(false);
  });
});

describe('PER_PERIOD needs a period to post on', () => {
  it('refuses a per-period charge on a nightly plan, and on a day-use slot', () => {
    expect(hotelExtraRecurrenceFitsBillingCycle('PER_PERIOD', 'NIGHTLY')).toBe(false);
    expect(hotelExtraRecurrenceFitsBillingCycle('PER_PERIOD', 'SLOT')).toBe(false);
  });

  it('accepts a per-period charge on the weekly and monthly cycles RSV-09 posts', () => {
    expect(hotelExtraRecurrenceFitsBillingCycle('PER_PERIOD', 'WEEKLY')).toBe(true);
    expect(hotelExtraRecurrenceFitsBillingCycle('PER_PERIOD', 'MONTHLY')).toBe(true);
  });

  it('leaves every other recurrence alone on every cycle', () => {
    const others = HOTEL_EXTRA_RECURRENCES.filter(
      (recurring): recurring is Exclude<HotelExtraRecurrenceValue, 'PER_PERIOD'> =>
        recurring !== 'PER_PERIOD'
    );
    for (const recurring of others)
      for (const cycle of HOTEL_BILLING_CYCLES)
        expect(
          hotelExtraRecurrenceFitsBillingCycle(recurring, cycle),
          `${recurring}/${cycle}`
        ).toBe(true);
  });

  it('explains a refusal in words rather than returning a bare false', () => {
    const refusal = hotelExtraRecurrenceRefusal('PER_PERIOD', 'NIGHTLY');
    expect(refusal).toContain('nightly');
    expect(refusal).toContain('weekly or monthly');
    expect(hotelExtraRecurrenceRefusal('PER_PERIOD', 'MONTHLY')).toBeNull();
    expect(hotelExtraRecurrenceRefusal('PER_NIGHT', 'NIGHTLY')).toBeNull();
  });

  it('throws the same explanation when a caller asserts instead of asking', () => {
    expect(() => assertHotelExtraRecurrenceForBillingCycle('PER_PERIOD', 'NIGHTLY')).toThrow(
      /billing period/
    );
    expect(() => assertHotelExtraRecurrenceForBillingCycle('PER_PERIOD', 'WEEKLY')).not.toThrow();
  });

  it('states the billing cycles of 05 §1.2 and nothing else', () => {
    expect([...HOTEL_BILLING_CYCLES]).toEqual(['NIGHTLY', 'WEEKLY', 'MONTHLY', 'SLOT']);
    // No mode appears anywhere in the rule: the cycle is what decides.
    const cycles: readonly HotelBillingCycle[] = HOTEL_BILLING_CYCLES;
    expect(cycles).not.toContain('APARTMENT' as unknown as HotelBillingCycle);
  });
});

describe('what a pre-arrival offer quotes', () => {
  it('quotes the offer price when there is one, and the shelf price otherwise', () => {
    expect(
      hotelExtraOfferPriceMinor({ upsellable: true, priceMinor: 45_000, upsellPriceMinor: 39_000 })
    ).toBe(39_000);
    expect(
      hotelExtraOfferPriceMinor({ upsellable: true, priceMinor: 45_000, upsellPriceMinor: null })
    ).toBe(45_000);
  });

  it('quotes nothing at all for an item that may not be offered', () => {
    expect(
      hotelExtraOfferPriceMinor({ upsellable: false, priceMinor: 45_000, upsellPriceMinor: null })
    ).toBeNull();
  });
});

describe('the operator-facing vocabulary', () => {
  it('names every department and every recurrence — no surface prints a bare code', () => {
    for (const department of HOTEL_DEPARTMENTS) {
      expect(HOTEL_DEPARTMENT_LABELS[department]).toBeTruthy();
      expect(HOTEL_DEPARTMENT_LABELS[department]).not.toBe(department);
    }
    for (const recurring of HOTEL_EXTRA_RECURRENCES) {
      expect(HOTEL_EXTRA_RECURRENCE_LABELS[recurring]).not.toBe(recurring);
      expect(HOTEL_EXTRA_RECURRENCE_DESCRIPTIONS[recurring].length).toBeGreaterThan(0);
    }
    expect(hotelDepartmentOptions).toHaveLength(HOTEL_DEPARTMENTS.length);
    expect(hotelExtraRecurrenceOptions).toHaveLength(HOTEL_EXTRA_RECURRENCES.length);
  });

  it('carries the departments the metric contract reports separately', () => {
    // 06 §5: day-use revenue is its own department and never enters ADR/RevPAR;
    // no-show and cancellation revenue are their own departments; RSV-09's
    // recurring long-stay charges post to utilities.
    expect(HOTEL_DEPARTMENTS).toEqual(
      expect.arrayContaining(['DAY_USE', 'NO_SHOW', 'CANCELLATION', 'UTILITIES', 'ROOMS'])
    );
  });
});
