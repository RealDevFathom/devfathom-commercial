import { describe, expect, it } from 'vitest';

import { applyHotelModeDefaults, type HotelModeConfiguration } from './modes';

describe('property mode defaults', () => {
  it.each([
    [
      'HOTEL',
      ['ROOM'],
      ['NIGHTLY', 'SLOT'],
      'ROOMS',
      ['occupancy-revenue', 'arrivals-departures', 'day-use'],
    ],
    ['HOSTEL', ['BED'], ['NIGHTLY'], 'BEDS', ['bed-occupancy', 'arrivals-departures']],
    ['APARTMENT', ['UNIT'], ['WEEKLY', 'MONTHLY'], 'UNITS', ['long-stay', 'arrivals-departures']],
    [
      'RESORT',
      ['ROOM'],
      ['NIGHTLY', 'SLOT'],
      'ROOMS_AND_SLOTS',
      ['occupancy-revenue', 'arrivals-departures', 'day-use'],
    ],
    ['VENUE', [], ['SLOT'], 'FUNCTIONS', ['function-utilisation', 'banquet-pnl']],
  ] as const)(
    '%s selects inventory, billing, booking layout and reports',
    (mode, inventoryKinds, billingCycles, bookingEngineLayout, reportKeys) => {
      expect(applyHotelModeDefaults(mode)).toMatchObject({
        inventoryKinds,
        billingCycles,
        bookingEngineLayout,
        reportKeys,
      });
    }
  );

  it('selects the operational defaults described by MODE-02 through MODE-05', () => {
    expect(applyHotelModeDefaults('HOTEL').dayUse).toBe(true);
    expect(applyHotelModeDefaults('RESORT').dayUse).toBe(true);
    expect(applyHotelModeDefaults('HOSTEL')).toMatchObject({ dormPolicies: true, dayUse: false });
    expect(applyHotelModeDefaults('APARTMENT')).toMatchObject({
      recurringExtras: true,
      tenancyDocuments: true,
      dayUse: false,
    });
    expect(applyHotelModeDefaults('VENUE')).toMatchObject({ functionSpaces: true, dayUse: false });
  });

  it('preserves explicit false overrides', () => {
    expect(applyHotelModeDefaults('HOTEL', { dayUse: false }).dayUse).toBe(false);
    expect(applyHotelModeDefaults('HOSTEL', { dormPolicies: false }).dormPolicies).toBe(false);
    expect(
      applyHotelModeDefaults('APARTMENT', { recurringExtras: false, tenancyDocuments: false })
    ).toMatchObject({
      recurringExtras: false,
      tenancyDocuments: false,
    });
    expect(applyHotelModeDefaults('VENUE', { functionSpaces: false }).functionSpaces).toBe(false);
  });

  it('preserves explicit empty lists and report values', () => {
    expect(
      applyHotelModeDefaults('HOTEL', { inventoryKinds: [], billingCycles: [], reportKeys: [] })
    ).toMatchObject({
      inventoryKinds: [],
      billingCycles: [],
      reportKeys: [],
    });
    expect(applyHotelModeDefaults('HOTEL', { reportKeys: [''] }).reportKeys).toEqual(['']);
  });

  it('fills absent and undefined fields without turning them into overrides', () => {
    expect(applyHotelModeDefaults('HOTEL', { dayUse: undefined, reportKeys: undefined })).toEqual(
      applyHotelModeDefaults('HOTEL')
    );
  });

  it('reapplies new-mode defaults while retaining only explicit choices', () => {
    const overrides = Object.freeze({ dayUse: false, reportKeys: Object.freeze(['tax']) });
    const hotel = applyHotelModeDefaults('HOTEL', overrides);
    const apartment = applyHotelModeDefaults('APARTMENT', overrides);
    expect(hotel.inventoryKinds).toEqual(['ROOM']);
    expect(apartment.inventoryKinds).toEqual(['UNIT']);
    expect(apartment).toMatchObject({ dayUse: false, reportKeys: ['tax'], recurringExtras: true });
    expect(overrides).toEqual({ dayUse: false, reportKeys: ['tax'] });
  });

  it('returns independent arrays for defaults and caller overrides', () => {
    const overrides: Partial<HotelModeConfiguration> = {
      inventoryKinds: ['BED'],
      billingCycles: ['WEEKLY'],
      reportKeys: ['bed-occupancy'],
    };
    const result = applyHotelModeDefaults('HOTEL', overrides);
    for (const key of ['inventoryKinds', 'billingCycles', 'reportKeys'] as const) {
      expect(result[key]).not.toBe(overrides[key]);
      expect(applyHotelModeDefaults('HOTEL')[key]).not.toBe(applyHotelModeDefaults('HOTEL')[key]);
    }
    expect(applyHotelModeDefaults('HOTEL').inventoryKinds).toEqual(['ROOM']);
  });
});
