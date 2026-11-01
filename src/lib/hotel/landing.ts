/**
 * The hospitality landing page's data: the properties the signed-in member can
 * administer, where each stands in the onboarding walk, and the handful of
 * facts the property list shows. Built only from what the hotel surfaces
 * already expose (`hotelProperty.extras.properties`, `hotelProperty.get`,
 * `hotelProperty.extras.list`), so the landing can never disagree with the
 * property settings page about readiness or access: the same router answers
 * both, through the same `hotel:property-admin` gate. That includes what the
 * property sells: whether the landing offers the rooms page and the meal plans
 * follows the walk the router chose — a room-type step for a property that
 * sells room inventory, a function-space step for one that sells none (a venue).
 *
 * Reservations and folios are not shipped in this build; the landing says so
 * instead of rendering the agency widgets.
 */
import { TRPCError } from '@trpc/server';

import { readHotelModeOverrides } from '@/lib/hotel/mode-overrides';
import { applyHotelModeDefaults } from '@/lib/hotel/modes';
import { HOTEL_PROPERTY_MODE_LABELS, type HotelPropertyModeValue } from '@/lib/hotel/property';
import type { HotelOnboardingChecklist } from '@/lib/hotel/onboarding-checklist';

/** The slice of the hotel property router the landing reads. */
export type HotelLandingSource = {
  extras: {
    properties: () => Promise<{ properties: { branchId: string; name: string }[] }>;
    list: (input: { branchId: string }) => Promise<{ extras: { active: boolean }[] }>;
  };
  get: (input: { branchId: string }) => Promise<{
    property: {
      branchId: string;
      name: string;
      city: string;
      mode: string;
      /** Explicit configuration; absent on an older read means the mode's defaults. */
      modeOverrides?: unknown;
      checkInTime: string;
      checkOutTime: string;
      currency: string;
      timezone: string;
    };
    checklist: HotelOnboardingChecklist;
    activationSummary: string;
  }>;
};

export type HotelLandingProperty = {
  branchId: string;
  name: string;
  city: string;
  /** Operator-facing mode name, never the enum value (UX rule 1). */
  modeLabel: string;
  /**
   * Whether the property sells rooms, beds or units — read off the walk the
   * router built for it (its step 6 asks for a room type), so the landing
   * offers the rooms page and the meal plans sold with a stay exactly where
   * readiness asks for a room type, and never on a venue, whose step 6 asks
   * for a function space instead.
   */
  sellsRooms: boolean;
  /**
   * Whether the property's configuration (mode plus explicit overrides) sells
   * function space — what decides whether the landing offers the spaces page.
   * The page itself re-checks the module and the configuration.
   */
  sellsFunctionSpaces: boolean;
  checkInTime: string;
  checkOutTime: string;
  currency: string;
  timezone: string;
  extrasCount: number;
  checklist: HotelOnboardingChecklist;
  activationSummary: string;
};

export type HotelLanding =
  | { kind: 'properties'; properties: HotelLandingProperty[] }
  /** Property administration is granted, but no property is assigned to this member. */
  | { kind: 'unassigned' }
  /** The member does not hold property administration. */
  | { kind: 'denied' }
  | { kind: 'error' };

export type HotelLandingSummary = {
  propertyCount: number;
  stepsDone: number;
  stepsTotal: number;
  blockingSteps: number;
  extrasCount: number;
  /** True when every property can be activated. */
  ready: boolean;
};

export function modeLabelFor(mode: string): string {
  return HOTEL_PROPERTY_MODE_LABELS[mode as HotelPropertyModeValue] ?? mode;
}

/** Does this walk ask for a room type? The venue walk asks for a function space instead. */
export function walkSellsRooms(checklist: HotelOnboardingChecklist): boolean {
  return checklist.items.some((item) => item.key === 'ROOM_TYPES');
}

/** The property's own configuration, never a mode name: VENUE by default, or an override. */
export function sellsFunctionSpaces(mode: string, modeOverrides: unknown): boolean {
  if (!(mode in HOTEL_PROPERTY_MODE_LABELS)) return false;
  return applyHotelModeDefaults(
    mode as HotelPropertyModeValue,
    readHotelModeOverrides(modeOverrides)
  ).functionSpaces;
}

/** The KPI ledger figures, from already-loaded properties. Pure, so it is testable alone. */
export function summarizeHotelLanding(
  properties: readonly HotelLandingProperty[]
): HotelLandingSummary {
  return {
    propertyCount: properties.length,
    stepsDone: properties.reduce((sum, property) => sum + property.checklist.doneCount, 0),
    stepsTotal: properties.reduce((sum, property) => sum + property.checklist.totalCount, 0),
    blockingSteps: properties.reduce(
      (sum, property) => sum + property.checklist.blocking.length,
      0
    ),
    extrasCount: properties.reduce((sum, property) => sum + property.extrasCount, 0),
    ready: properties.length > 0 && properties.every((property) => property.checklist.ready),
  };
}

export async function loadHotelLanding(source: HotelLandingSource): Promise<HotelLanding> {
  try {
    const { properties } = await source.extras.properties();
    if (properties.length === 0) return { kind: 'unassigned' };
    const loaded = await Promise.all(
      properties.map(async ({ branchId }): Promise<HotelLandingProperty> => {
        const [view, catalog] = await Promise.all([
          source.get({ branchId }),
          source.extras.list({ branchId }),
        ]);
        return {
          branchId: view.property.branchId,
          name: view.property.name,
          city: view.property.city,
          modeLabel: modeLabelFor(view.property.mode),
          sellsRooms: walkSellsRooms(view.checklist),
          sellsFunctionSpaces: sellsFunctionSpaces(view.property.mode, view.property.modeOverrides),
          checkInTime: view.property.checkInTime,
          checkOutTime: view.property.checkOutTime,
          currency: view.property.currency,
          timezone: view.property.timezone,
          extrasCount: catalog.extras.filter((extra) => extra.active).length,
          checklist: view.checklist,
          activationSummary: view.activationSummary,
        };
      })
    );
    return { kind: 'properties', properties: loaded };
  } catch (error) {
    const code = error instanceof TRPCError ? error.code : null;
    if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') return { kind: 'denied' };
    return { kind: 'error' };
  }
}
