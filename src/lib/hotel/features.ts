import {
  HOSPITALITY_COMMERCIAL_LIMITS,
  HOTEL_ROOMS_LIMIT,
  resolveEntitlementLimit,
} from '@/lib/entitlement-limits';
import { evaluateEntitlementRequirement, type EntitlementSnapshot } from '@/lib/module-catalog';
import { HOSPITALITY_PACKAGES } from '@/lib/vertical-catalog';

import type { HotelModeConfiguration } from './modes';

/**
 * The snapshot with every hospitality limit under its bare key. A package's
 * default limits reach the snapshot as `hotel-core.<key>` (the module link
 * carries them); an explicit `organization_limits` row keeps `<key>` and wins.
 * An invalid value (negative, fractional, non-finite) counts as absent, so the
 * requirement below fails closed instead of reading garbage as a grant.
 */
export function resolveHotelLimits(entitlements: EntitlementSnapshot): EntitlementSnapshot {
  const limits: Record<string, number> = { ...entitlements.limits };
  for (const definition of HOSPITALITY_COMMERCIAL_LIMITS) {
    const resolution = resolveEntitlementLimit(entitlements.limits, definition);
    if (resolution.status === 'configured') limits[definition.explicitKey] = resolution.value;
    else delete limits[definition.explicitKey];
  }
  return { ...entitlements, limits };
}

/**
 * The organization's sellable-unit ceiling (`hotel.rooms.max`): rooms, beds and
 * units across every property. Absent or invalid resolves to zero, the Venue
 * package's deliberate "no rooms" value, never to "unlimited".
 */
export function hotelRoomLimit(entitlements: Pick<EntitlementSnapshot, 'limits'>): number {
  const resolution = resolveEntitlementLimit(entitlements.limits, HOTEL_ROOMS_LIMIT);
  return resolution.status === 'configured' ? resolution.value : 0;
}

/**
 * Pure package preview. Runtime callers must instead supply the snapshot from
 * resolveOrganizationEntitlements, which owns contract/override/expiry rules.
 * An explicit enabledModules list replaces the package list, including [].
 */
export function hotelPackageEntitlements(
  packageKey: string,
  overrides: {
    enabledModules?: readonly string[];
    limits?: Readonly<Record<string, number | undefined>>;
  } = {}
): EntitlementSnapshot {
  const definition = HOSPITALITY_PACKAGES.find((entry) => entry.key === packageKey);
  if (!definition) throw new Error(`Unknown hospitality package: ${packageKey}`);
  const limits = { ...definition.defaultLimits };
  for (const [key, value] of Object.entries(overrides.limits ?? {})) {
    if (value !== undefined) limits[key] = value;
  }
  return {
    enabledModules: [...(overrides.enabledModules ?? definition.moduleKeys)],
    limits,
  };
}

/** MODE-05: features follow configuration and granted modules/limits, never mode names. */
export function evaluateHotelFeatures(
  configuration: HotelModeConfiguration,
  snapshot: EntitlementSnapshot
) {
  const entitlements = resolveHotelLimits(snapshot);
  const moduleEnabled = (module: string) =>
    evaluateEntitlementRequirement(entitlements, {
      modules: ['hotel-core', module],
      limits: [],
    }).allowed;
  const rooms =
    configuration.inventoryKinds.length > 0 &&
    evaluateEntitlementRequirement(entitlements, {
      modules: ['hotel-core'],
      limits: [{ key: 'hotel.rooms.max', atLeast: 1 }],
    }).allowed;
  const reservations = rooms && moduleEnabled('hotel-reservations');
  const functionSpaces = configuration.functionSpaces && moduleEnabled('hotel-banquets');

  return {
    rooms,
    beds: rooms && configuration.inventoryKinds.includes('BED'),
    units: rooms && configuration.inventoryKinds.includes('UNIT'),
    availabilityDays: reservations && configuration.billingCycles.some((cycle) => cycle !== 'SLOT'),
    reservations,
    frontDesk: rooms && moduleEnabled('hotel-front-desk'),
    dayUse: reservations && configuration.dayUse && configuration.billingCycles.includes('SLOT'),
    longStay:
      reservations &&
      configuration.billingCycles.some((cycle) => cycle === 'WEEKLY' || cycle === 'MONTHLY'),
    dormPolicies: rooms && configuration.dormPolicies,
    recurringExtras: rooms && configuration.recurringExtras && moduleEnabled('hotel-folio'),
    tenancyDocuments: rooms && configuration.tenancyDocuments,
    functionSpaces,
    banquets: functionSpaces,
    catering: functionSpaces,
    folio: moduleEnabled('hotel-folio'),
    payments: moduleEnabled('hotel-payments'),
    nightAudit: moduleEnabled('hotel-night-audit'),
    reports: moduleEnabled('hotel-reports'),
    channels: reservations && moduleEnabled('hotel-channels'),
    upsell: reservations && moduleEnabled('hotel-upsell'),
    marketing: moduleEnabled('hotel-marketing'),
    agents: reservations && moduleEnabled('hotel-agents'),
    maintenance: moduleEnabled('hotel-maintenance'),
    api: moduleEnabled('hotel-api'),
    centralReservations: reservations && moduleEnabled('hotel-crs'),
  };
}

export type HotelFeatures = ReturnType<typeof evaluateHotelFeatures>;

/**
 * Caller supplies the property's counted/proposed availability-day rows. This
 * is an assertion only; persistence and transactional enforcement belong to the
 * availability caller. Venue defaults and Venue entitlements both deny rows.
 */
export function assertHotelAvailabilityDays(
  features: Pick<HotelFeatures, 'availabilityDays'>,
  availabilityDayCount: number
): void {
  if (!Number.isSafeInteger(availabilityDayCount) || availabilityDayCount < 0) {
    throw new Error('Availability-day count must be a non-negative safe integer.');
  }
  if (!features.availabilityDays && availabilityDayCount > 0) {
    throw new Error('Availability days are disabled by property configuration or entitlements.');
  }
}
