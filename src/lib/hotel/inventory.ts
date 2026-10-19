/**
 * PROP-02 / PROP-03 / HK-03 / MODE-02 — the inventory rules, kept out of the
 * router and out of the page.
 *
 * Four things live here and nowhere else:
 *
 * - the **status transition matrix**. PROP-03 lists six states; which moves
 *   between them are legal is a property of the domain, not of whichever surface
 *   asked. The matrix is data, so a test can walk every pair rather than trust a
 *   chain of `if`s;
 * - the rule that **`OCCUPIED` belongs to the stay**. A guest arriving is a
 *   check-in and a guest leaving is a check-out or a move; neither is a status
 *   change somebody makes on a board. {@link planRoomStatusChange} refuses any
 *   transition that enters or leaves `OCCUPIED` and says which action to use
 *   instead, so the front desk lane can own that edge without this one guessing
 *   at it;
 * - **derived bed occupancy** (invariant 22). A dorm room's occupancy is counted
 *   from its beds every time it is asked for. Nothing stores it, so nothing can
 *   store it wrongly; and
 * - the **input contracts** the `hotelProperty` router validates against, so the
 *   page, the router and the tests agree on what a room type, a room, a bed and
 *   a block may be.
 *
 * Modes are configuration (MODE-01). Nothing below asks what mode a property is
 * in: a HOSTEL is a property whose types happen to be `BED`, and an APARTMENT is
 * one whose types happen to be `UNIT`. The defaults that make those the obvious
 * choice belong to the defaults layer.
 */
import { z } from 'zod';

import {
  HotelGenderPolicy,
  HotelInventoryKind,
  HotelRoomBlockKind,
  HotelRoomStatus,
} from '@/generated/prisma/enums';

export type HotelRoomStatusValue = (typeof HotelRoomStatus)[keyof typeof HotelRoomStatus];
export type HotelInventoryKindValue = (typeof HotelInventoryKind)[keyof typeof HotelInventoryKind];
export type HotelRoomBlockKindValue = (typeof HotelRoomBlockKind)[keyof typeof HotelRoomBlockKind];

export const HOTEL_ROOM_STATUSES = Object.values(HotelRoomStatus);
export const HOTEL_INVENTORY_KINDS = Object.values(HotelInventoryKind);
export const HOTEL_ROOM_BLOCK_KINDS = Object.values(HotelRoomBlockKind);

/** UX rule 1: no surface prints a bare enum value. */
export const HOTEL_ROOM_STATUS_LABELS: Record<HotelRoomStatusValue, string> = {
  VACANT_CLEAN: 'Vacant, clean',
  VACANT_DIRTY: 'Vacant, dirty',
  OCCUPIED: 'Occupied',
  INSPECTED: 'Inspected',
  OUT_OF_ORDER: 'Out of order',
  OUT_OF_SERVICE: 'Out of service',
};

export const HOTEL_INVENTORY_KIND_LABELS: Record<HotelInventoryKindValue, string> = {
  ROOM: 'Room',
  BED: 'Bed in a shared room',
  UNIT: 'Unit',
};

export const HOTEL_INVENTORY_KIND_DESCRIPTIONS: Record<HotelInventoryKindValue, string> = {
  ROOM: 'Sold whole, by the night.',
  BED: 'Sold one berth at a time; the room’s occupancy is counted from its beds.',
  UNIT: 'A self-contained unit, usually let by the week or the month.',
};

export const HOTEL_ROOM_BLOCK_KIND_LABELS: Record<HotelRoomBlockKindValue, string> = {
  OUT_OF_ORDER: 'Out of order',
  OUT_OF_SERVICE: 'Out of service',
};

export const HOTEL_GENDER_POLICY_LABELS: Record<
  (typeof HotelGenderPolicy)[keyof typeof HotelGenderPolicy],
  string
> = {
  ANY: 'No restriction',
  MALE: 'Men only',
  FEMALE: 'Women only',
};

/**
 * The state a stay owns. Reaching it is a check-in; leaving it is a check-out or
 * a room move. Both are the front desk lane's, and both post to a folio, so a
 * board that could set it would be a way to occupy a room without billing it.
 */
export const STAY_OWNED_ROOM_STATUS: HotelRoomStatusValue = 'OCCUPIED';

/**
 * The statuses housekeeping may set (06 §1: "board, tasks, inspections"). A
 * housekeeper cleans, and an inspector passes or fails the clean; withholding a
 * room from sale is a block (HK-03), not a status somebody types in.
 */
export const HOUSEKEEPING_ROOM_STATUSES: readonly HotelRoomStatusValue[] = [
  'VACANT_CLEAN',
  'VACANT_DIRTY',
  'INSPECTED',
];

/**
 * PROP-03's transition matrix. Read as "from → the states it may become".
 *
 * The shape of it:
 *
 * - cleaning runs `VACANT_DIRTY → VACANT_CLEAN → INSPECTED`, and an inspection
 *   that fails sends the room back to `VACANT_DIRTY`;
 * - a sellable room (`VACANT_CLEAN` or `INSPECTED`) is what a check-in may take,
 *   which is the state rule the front desk overrides against (FD-02);
 * - a departure always lands on `VACANT_DIRTY` — a room a guest has left is
 *   never clean until somebody says so (FD-03, FD-04);
 * - anything vacant may be withheld (`OUT_OF_ORDER` / `OUT_OF_SERVICE`) and the
 *   two may be corrected into each other; and
 * - a room coming back from either lands on `VACANT_DIRTY`, because a room that
 *   has had work done in it needs cleaning before it is sold.
 *
 * An occupied room is not withheld: the guest is moved first, which returns the
 * room to `VACANT_DIRTY` and makes the block a normal one.
 */
export const HOTEL_ROOM_TRANSITIONS: Record<HotelRoomStatusValue, readonly HotelRoomStatusValue[]> =
  {
    VACANT_CLEAN: ['VACANT_DIRTY', 'INSPECTED', 'OCCUPIED', 'OUT_OF_ORDER', 'OUT_OF_SERVICE'],
    VACANT_DIRTY: ['VACANT_CLEAN', 'OUT_OF_ORDER', 'OUT_OF_SERVICE'],
    INSPECTED: ['VACANT_DIRTY', 'VACANT_CLEAN', 'OCCUPIED', 'OUT_OF_ORDER', 'OUT_OF_SERVICE'],
    OCCUPIED: ['VACANT_DIRTY'],
    OUT_OF_ORDER: ['VACANT_DIRTY', 'OUT_OF_SERVICE'],
    OUT_OF_SERVICE: ['VACANT_DIRTY', 'OUT_OF_ORDER'],
  };

/** The states a room may be assigned from at check-in (FD-02's state rule). */
export const ASSIGNABLE_ROOM_STATUSES: readonly HotelRoomStatusValue[] = [
  'VACANT_CLEAN',
  'INSPECTED',
];

export function isAllowedRoomTransition(
  from: HotelRoomStatusValue,
  to: HotelRoomStatusValue
): boolean {
  return HOTEL_ROOM_TRANSITIONS[from].includes(to);
}

export type RoomStatusChangeRefusal = {
  ok: false;
  /** Which rule refused, so a caller can map it to a tRPC code without matching on prose. */
  code: 'UNCHANGED' | 'STAY_OWNED' | 'NOT_ALLOWED' | 'NOT_PERMITTED';
  message: string;
};

export type RoomStatusChangePlan = {
  ok: true;
  from: HotelRoomStatusValue;
  to: HotelRoomStatusValue;
  /** The append-only line this change must write alongside the room update. */
  event: {
    fromStatus: HotelRoomStatusValue;
    toStatus: HotelRoomStatusValue;
    actorId: string;
    reason: string;
  };
};

export type RoomStatusChangeOutcome = RoomStatusChangePlan | RoomStatusChangeRefusal;

/**
 * Decide one status change, and say what it must record.
 *
 * Pure: it takes the current state, the wanted state, who is asking and why, and
 * returns either the update-plus-event pair to write in one transaction or the
 * reason it is refused. The caller writes; this decides. That is what lets the
 * whole matrix be tested without a database and stops a second surface growing
 * its own idea of which moves are legal.
 *
 * `allowed` is the set of statuses this actor may set — the router passes the
 * housekeeping subset for a housekeeper and every status for a property
 * administrator. Passing `undefined` means "no capability restriction", which is
 * how the front desk lane will call it once it owns `OCCUPIED`.
 */
export function planRoomStatusChange(input: {
  from: HotelRoomStatusValue;
  to: HotelRoomStatusValue;
  actorId: string;
  reason: string;
  allowed?: readonly HotelRoomStatusValue[];
}): RoomStatusChangeOutcome {
  const { from, to, actorId, reason, allowed } = input;

  if (from === to) {
    return {
      ok: false,
      code: 'UNCHANGED',
      message: `This room is already ${HOTEL_ROOM_STATUS_LABELS[to].toLowerCase()}.`,
    };
  }

  // Checked before the matrix, so the message names the action to take rather
  // than reporting that a legal move is illegal.
  if (from === STAY_OWNED_ROOM_STATUS || to === STAY_OWNED_ROOM_STATUS) {
    return {
      ok: false,
      code: 'STAY_OWNED',
      message:
        to === STAY_OWNED_ROOM_STATUS
          ? 'A room becomes occupied when a guest is checked into it, not from the status board. Check the guest in instead.'
          : 'An occupied room is released by checking the guest out or moving them, not from the status board.',
    };
  }

  if (!isAllowedRoomTransition(from, to)) {
    return {
      ok: false,
      code: 'NOT_ALLOWED',
      message: `A room that is ${HOTEL_ROOM_STATUS_LABELS[from].toLowerCase()} cannot become ${HOTEL_ROOM_STATUS_LABELS[to].toLowerCase()}.`,
    };
  }

  if (allowed && !allowed.includes(to)) {
    return {
      ok: false,
      code: 'NOT_PERMITTED',
      message: `You may set ${allowed.map((status) => HOTEL_ROOM_STATUS_LABELS[status].toLowerCase()).join(', ')}. Setting ${HOTEL_ROOM_STATUS_LABELS[to].toLowerCase()} is somebody else's decision.`,
    };
  }

  return {
    ok: true,
    from,
    to,
    event: { fromStatus: from, toStatus: to, actorId, reason: reason.trim() },
  };
}

/**
 * Invariant 22 — a dorm room's occupancy, counted rather than stored.
 *
 * `sellable` is what availability may offer: a bed that is active and not
 * withheld. `occupied` is what a bed board shows as taken. No column anywhere
 * holds either number, so no row can disagree with the beds.
 */
export function deriveBedOccupancy(
  beds: readonly { status: HotelRoomStatusValue; active: boolean }[]
): { total: number; active: number; occupied: number; sellable: number; outOfService: number } {
  const active = beds.filter((bed) => bed.active);
  const withheld = (status: HotelRoomStatusValue) =>
    status === 'OUT_OF_ORDER' || status === 'OUT_OF_SERVICE';
  return {
    total: beds.length,
    active: active.length,
    occupied: active.filter((bed) => bed.status === 'OCCUPIED').length,
    sellable: active.filter((bed) => bed.status !== 'OCCUPIED' && !withheld(bed.status)).length,
    outOfService: active.filter((bed) => withheld(bed.status)).length,
  };
}

/**
 * Whether a room reads as occupied. For ROOM and UNIT that is its own status;
 * for BED it is derived — a dorm room is occupied when any berth is.
 */
export function roomIsOccupied(room: {
  inventoryKind: HotelInventoryKindValue;
  status: HotelRoomStatusValue;
  beds?: readonly { status: HotelRoomStatusValue; active: boolean }[];
}): boolean {
  if (room.inventoryKind !== 'BED') return room.status === 'OCCUPIED';
  return deriveBedOccupancy(room.beds ?? []).occupied > 0;
}

// ---------------------------------------------------------------------------
// Input contracts
// ---------------------------------------------------------------------------

/** Upper-case token; it travels to rate plans, channel mappings and imports. */
const roomTypeCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(24)
  .regex(
    /^[A-Z0-9][A-Z0-9_-]*$/,
    'Use letters, numbers, hyphens or underscores, starting with a letter or number.'
  );

const shortText = (max: number) => z.string().trim().min(1).max(max);

/** ISO calendar day. Blocks are dated in the property's own days, not instants. */
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-09-08.')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), 'That date is not real.');

export const hotelRoomTypeInput = z
  .object({
    code: roomTypeCode,
    name: shortText(120),
    nameUr: z.string().trim().max(120).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    inventoryKind: z.enum(HotelInventoryKind),
    bedsPerRoom: z.coerce.number().int().min(1).max(64).nullable().optional(),
    baseAdults: z.coerce.number().int().min(1).max(32),
    maxAdults: z.coerce.number().int().min(1).max(32),
    maxChildren: z.coerce.number().int().min(0).max(32),
    bedConfig: z.string().trim().max(120).nullable().optional(),
    amenities: z.array(shortText(60)).max(40).default([]),
    images: z.array(z.string().trim().url().max(500)).max(20).default([]),
    upgradeRank: z.coerce.number().int().min(0).max(999).default(0),
    sort: z.coerce.number().int().min(0).max(999).default(0),
    active: z.boolean().default(true),
  })
  // The same two rules the database CHECKs enforce, restated here so an operator
  // is told which field is wrong instead of being handed a constraint name.
  .refine((value) => value.maxAdults >= value.baseAdults, {
    message: 'The maximum number of adults cannot be below the standard occupancy.',
    path: ['maxAdults'],
  })
  .refine(
    (value) => (value.inventoryKind === 'BED' ? (value.bedsPerRoom ?? 0) >= 1 : true),
    { message: 'A bed type has to say how many beds a room of this type holds.', path: ['bedsPerRoom'] }
  )
  .refine((value) => (value.inventoryKind === 'BED' ? true : value.bedsPerRoom == null), {
    message: 'Only a bed type declares beds per room.',
    path: ['bedsPerRoom'],
  });

export type HotelRoomTypeInput = z.infer<typeof hotelRoomTypeInput>;

export const hotelRoomInput = z.object({
  roomTypeId: shortText(191),
  number: shortText(24),
  floor: z.string().trim().max(24).nullable().optional(),
  features: z.array(shortText(60)).max(40).default([]),
  connectingRoomId: z.string().trim().max(191).nullable().optional(),
  genderPolicy: z.enum(HotelGenderPolicy).default('ANY'),
  active: z.boolean().default(true),
});

export type HotelRoomInput = z.infer<typeof hotelRoomInput>;

export const hotelBedInput = z.object({
  roomId: shortText(191),
  label: shortText(24),
  active: z.boolean().default(true),
});

export const hotelRoomStatusInput = z.object({
  roomId: shortText(191),
  /** Set to change one berth rather than the whole room. */
  bedId: z.string().trim().max(191).nullable().optional(),
  status: z.enum(HotelRoomStatus),
  // HK-01 is "every change attributed"; a reason with no words in it is not one.
  reason: shortText(300),
});

export const hotelRoomBlockInput = z
  .object({
    roomId: shortText(191),
    kind: z.enum(HotelRoomBlockKind),
    startsOn: isoDate,
    endsOn: isoDate,
    reason: shortText(300),
    workOrderRef: z.string().trim().max(191).nullable().optional(),
  })
  .refine((value) => value.endsOn >= value.startsOn, {
    message: 'A block cannot end before it starts.',
    path: ['endsOn'],
  });

export type HotelRoomBlockInput = z.infer<typeof hotelRoomBlockInput>;

/**
 * An ISO day as the UTC instant a `date` column stores. Blocks are calendar
 * ranges in the property's own days; parsing them at UTC midnight keeps the day
 * that was typed the day that is stored, whatever the server's zone.
 */
export function calendarDay(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** The reverse, for rendering a stored block back into the field it came from. */
export function calendarDayIso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Did this error come from the block-overlap exclusion constraint?
 *
 * A resolver checks for an overlapping block before inserting, so the operator
 * gets a sentence naming the dates. That check is a courtesy, not the guarantee:
 * two requests racing each other both pass it, and the constraint is what
 * actually refuses the second. This recognises that refusal so the race produces
 * the same message rather than a driver stack trace.
 *
 * SQLSTATE 23P01 is `exclusion_violation`. The driver buries it at a different
 * depth depending on the adapter, so the search walks the usual wrapper keys —
 * the same approach `restaurant-shifts.errors` takes for its own constraint.
 */
export function isExclusionViolation(error: unknown, seen = new Set<unknown>()): boolean {
  if (typeof error === 'string') return error.includes('23P01');
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const record = error as Record<string, unknown>;
  if (record.code === '23P01' || record.sqlState === '23P01') return true;
  return ['cause', 'originalError', 'driverError', 'meta', 'database_error'].some((key) =>
    isExclusionViolation(record[key], seen)
  );
}
