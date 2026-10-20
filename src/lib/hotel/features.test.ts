import { describe, expect, it } from 'vitest';

import { HotelPropertyMode } from '@/generated/prisma/enums';
import { HOSPITALITY_MODULES, HOSPITALITY_PACKAGES } from '@/lib/vertical-catalog';

import {
  assertHotelAvailabilityDays,
  evaluateHotelFeatures,
  hotelPackageEntitlements,
} from './features';
import { applyHotelModeDefaults, type HotelModeConfiguration } from './modes';

const allConfiguration: HotelModeConfiguration = {
  inventoryKinds: ['ROOM', 'BED', 'UNIT'],
  billingCycles: ['NIGHTLY', 'WEEKLY', 'MONTHLY', 'SLOT'],
  dayUse: true,
  functionSpaces: true,
  dormPolicies: true,
  recurringExtras: true,
  tenancyDocuments: true,
  bookingEngineLayout: 'ROOMS_AND_SLOTS',
  reportKeys: [],
};
const essentialsFeatures = [
  'rooms',
  'beds',
  'units',
  'availabilityDays',
  'reservations',
  'frontDesk',
  'dayUse',
  'longStay',
  'dormPolicies',
  'recurringExtras',
  'tenancyDocuments',
  'folio',
  'payments',
  'nightAudit',
  'reports',
];
const growthFeatures = ['channels', 'upsell', 'marketing', 'agents', 'maintenance', 'api'];

describe('package feature evaluation', () => {
  it.each([
    ['hotel-essentials', essentialsFeatures],
    ['hotel-pro', [...essentialsFeatures, ...growthFeatures]],
    ['hotel-chain', [...essentialsFeatures, ...growthFeatures, 'centralReservations']],
    [
      'hotel-venue',
      ['functionSpaces', 'banquets', 'catering', 'folio', 'payments', 'nightAudit', 'reports'],
    ],
  ] as const)('%s grants only its configured, licensed features', (packageKey, enabled) => {
    const features = evaluateHotelFeatures(allConfiguration, hotelPackageEntitlements(packageKey));
    expect(
      Object.entries(features)
        .filter(([, value]) => value)
        .map(([key]) => key)
        .sort()
    ).toEqual([...enabled].sort());
  });

  it.each(Object.values(HotelPropertyMode))(
    '%s can enable every feature through configuration and entitlements',
    (mode) => {
      const features = evaluateHotelFeatures(applyHotelModeDefaults(mode, allConfiguration), {
        enabledModules: HOSPITALITY_MODULES.map((entry) => entry.key),
        limits: { 'hotel.rooms.max': 1 },
      });
      expect(Object.values(features)).not.toHaveLength(0);
      expect(Object.values(features).every(Boolean)).toBe(true);
    }
  );

  it.each(HOSPITALITY_PACKAGES)('$key reuses the foundation catalog unchanged', (definition) => {
    expect(hotelPackageEntitlements(definition.key)).toEqual({
      enabledModules: definition.moduleKeys,
      limits: definition.defaultLimits,
    });
  });

  it.each(['unknown', 'restaurant-essentials'])('rejects package %s', (key) => {
    expect(() => hotelPackageEntitlements(key)).toThrow(`Unknown hospitality package: ${key}`);
  });

  it('keeps zero limits while undefined uses the package default', () => {
    const entitlements = hotelPackageEntitlements('hotel-essentials', {
      limits: { 'hotel.rooms.max': 0, 'hotel.users.max': undefined },
    });
    expect(entitlements.limits).toMatchObject({ 'hotel.rooms.max': 0, 'hotel.users.max': 15 });
    expect(evaluateHotelFeatures(allConfiguration, entitlements)).toMatchObject({
      rooms: false,
      reservations: false,
      availabilityDays: false,
    });
  });

  it('preserves an empty module override, denying every feature', () => {
    const entitlements = hotelPackageEntitlements('hotel-chain', { enabledModules: [] });
    expect(entitlements.enabledModules).toEqual([]);
    expect(
      Object.values(evaluateHotelFeatures(allConfiguration, entitlements)).every(
        (enabled) => !enabled
      )
    ).toBe(true);
  });

  it('does not mutate or share package and override state', () => {
    const modules = Object.freeze(['hotel-core']);
    const limits = Object.freeze({ 'hotel.rooms.max': 0 });
    const result = hotelPackageEntitlements('hotel-essentials', {
      enabledModules: modules,
      limits,
    });
    result.enabledModules.push('hotel-banquets');
    result.limits['hotel.rooms.max'] = 100;
    expect(modules).toEqual(['hotel-core']);
    expect(limits).toEqual({ 'hotel.rooms.max': 0 });
    expect(hotelPackageEntitlements('hotel-essentials').limits['hotel.rooms.max']).toBe(50);
    expect(hotelPackageEntitlements('hotel-essentials').enabledModules).not.toContain(
      'hotel-banquets'
    );
  });

  it('denies room inventory without a granted limit or core module', () => {
    expect(
      evaluateHotelFeatures(allConfiguration, {
        enabledModules: ['hotel-core', 'hotel-reservations'],
        limits: {},
      }).rooms
    ).toBe(false);
    const features = evaluateHotelFeatures(allConfiguration, {
      enabledModules: HOSPITALITY_MODULES.map((entry) => entry.key).filter(
        (key) => key !== 'hotel-core'
      ),
      limits: { 'hotel.rooms.max': 100 },
    });
    expect(Object.values(features).every((enabled) => !enabled)).toBe(true);
  });

  it('keeps explicit property disables even when the package grants the modules', () => {
    const features = evaluateHotelFeatures(
      applyHotelModeDefaults('HOTEL', {
        inventoryKinds: [],
        dayUse: false,
        functionSpaces: false,
      }),
      {
        enabledModules: HOSPITALITY_MODULES.map((entry) => entry.key),
        limits: { 'hotel.rooms.max': 100 },
      }
    );
    expect(features).toMatchObject({
      rooms: false,
      availabilityDays: false,
      dayUse: false,
      functionSpaces: false,
      banquets: false,
      catering: false,
    });
  });

  it('keeps slot-only sales out of availability days', () => {
    const features = evaluateHotelFeatures(
      applyHotelModeDefaults('HOTEL', { billingCycles: ['SLOT'] }),
      hotelPackageEntitlements('hotel-essentials')
    );
    expect(features).toMatchObject({ dayUse: true, availabilityDays: false });
  });

  it('requires slot billing as well as day-use configuration', () => {
    expect(
      evaluateHotelFeatures(
        applyHotelModeDefaults('HOTEL', { billingCycles: [] }),
        hotelPackageEntitlements('hotel-essentials')
      )
    ).toMatchObject({ dayUse: false, availabilityDays: false });
  });
});

describe('availability-day assertion', () => {
  it.each([
    ['VENUE', 'hotel-chain'],
    ['HOTEL', 'hotel-venue'],
  ] as const)('%s with %s refuses availability days', (mode, packageKey) => {
    const features = evaluateHotelFeatures(
      applyHotelModeDefaults(mode),
      hotelPackageEntitlements(packageKey)
    );
    expect(() => assertHotelAvailabilityDays(features, 0)).not.toThrow();
    expect(() => assertHotelAvailabilityDays(features, 1)).toThrow(
      'Availability days are disabled by property configuration or entitlements.'
    );
  });

  it('allows positive counts only when availability days are enabled', () => {
    const features = evaluateHotelFeatures(
      applyHotelModeDefaults('HOTEL'),
      hotelPackageEntitlements('hotel-essentials')
    );
    expect(() => assertHotelAvailabilityDays(features, 2)).not.toThrow();
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid evidence %s',
    (count) => {
      expect(() => assertHotelAvailabilityDays({ availabilityDays: true }, count)).toThrow(
        'Availability-day count must be a non-negative safe integer.'
      );
    }
  );
});
