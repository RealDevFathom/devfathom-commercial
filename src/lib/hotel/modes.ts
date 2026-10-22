import type { HotelPropertyMode } from '@/generated/prisma/enums';

export type HotelInventoryKind = 'ROOM' | 'BED' | 'UNIT';
export type HotelBillingCycle = 'NIGHTLY' | 'WEEKLY' | 'MONTHLY' | 'SLOT';

/** MODE-01: configuration defaults, not restrictions on a property's capabilities. */
export type HotelModeConfiguration = {
  inventoryKinds: readonly HotelInventoryKind[];
  billingCycles: readonly HotelBillingCycle[];
  dayUse: boolean;
  functionSpaces: boolean;
  dormPolicies: boolean;
  recurringExtras: boolean;
  tenancyDocuments: boolean;
  bookingEngineLayout: 'ROOMS' | 'BEDS' | 'UNITS' | 'ROOMS_AND_SLOTS' | 'FUNCTIONS';
  reportKeys: readonly string[];
};

const hotelDefaults: HotelModeConfiguration = {
  inventoryKinds: ['ROOM'],
  billingCycles: ['NIGHTLY', 'SLOT'],
  dayUse: true,
  functionSpaces: false,
  dormPolicies: false,
  recurringExtras: false,
  tenancyDocuments: false,
  bookingEngineLayout: 'ROOMS',
  reportKeys: ['occupancy-revenue', 'arrivals-departures', 'day-use'],
};

const defaultsByMode: Record<HotelPropertyMode, HotelModeConfiguration> = {
  HOTEL: hotelDefaults,
  HOSTEL: {
    ...hotelDefaults,
    inventoryKinds: ['BED'],
    billingCycles: ['NIGHTLY'],
    dayUse: false,
    dormPolicies: true,
    bookingEngineLayout: 'BEDS',
    reportKeys: ['bed-occupancy', 'arrivals-departures'],
  },
  APARTMENT: {
    ...hotelDefaults,
    inventoryKinds: ['UNIT'],
    billingCycles: ['WEEKLY', 'MONTHLY'],
    dayUse: false,
    recurringExtras: true,
    tenancyDocuments: true,
    bookingEngineLayout: 'UNITS',
    reportKeys: ['long-stay', 'arrivals-departures'],
  },
  RESORT: {
    ...hotelDefaults,
    bookingEngineLayout: 'ROOMS_AND_SLOTS',
  },
  VENUE: {
    ...hotelDefaults,
    inventoryKinds: [],
    billingCycles: ['SLOT'],
    dayUse: false,
    functionSpaces: true,
    bookingEngineLayout: 'FUNCTIONS',
    reportKeys: ['function-utilisation', 'banquet-pnl'],
  },
};

/**
 * Pass stored explicit overrides, not a previously resolved configuration, when
 * changing mode. Only undefined selects a default; false and empty arrays stay
 * decisions. Returned arrays never alias the defaults or the caller's arrays.
 */
export function applyHotelModeDefaults(
  mode: HotelPropertyMode,
  overrides: Partial<HotelModeConfiguration> = {}
): HotelModeConfiguration {
  const defaults = defaultsByMode[mode];
  return {
    inventoryKinds: [...(overrides.inventoryKinds ?? defaults.inventoryKinds)],
    billingCycles: [...(overrides.billingCycles ?? defaults.billingCycles)],
    dayUse: overrides.dayUse ?? defaults.dayUse,
    functionSpaces: overrides.functionSpaces ?? defaults.functionSpaces,
    dormPolicies: overrides.dormPolicies ?? defaults.dormPolicies,
    recurringExtras: overrides.recurringExtras ?? defaults.recurringExtras,
    tenancyDocuments: overrides.tenancyDocuments ?? defaults.tenancyDocuments,
    bookingEngineLayout: overrides.bookingEngineLayout ?? defaults.bookingEngineLayout,
    reportKeys: [...(overrides.reportKeys ?? defaults.reportKeys)],
  };
}
