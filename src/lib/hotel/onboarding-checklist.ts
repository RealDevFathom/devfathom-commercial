/**
 * COMP-01 / PROP-01 — the hospitality onboarding checklist.
 *
 * Mirrors `src/lib/pharmacy/onboarding-checklist.ts` in shape and in the one rule
 * that matters: **a stored claim is never the verdict.** Readiness is recomputed
 * from the property record and the organization's roles on every read, so seed
 * data, a bulk import or a hand-written row cannot move a step to done. The
 * difference from pharmacy is that every hospitality step happens to be
 * evidence-backed, so there is no attestation path at all — nothing here accepts
 * an operator's word for anything.
 *
 * Every item blocks activation. `assertActivationReady` calls
 * {@link evaluateHotelReadiness} for a HOSPITALITY organization and refuses to
 * activate while any item is pending, which is the "no go-live while blocking
 * items pending" rule of PROP-01's acceptance criterion.
 *
 * Step 6 asks for what the property sells. A property whose configuration
 * (mode plus explicit overrides) sells rooms, beds or units needs a room type;
 * one whose configuration resolves to no room inventory at all — a venue —
 * could never add one, so it needs an active function space instead. Only a
 * configuration that resolves to no room inventory earns that step: a property
 * that sells rooms keeps the room-type step whatever else it sells, and a
 * configuration that cannot be read keeps it too.
 *
 * The types repeat the pharmacy checklist's row shape rather than importing it.
 * Two verticals sharing a *rendering* contract is intended; two verticals sharing
 * a module is not, because a hospitality change would then have to be safe for a
 * regulated pharmacy surface.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { readHotelModeOverrides } from '@/lib/hotel/mode-overrides';
import { applyHotelModeDefaults } from '@/lib/hotel/modes';
import {
  HOTEL_PROPERTY_MODES,
  isValidHotelTimezone,
  type HotelPropertyModeValue,
} from '@/lib/hotel/property';
import { roleTemplatesForVertical } from '@/lib/vertical-catalog';

export type HotelOnboardingItemKey =
  | 'MODE_CHOSEN'
  | 'PROPERTY_FACTS'
  | 'TAX_PROFILE'
  | 'BUSINESS_DATE_AND_AUDIT'
  | 'ROLES_ASSIGNED'
  /** Step 6 for a property that sells rooms, beds or units. */
  | 'ROOM_TYPES'
  /** Step 6, instead, for a property that sells no room inventory (a venue). */
  | 'FUNCTION_SPACES';

export type HotelOnboardingStep = {
  key: HotelOnboardingItemKey;
  /** 1-based position in the walk an operator follows. */
  step: number;
  label: string;
  /** Every hospitality step blocks go-live; kept explicit so a later optional
   * step does not have to be discovered by reading the resolver. */
  blocking: boolean;
  /** How the step is answered, and where. Never "OK". */
  todo: string;
  done: string;
  href: string | null;
  linkLabel: string | null;
};

export const HOTEL_ONBOARDING_STEPS: readonly HotelOnboardingStep[] = [
  {
    key: 'MODE_CHOSEN',
    step: 1,
    label: 'Property mode',
    blocking: true,
    todo: 'Create the property and choose how it operates — hotel, hostel, apartments, resort or venue.',
    done: 'The property records how it operates.',
    href: '/hotel/settings/property',
    linkLabel: 'Open property settings',
  },
  {
    key: 'PROPERTY_FACTS',
    step: 2,
    label: 'Property facts',
    blocking: true,
    todo: 'Record the property name, address, city, timezone and its check-in and check-out times.',
    done: 'Name, address, timezone and the guest-facing times are recorded.',
    href: '/hotel/settings/property',
    linkLabel: 'Open property settings',
  },
  {
    key: 'TAX_PROFILE',
    step: 3,
    label: 'Tax profile',
    blocking: true,
    todo: 'Attach the tax profile every folio charge will be taxed from. No property goes live untaxed.',
    done: 'A tax profile is attached to this property.',
    href: '/hotel/settings/property',
    linkLabel: 'Open property settings',
  },
  {
    key: 'BUSINESS_DATE_AND_AUDIT',
    step: 4,
    label: 'Business date and audit time',
    blocking: true,
    todo: 'Set the time the night audit runs and the rule that rolls the business date.',
    done: 'The audit time and the business-date rule are set.',
    href: '/hotel/settings/property',
    linkLabel: 'Open property settings',
  },
  {
    key: 'ROLES_ASSIGNED',
    step: 5,
    label: 'Roles assigned',
    blocking: true,
    todo: 'The hospitality role templates are missing. They are created with the workspace, so ask your DevFathom account manager to re-run provisioning.',
    done: 'The hospitality role templates are in place.',
    href: '/organization',
    linkLabel: 'Open organization',
  },
  {
    key: 'ROOM_TYPES',
    step: 6,
    // PROP-02 (H1-03). Answered by counting the property's active room types;
    // the rooms sold under them are added on the same page.
    label: 'At least one room type',
    blocking: true,
    todo: 'Add at least one room type — standard room, dorm bed, apartment — then the rooms sold under it. Nothing can be reserved until a type exists.',
    done: 'At least one sellable room type exists.',
    href: '/hotel/settings/rooms',
    linkLabel: 'Open rooms',
  },
];

/**
 * Step 6 for a property whose configuration sells no rooms, beds or units.
 * PROP-07. Answered by counting the property's active function spaces; the
 * room-type step it replaces could never be answered there, because such a
 * property cannot add a room type at all.
 */
const FUNCTION_SPACES_STEP: HotelOnboardingStep = {
  key: 'FUNCTION_SPACES',
  step: 6,
  label: 'At least one active function space',
  blocking: true,
  todo: 'Add at least one function space — a hall, lawn or boardroom — with its layouts and prices, and keep it active. This property sells function space rather than rooms, so nothing can be booked until one is active.',
  done: 'At least one active function space is set up.',
  href: '/hotel/settings/spaces',
  linkLabel: 'Open function spaces',
};

/** The same walk for a property that sells no room inventory: step 6 asks for a function space. */
export const HOTEL_VENUE_ONBOARDING_STEPS: readonly HotelOnboardingStep[] =
  HOTEL_ONBOARDING_STEPS.map((step) => (step.key === 'ROOM_TYPES' ? FUNCTION_SPACES_STEP : step));

type HotelWalkEvidence = Record<
  Exclude<HotelOnboardingItemKey, 'ROOM_TYPES' | 'FUNCTION_SPACES'>,
  boolean
>;

/**
 * One answer per step of the walk the property follows: room types for a
 * property that sells room inventory, function spaces for one that sells none.
 * Exactly one of the two is present, so the walk is decided by the evidence and
 * no caller can hold both answers at once.
 */
export type HotelOnboardingEvidence = HotelWalkEvidence &
  (
    | { ROOM_TYPES: boolean; FUNCTION_SPACES?: never }
    | { FUNCTION_SPACES: boolean; ROOM_TYPES?: never }
  );

/** What step 6 of a property's walk counts. */
export type HotelSellableInventory = 'ROOM_TYPES' | 'FUNCTION_SPACES';

function isHotelPropertyMode(mode: string | null): mode is HotelPropertyModeValue {
  return mode !== null && (HOTEL_PROPERTY_MODES as readonly string[]).includes(mode);
}

/**
 * Which step 6 this property's walk has, from its own configuration — never
 * from a mode name: VENUE resolves to no room inventory by default, and any
 * mode can be overridden either way. Only a configuration that resolves to an
 * empty `inventoryKinds` gets the function-space step. No property, an unknown
 * mode or overrides that cannot be read all keep the room-type step, so the
 * exception is never reached by missing or damaged data and the rule for a
 * property that sells rooms is never loosened.
 */
export function hotelSellableInventory(
  property: { mode: string | null; modeOverrides: unknown } | null
): HotelSellableInventory {
  if (!property || !isHotelPropertyMode(property.mode)) return 'ROOM_TYPES';
  let overrides: ReturnType<typeof readHotelModeOverrides>;
  try {
    overrides = readHotelModeOverrides(property.modeOverrides);
  } catch {
    return 'ROOM_TYPES';
  }
  return applyHotelModeDefaults(property.mode, overrides).inventoryKinds.length === 0
    ? 'FUNCTION_SPACES'
    : 'ROOM_TYPES';
}

export type HotelChecklistItemState = 'DONE' | 'NEEDS_YOU';

export type HotelChecklistItem = HotelOnboardingStep & {
  state: HotelChecklistItemState;
  /** One line: how it was satisfied, or exactly what to do next. */
  why: string;
  /** True when leaving this row unresolved refuses activation. */
  blocksActivation: boolean;
};

export type HotelOnboardingChecklist = {
  organizationId: string;
  items: readonly HotelChecklistItem[];
  doneCount: number;
  totalCount: number;
  /** Rows that refuse activation while they stand, in walk order. */
  blocking: readonly HotelChecklistItem[];
  ready: boolean;
};

/**
 * Turn evidence into the checklist. Pure, so the go-live rule is testable
 * without a database and so no caller can reach `ready` by another route. The
 * walk follows the evidence: a function-space answer means the venue walk.
 */
export function evaluateHotelOnboarding(
  organizationId: string,
  evidence: HotelOnboardingEvidence
): HotelOnboardingChecklist {
  const steps =
    evidence.FUNCTION_SPACES === undefined ? HOTEL_ONBOARDING_STEPS : HOTEL_VENUE_ONBOARDING_STEPS;
  const answers: Partial<Record<HotelOnboardingItemKey, boolean>> = evidence;
  const items = steps.map((step): HotelChecklistItem => {
    const done = answers[step.key] === true;
    return {
      ...step,
      state: done ? 'DONE' : 'NEEDS_YOU',
      why: done ? step.done : step.todo,
      blocksActivation: step.blocking && !done,
    };
  });
  const blocking = items.filter((item) => item.blocksActivation);
  return {
    organizationId,
    items,
    doneCount: items.filter((item) => item.state === 'DONE').length,
    totalCount: items.length,
    blocking,
    ready: blocking.length === 0,
  };
}

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Does this JSON policy column hold a decision, rather than the `{}` default? */
function policyRecorded(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0
  );
}

/**
 * The property facts and the roles this organization actually holds, read as the
 * tenant. Exported separately from the queries so the evidence rules can be
 * exercised without a database.
 *
 * Step 6 is answered by the count {@link hotelSellableInventory} names for this
 * property and by no other: room types for a property that sells room
 * inventory, active function spaces for one that sells none. Each count has
 * its own parameter, so a count gathered for the wrong walk reads as not
 * gathered (pending) rather than standing in for the other.
 */
export function hotelEvidence(
  property: {
    mode: string | null;
    /** Explicit configuration; decides which step 6 the walk has. */
    modeOverrides: unknown;
    name: string | null;
    addressLine: string | null;
    city: string | null;
    timezone: string | null;
    checkInTime: string | null;
    checkOutTime: string | null;
    auditTime: string | null;
    taxProfileId: string | null;
    businessDatePolicy: unknown;
  } | null,
  seededRoleKeyCount: number,
  requiredRoleKeyCount: number,
  roomTypeCount: number | null,
  functionSpaceCount: number | null = null
): HotelOnboardingEvidence {
  const walk: HotelWalkEvidence = {
    MODE_CHOSEN: nonEmpty(property?.mode),
    PROPERTY_FACTS: Boolean(
      property &&
      nonEmpty(property.name) &&
      nonEmpty(property.addressLine) &&
      nonEmpty(property.city) &&
      // A stored zone the runtime cannot use is not a recorded fact.
      isValidHotelTimezone(property.timezone) &&
      nonEmpty(property.checkInTime) &&
      nonEmpty(property.checkOutTime)
    ),
    TAX_PROFILE: nonEmpty(property?.taxProfileId),
    BUSINESS_DATE_AND_AUDIT: Boolean(
      property && nonEmpty(property.auditTime) && policyRecorded(property.businessDatePolicy)
    ),
    ROLES_ASSIGNED: requiredRoleKeyCount > 0 && seededRoleKeyCount >= requiredRoleKeyCount,
  };
  // Only a real count of what this property sells satisfies step 6. `null`
  // means the evidence was not gathered (no property to count under, or the
  // other walk's count) and reports pending rather than being quietly read as
  // satisfied.
  return hotelSellableInventory(property) === 'FUNCTION_SPACES'
    ? { ...walk, FUNCTION_SPACES: functionSpaceCount !== null && functionSpaceCount > 0 }
    : { ...walk, ROOM_TYPES: roomTypeCount !== null && roomTypeCount > 0 };
}

/**
 * How many room types a property can sell under, counted the way the step is
 * worded: active types of THIS property. Scoped by organization as well as by
 * property, so forced row-level security is the second wall and never the only
 * one.
 */
export function countSellableRoomTypes(
  db: Pick<PrismaClient, 'hotelRoomType'>,
  organizationId: string,
  branchId: string
): Promise<number> {
  return db.hotelRoomType.count({ where: { organizationId, branchId, active: true } });
}

/**
 * How many function spaces a property has on sale: active spaces of THIS
 * property, scoped by organization as well as by property like the room types.
 */
export function countActiveFunctionSpaces(
  db: Pick<PrismaClient, 'hotelFunctionSpace'>,
  organizationId: string,
  branchId: string
): Promise<number> {
  return db.hotelFunctionSpace.count({ where: { organizationId, branchId, active: true } });
}

/** The step-6 counts for {@link hotelEvidence}; the walk the property does not follow stays `null`. */
export type HotelSellableInventoryCounts = {
  roomTypes: number | null;
  functionSpaces: number | null;
};

/**
 * Count what this property's step 6 asks for, and only that: its room types
 * when its configuration sells room inventory, its active function spaces when
 * it sells none. The property must carry its stored `modeOverrides`, because
 * an override can turn a venue into a property that sells rooms.
 */
export async function countSellableInventory(
  db: Pick<PrismaClient, 'hotelRoomType' | 'hotelFunctionSpace'>,
  organizationId: string,
  property: { branchId: string; mode: string | null; modeOverrides: unknown }
): Promise<HotelSellableInventoryCounts> {
  return hotelSellableInventory(property) === 'FUNCTION_SPACES'
    ? {
        roomTypes: null,
        functionSpaces: await countActiveFunctionSpaces(db, organizationId, property.branchId),
      }
    : {
        roomTypes: await countSellableRoomTypes(db, organizationId, property.branchId),
        functionSpaces: null,
      };
}

/**
 * Run the evidence queries for one organization and evaluate every step.
 *
 * Every query carries an explicit `organizationId` predicate; forced row-level
 * security is the second wall and never the only one. The property read picks
 * the organization's first active property — PROP-04 multi-property arrives with
 * its own selector, and until then a hospitality organization holds exactly the
 * one property provisioning created. Room types — or, for a property that sells
 * no room inventory, function spaces — are counted under that same property,
 * never across the organization.
 */
export async function evaluateHotelReadiness(
  db: PrismaClient,
  organizationId: string
): Promise<HotelOnboardingChecklist> {
  const requiredRoleKeys = roleTemplatesForVertical('HOSPITALITY').map((template) => template.key);

  const [property, seededRoleKeys] = await Promise.all([
    db.hotelProperty.findFirst({
      where: { organizationId, active: true },
      orderBy: { createdAt: 'asc' },
      select: {
        branchId: true,
        mode: true,
        modeOverrides: true,
        name: true,
        addressLine: true,
        city: true,
        timezone: true,
        checkInTime: true,
        checkOutTime: true,
        auditTime: true,
        taxProfileId: true,
        businessDatePolicy: true,
      },
    }),
    db.organizationRole.count({ where: { organizationId, key: { in: requiredRoleKeys } } }),
  ]);
  const sellable: HotelSellableInventoryCounts = property
    ? await countSellableInventory(db, organizationId, property)
    : { roomTypes: null, functionSpaces: null };

  return evaluateHotelOnboarding(
    organizationId,
    hotelEvidence(
      property,
      seededRoleKeys,
      requiredRoleKeys.length,
      sellable.roomTypes,
      sellable.functionSpaces
    )
  );
}

/**
 * The activation status sentence, built from the same rows the checklist shows.
 * Names how many steps block and which, because the panel renders those rows
 * beneath it (UX rule 13).
 */
export function hotelActivationSummary(checklist: HotelOnboardingChecklist): string {
  if (checklist.ready) {
    return 'Every readiness step is done. This property can be activated.';
  }
  const names = checklist.blocking.map((item) => item.label);
  const count = names.length;
  const listed =
    names.length > 3
      ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
      : names.join(', ');
  return `Activation is refused until ${count === 1 ? 'this step is' : `these ${count} steps are`} done: ${listed}.`;
}
