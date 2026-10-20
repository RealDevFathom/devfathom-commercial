export type EntitlementLimitDefinition = {
  label: string;
  explicitKey: string;
  bootstrappedKey: string;
};

export type EntitlementLimitResolution =
  | { status: 'configured'; key: string; source: 'explicit' | 'bootstrapped'; value: number }
  | {
      status: 'missing';
      explicitKey: string;
      bootstrappedKey: string;
      invalidKey?: string;
      invalidReason?: 'negative' | 'fractional' | 'non-finite' | 'unsafe-integer';
    };

function restaurantLimit(label: string, explicitKey: string): EntitlementLimitDefinition {
  return { label, explicitKey, bootstrappedKey: `restaurant-core.${explicitKey}` };
}

export const RESTAURANT_LOCATIONS_LIMIT = restaurantLimit(
  'Restaurant location limit',
  'restaurant.locations.max'
);
export const RESTAURANT_BRANDS_LIMIT = restaurantLimit(
  'Restaurant brand limit',
  'restaurant.brands.max'
);
export const POS_TERMINALS_LIMIT = restaurantLimit('POS terminal limit', 'pos.terminals.max');
export const POS_REGISTERED_DEVICES_LIMIT = restaurantLimit(
  'Registered device limit',
  'pos.registeredDevices.max'
);
export const POS_MONTHLY_ORDERS_LIMIT = restaurantLimit(
  'Monthly order limit',
  'pos.orders.monthly'
);
export const POS_CONCURRENT_REGISTERS_LIMIT = restaurantLimit(
  'Concurrent register limit',
  'pos.concurrentRegisters.max'
);
export const RESTAURANT_OPERATORS_LIMIT = restaurantLimit(
  'Restaurant operator limit',
  'restaurant.operators.max'
);
export const INVENTORY_STOCK_LOCATIONS_LIMIT = restaurantLimit(
  'Inventory stock location limit',
  'inventory.stockLocations.max'
);

export const SOP_TEMPLATES_LIMIT = restaurantLimit('SOP template limit', 'sop.templates.max');

export const RESTAURANT_COMMERCIAL_LIMITS = [
  RESTAURANT_LOCATIONS_LIMIT,
  RESTAURANT_BRANDS_LIMIT,
  POS_TERMINALS_LIMIT,
  POS_REGISTERED_DEVICES_LIMIT,
  POS_MONTHLY_ORDERS_LIMIT,
  POS_CONCURRENT_REGISTERS_LIMIT,
  RESTAURANT_OPERATORS_LIMIT,
  INVENTORY_STOCK_LOCATIONS_LIMIT,
  SOP_TEMPLATES_LIMIT,
] as const;

/**
 * GTM-01 — hospitality limits. The catalog sync stores a package's default
 * limits on its `-core` module link, and the entitlement snapshot prefixes a
 * link's limits with the module key, so a bootstrapped hotel ceiling arrives as
 * `hotel-core.hotel.rooms.max` while an explicit `organization_limits` row keeps
 * the bare key. Hotel readers resolve both through these definitions, explicit
 * first, exactly as the restaurant readers do.
 */
function hotelLimit(label: string, explicitKey: string): EntitlementLimitDefinition {
  return { label, explicitKey, bootstrappedKey: `hotel-core.${explicitKey}` };
}

export const HOTEL_PROPERTIES_LIMIT = hotelLimit('Property limit', 'hotel.properties.max');
export const HOTEL_ROOMS_LIMIT = hotelLimit('Sellable unit limit', 'hotel.rooms.max');
export const HOTEL_USERS_LIMIT = hotelLimit('Hospitality user limit', 'hotel.users.max');

export const HOSPITALITY_COMMERCIAL_LIMITS = [
  HOTEL_PROPERTIES_LIMIT,
  HOTEL_ROOMS_LIMIT,
  HOTEL_USERS_LIMIT,
] as const;

function invalidReason(
  value: number
): 'negative' | 'fractional' | 'non-finite' | 'unsafe-integer' | undefined {
  if (!Number.isFinite(value)) return 'non-finite';
  if (!Number.isInteger(value)) return 'fractional';
  if (value < 0) return 'negative';
  if (!Number.isSafeInteger(value)) return 'unsafe-integer';
  return undefined;
}

export function resolveEntitlementLimit(
  limits: Readonly<Record<string, number>>,
  definition: EntitlementLimitDefinition
): EntitlementLimitResolution {
  const source = Object.prototype.hasOwnProperty.call(limits, definition.explicitKey)
    ? ('explicit' as const)
    : Object.prototype.hasOwnProperty.call(limits, definition.bootstrappedKey)
      ? ('bootstrapped' as const)
      : undefined;
  const key = source === 'explicit' ? definition.explicitKey : definition.bootstrappedKey;

  if (!source) {
    return {
      status: 'missing',
      explicitKey: definition.explicitKey,
      bootstrappedKey: definition.bootstrappedKey,
    };
  }

  const value = limits[key]!;
  const reason = invalidReason(value);
  if (!reason) {
    return {
      status: 'configured',
      key,
      source,
      value,
    };
  }

  return {
    status: 'missing',
    explicitKey: definition.explicitKey,
    bootstrappedKey: definition.bootstrappedKey,
    invalidKey: key,
    invalidReason: reason,
  };
}
