/**
 * PROP-02 / PROP-03 / HK-01 / HK-03 / MODE-02 — the inventory rules and the
 * inventory engine, kept out of the router and out of the page.
 *
 * What lives here and nowhere else:
 *
 * - the **vocabulary**: the kinds, statuses, block kinds and dorm policies the
 *   database enumerates, with the names an operator reads (UX rule 1: no
 *   surface prints a bare enum value);
 * - the **status transition matrix**, as data, so a test can walk every pair
 *   rather than trust a chain of `if`s. It is the same matrix
 *   `hotel_inventory_transition_allowed` enforces in SQL, and the DB suite pins
 *   the two against each other for every pair;
 * - the rule that **`OCCUPIED` belongs to the stay**. A guest arriving is a
 *   check-in and a guest leaving is a check-out or a move; neither is a status
 *   change somebody makes on a board. {@link planRoomStatusChange} refuses any
 *   transition that enters or leaves `OCCUPIED` and says which action to use
 *   instead, so the front desk lane can own that edge without this one
 *   guessing at it;
 * - **derived bed occupancy** (invariant 22): a dorm room's occupancy is
 *   counted from its beds every time it is asked for, never stored;
 * - the **input contracts** the `hotelProperty.inventory` router validates
 *   against; and
 * - the **engine**: the service functions that create rooms (provisioning the
 *   beds a BED type declares), change a status under the transition matrix,
 *   and open and release blocks — each inside the caller's tenant transaction,
 *   with the actor and the reason handed to the database through the GUCs the
 *   status triggers read.
 *
 * Modes are configuration (MODE-01). Nothing below asks what mode a property
 * is in: a HOSTEL is a property whose types happen to be `BED`, and an
 * APARTMENT is one whose types happen to be `UNIT`. Which kinds a property may
 * add is the router's question to `evaluateHotelFeatures`.
 */
import { z } from 'zod';

import type { PrismaClient } from '@/generated/prisma/client';
import type {
  HotelGenderPolicy as GeneratedGenderPolicy,
  HotelInventoryKind as GeneratedInventoryKind,
  HotelRoomBlockKind as GeneratedRoomBlockKind,
  HotelRoomStatus as GeneratedRoomStatus,
} from '@/generated/prisma/enums';

export type HotelRoomStatusValue = (typeof GeneratedRoomStatus)[keyof typeof GeneratedRoomStatus];
export type HotelInventoryKindValue =
  (typeof GeneratedInventoryKind)[keyof typeof GeneratedInventoryKind];
export type HotelRoomBlockKindValue =
  (typeof GeneratedRoomBlockKind)[keyof typeof GeneratedRoomBlockKind];
export type HotelGenderPolicyValue =
  (typeof GeneratedGenderPolicy)[keyof typeof GeneratedGenderPolicy];

// Spelled out as tuples (and pinned to the generated enums by `satisfies`) so
// the input contracts below can use them and a consumer never needs the
// generated client at runtime.
export const HOTEL_INVENTORY_KINDS = ['ROOM', 'BED', 'UNIT'] as const satisfies readonly [
  HotelInventoryKindValue,
  ...HotelInventoryKindValue[],
];
export const HOTEL_ROOM_STATUSES = [
  'VACANT_CLEAN',
  'VACANT_DIRTY',
  'OCCUPIED',
  'INSPECTED',
  'OUT_OF_ORDER',
  'OUT_OF_SERVICE',
] as const satisfies readonly [HotelRoomStatusValue, ...HotelRoomStatusValue[]];
/** The statuses a board may set: every status but the stay-owned one. */
export const HOTEL_INVENTORY_STATUSES = [
  'VACANT_CLEAN',
  'VACANT_DIRTY',
  'INSPECTED',
  'OUT_OF_ORDER',
  'OUT_OF_SERVICE',
] as const satisfies readonly [HotelRoomStatusValue, ...HotelRoomStatusValue[]];
export const HOTEL_ROOM_BLOCK_KINDS = [
  'OUT_OF_ORDER',
  'OUT_OF_SERVICE',
] as const satisfies readonly [HotelRoomBlockKindValue, ...HotelRoomBlockKindValue[]];
export const HOTEL_GENDER_POLICIES = ['ANY', 'MALE', 'FEMALE'] as const satisfies readonly [
  HotelGenderPolicyValue,
  ...HotelGenderPolicyValue[],
];

export type HotelInventoryKind = HotelInventoryKindValue;
export type HotelInventoryStatus = (typeof HOTEL_INVENTORY_STATUSES)[number];
export type HotelInventoryScope = { organizationId: string; branchId: string; actorId: string };

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

export const HOTEL_ROOM_BLOCK_KIND_DESCRIPTIONS: Record<HotelRoomBlockKindValue, string> = {
  OUT_OF_ORDER: 'Broken: the room cannot be sold until it is repaired.',
  OUT_OF_SERVICE: 'Withheld on purpose: refurbishment, deep clean or a management decision.',
};

export const HOTEL_GENDER_POLICY_LABELS: Record<HotelGenderPolicyValue, string> = {
  ANY: 'No restriction',
  MALE: 'Men only',
  FEMALE: 'Women only',
};

/**
 * The state a stay owns. Reaching it is a check-in; leaving it is a check-out
 * or a room move. Both are the front desk lane's, and both post to a folio, so
 * a board that could set it would be a way to occupy a room without billing it.
 */
export const STAY_OWNED_ROOM_STATUS: HotelRoomStatusValue = 'OCCUPIED';

/**
 * The statuses housekeeping may set (06 §1: "board, tasks, inspections"). A
 * housekeeper cleans, and an inspector passes or fails the clean; withholding a
 * room from sale is a block (HK-03) or a property administrator's decision, not
 * a status somebody types in.
 */
export const HOUSEKEEPING_ROOM_STATUSES: readonly HotelRoomStatusValue[] = [
  'VACANT_CLEAN',
  'VACANT_DIRTY',
  'INSPECTED',
];

/** The states a room may be assigned from at check-in (FD-02's state rule). */
export const ASSIGNABLE_ROOM_STATUSES: readonly HotelRoomStatusValue[] = [
  'VACANT_CLEAN',
  'INSPECTED',
];

/**
 * PROP-03's transition matrix, exactly as `hotel_inventory_transition_allowed`
 * enforces it in SQL. Read as "from → the states it may become".
 *
 * - cleaning runs `VACANT_DIRTY → VACANT_CLEAN → INSPECTED`, and an inspection
 *   that fails sends the room back to `VACANT_DIRTY`;
 * - anything vacant may be withheld (`OUT_OF_ORDER` / `OUT_OF_SERVICE`) and the
 *   two may be corrected into each other;
 * - a room coming back from either lands on `VACANT_DIRTY`, because a room that
 *   has had work done in it is cleaned before it is sold; and
 * - `OCCUPIED` is neither a source nor a target: it is reserved for the stay
 *   lane's own transition, in SQL as well as here.
 */
export const HOTEL_ROOM_TRANSITIONS: Record<HotelRoomStatusValue, readonly HotelRoomStatusValue[]> =
  {
    VACANT_DIRTY: ['VACANT_CLEAN', 'OUT_OF_ORDER', 'OUT_OF_SERVICE'],
    VACANT_CLEAN: ['VACANT_DIRTY', 'INSPECTED', 'OUT_OF_ORDER', 'OUT_OF_SERVICE'],
    INSPECTED: ['VACANT_DIRTY', 'OUT_OF_ORDER', 'OUT_OF_SERVICE'],
    OUT_OF_ORDER: ['VACANT_DIRTY', 'OUT_OF_SERVICE'],
    OUT_OF_SERVICE: ['VACANT_DIRTY', 'OUT_OF_ORDER'],
    OCCUPIED: [],
  };

export function inventoryTransitionAllowed(
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
  /** The ledger line this change writes (through the status trigger) alongside the update. */
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
 * Pure: it takes the current state, the wanted state, who is asking and why,
 * and returns either the update-plus-event pair to write in one transaction or
 * the reason it is refused. The caller writes; this decides. That is what lets
 * the whole matrix be tested without a database and stops a second surface
 * growing its own idea of which moves are legal.
 *
 * `allowed` is the set of statuses this actor may set — the router passes the
 * housekeeping subset for a housekeeper and leaves it undefined for a property
 * administrator, which means "no capability restriction beyond the matrix".
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

  if (!inventoryTransitionAllowed(from, to)) {
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
      message: `You may set ${allowed.map((status) => HOTEL_ROOM_STATUS_LABELS[status].toLowerCase()).join(', ')}. Setting ${HOTEL_ROOM_STATUS_LABELS[to].toLowerCase()} is a property administrator's decision.`,
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

// ---------------------------------------------------------------------------
// Input contracts. Strict objects: a forged `organizationId` or `branchId`
// inside a room-type payload is refused rather than stripped. The router adds
// the property selection by extending these, never by a second parser.
// ---------------------------------------------------------------------------

const id = z.string().trim().min(1).max(191);
const reason = z
  .string()
  .trim()
  .min(1, 'Say why, in a few words. Every inventory change is recorded with its reason.')
  .max(500);
const shortText = z.string().trim().min(1).max(160);
const count = (min: number) => z.number().int().min(min).max(100);
const status = z.enum(HOTEL_INVENTORY_STATUSES);
/** ISO calendar day. Blocks are dated in the property's own days, not instants. */
const date = z.iso.date();

export const hotelRoomTypeCreateInput = z
  .strictObject({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(
        /^[A-Z0-9][A-Z0-9_-]{0,31}$/,
        'Use capitals, numbers, hyphens or underscores: up to 32 characters, starting with a letter or number.'
      ),
    name: shortText,
    nameUr: shortText.optional(),
    inventoryKind: z.enum(HOTEL_INVENTORY_KINDS),
    bedsPerRoom: count(1).optional(),
    description: z.string().trim().max(4000).optional(),
    baseAdults: count(1),
    maxAdults: count(1),
    maxChildren: count(0),
    bedConfig: shortText.optional(),
    amenities: z.array(shortText).max(100).default([]),
    images: z
      .array(z.url({ protocol: /^https$/ }).max(2048))
      .max(20)
      .default([]),
    upgradeRank: z.number().int().min(0).default(0),
    sort: z.number().int().min(0).default(0),
  })
  // The same rules the database CHECKs enforce, restated here so an operator is
  // told which field is wrong instead of being handed a constraint name.
  .refine((value) => value.maxAdults >= value.baseAdults, {
    message: 'The maximum number of adults cannot be below the standard occupancy.',
    path: ['maxAdults'],
  })
  .refine((value) => (value.inventoryKind === 'BED') === (value.bedsPerRoom !== undefined), {
    message:
      'A bed type says how many beds a room of this type holds; a room or unit type does not.',
    path: ['bedsPerRoom'],
  });

export const hotelRoomCreateInput = z.strictObject({
  roomTypeId: id,
  number: z.string().trim().min(1).max(32),
  floor: shortText.optional(),
  features: z.array(shortText).max(100).default([]),
  connectingRoomId: id.optional(),
  genderPolicy: z.enum(HOTEL_GENDER_POLICIES).default('ANY'),
  // HK-01 is "every change attributed"; commissioning a room is its first status.
  reason,
});

export const hotelInventoryIdInput = z.strictObject({ id });
export const hotelInventoryRoomInput = z.strictObject({ roomId: id });

export const hotelInventoryStatusInput = z.strictObject({
  id,
  /** The status the operator was looking at; a change from anything else is a conflict. */
  expectedStatus: status,
  status,
  reason,
});

export const hotelRoomBlockCreateInput = z
  .strictObject({
    roomId: id,
    kind: z.enum(HOTEL_ROOM_BLOCK_KINDS),
    startDate: date,
    endDate: date,
    reason,
    workOrderRef: z.string().trim().min(1).max(191).optional(),
  })
  .refine((value) => value.startDate < value.endDate, {
    message:
      'The block has to end after it starts; the end date is the first day the room is back.',
    path: ['endDate'],
  });

export const hotelRoomBlockReleaseInput = z.strictObject({ id, reason });

export type HotelRoomTypeCreateInput = z.infer<typeof hotelRoomTypeCreateInput>;
export type HotelRoomCreateInput = z.infer<typeof hotelRoomCreateInput>;
export type HotelInventoryStatusInput = z.infer<typeof hotelInventoryStatusInput>;
export type HotelRoomBlockCreateInput = z.infer<typeof hotelRoomBlockCreateInput>;
export type HotelRoomBlockReleaseInput = z.infer<typeof hotelRoomBlockReleaseInput>;

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export class HotelInventoryError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'FORBIDDEN',
    message: string,
    /** The input field the refusal belongs to, when it has one (UX rule 11). */
    readonly field?: string
  ) {
    super(message);
    this.name = 'HotelInventoryError';
  }
}

/**
 * Run `run` inside the caller's tenant transaction with the actor and the
 * reason the status and block triggers read. Call on a tenant client (or on a
 * tenant transaction, which the scoped client reuses); errors must escape the
 * owning transaction so nothing partial is committed. Nothing here sets a
 * branch GUC — the property is a query predicate, never a session fact.
 */
export function withHotelInventory<T>(
  db: PrismaClient,
  scope: HotelInventoryScope,
  changeReason: string,
  run: (tx: PrismaClient) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_user_id', ${scope.actorId}, true),
      set_config('app.hotel_inventory_reason', ${changeReason}, true)`;
    return run(tx as PrismaClient);
  });
}

/** The predicate every inventory query carries: the organization and the property. */
export function inventoryWhere(scope: HotelInventoryScope) {
  return { organizationId: scope.organizationId, branchId: scope.branchId };
}

/**
 * How many sellable units a room of this type adds to the organization's
 * `hotel.rooms.max` count: one for a ROOM or a UNIT, a berth each for a BED
 * room (the limit's counted unit is "rooms, beds and apartments").
 */
export function sellableUnitsOf(roomType: {
  inventoryKind: HotelInventoryKindValue;
  bedsPerRoom: number | null;
}): number {
  return roomType.inventoryKind === 'BED' ? (roomType.bedsPerRoom ?? 0) : 1;
}

/**
 * Create a room (or a dorm room, or a unit) under one of the property's types,
 * provisioning the berths a BED type declares. The room's `inventoryKind` is
 * copied from the type — the kind-pin foreign key refuses anything else — and
 * every lookup is scoped by organization and property, so a type or a
 * connecting room from another property is "not found" rather than linked.
 */
export async function createInventoryRoom(
  db: PrismaClient,
  scope: HotelInventoryScope,
  input: HotelRoomCreateInput
) {
  const where = inventoryWhere(scope);
  const roomType = await db.hotelRoomType.findFirst({ where: { ...where, id: input.roomTypeId } });
  if (!roomType) {
    throw new HotelInventoryError(
      'NOT_FOUND',
      'That room type is not one of this property’s.',
      'roomTypeId'
    );
  }
  if (!roomType.active) {
    throw new HotelInventoryError(
      'BAD_REQUEST',
      `${roomType.name} is retired and takes no new rooms. Choose an active room type.`,
      'roomTypeId'
    );
  }
  if (
    input.connectingRoomId &&
    !(await db.hotelRoom.findFirst({ where: { ...where, id: input.connectingRoomId } }))
  ) {
    throw new HotelInventoryError(
      'NOT_FOUND',
      'The connecting room is not one of this property’s.',
      'connectingRoomId'
    );
  }
  if (input.genderPolicy !== 'ANY' && roomType.inventoryKind !== 'BED') {
    throw new HotelInventoryError(
      'BAD_REQUEST',
      'A dorm policy only applies to a room whose beds are sold separately.',
      'genderPolicy'
    );
  }
  const room = await db.hotelRoom.create({
    data: {
      ...where,
      roomTypeId: roomType.id,
      inventoryKind: roomType.inventoryKind,
      number: input.number,
      floor: input.floor,
      features: input.features,
      connectingRoomId: input.connectingRoomId,
      genderPolicy: input.genderPolicy,
      statusChangedBy: scope.actorId,
    },
  });
  if (roomType.inventoryKind === 'BED') {
    await db.hotelBed.createMany({
      data: Array.from({ length: roomType.bedsPerRoom ?? 0 }, (_, index) => ({
        ...where,
        roomId: room.id,
        label: String(index + 1),
        statusChangedBy: scope.actorId,
      })),
    });
  }
  return db.hotelRoom.findFirstOrThrow({
    where: { ...where, id: room.id },
    include: { beds: { orderBy: { label: 'asc' } } },
  });
}

/**
 * Change one room's or one bed's status, under the transition matrix and the
 * actor's permitted set, from the status the operator was looking at. The
 * conditional update is what makes two simultaneous changes from the same
 * state resolve to exactly one winner; the database trigger then writes the
 * attributed ledger line in the same transaction.
 */
export async function setInventoryStatus(
  db: PrismaClient,
  scope: HotelInventoryScope,
  target: 'room' | 'bed',
  input: HotelInventoryStatusInput,
  allowed?: readonly HotelRoomStatusValue[]
) {
  const plan = planRoomStatusChange({
    from: input.expectedStatus,
    to: input.status,
    actorId: scope.actorId,
    reason: input.reason,
    allowed,
  });
  if (!plan.ok) {
    throw new HotelInventoryError(
      plan.code === 'NOT_PERMITTED' ? 'FORBIDDEN' : 'BAD_REQUEST',
      plan.message,
      'status'
    );
  }
  const where = { ...inventoryWhere(scope), id: input.id };
  const row =
    target === 'room'
      ? await db.hotelRoom.findFirst({ where })
      : await db.hotelBed.findFirst({ where });
  if (!row) {
    throw new HotelInventoryError(
      'NOT_FOUND',
      target === 'room'
        ? 'That room is not one of this property’s.'
        : 'That bed is not one of this property’s.'
    );
  }
  if (row.status !== input.expectedStatus) {
    throw new HotelInventoryError(
      'CONFLICT',
      `This ${target} is now ${HOTEL_ROOM_STATUS_LABELS[row.status].toLowerCase()}, not ${HOTEL_ROOM_STATUS_LABELS[input.expectedStatus].toLowerCase()}. Reload the board and decide again.`
    );
  }
  const args = {
    where: { ...where, status: input.expectedStatus },
    data: { status: input.status },
  };
  const updated =
    target === 'room' ? await db.hotelRoom.updateMany(args) : await db.hotelBed.updateMany(args);
  if (updated.count !== 1) {
    throw new HotelInventoryError(
      'CONFLICT',
      `This ${target}'s status changed a moment ago. Reload the board and decide again.`
    );
  }
  return { id: input.id, status: input.status };
}

/**
 * Open an out-of-order or out-of-service block on one of the property's rooms.
 * Overlap with a live block is refused by the exclusion constraint (23P01), not
 * by a read-then-write check that two requests could both pass.
 */
export async function createInventoryBlock(
  db: PrismaClient,
  scope: HotelInventoryScope,
  input: HotelRoomBlockCreateInput
) {
  const where = inventoryWhere(scope);
  if (!(await db.hotelRoom.findFirst({ where: { ...where, id: input.roomId } }))) {
    throw new HotelInventoryError(
      'NOT_FOUND',
      'That room is not one of this property’s.',
      'roomId'
    );
  }
  return db.hotelRoomBlock.create({
    data: {
      ...where,
      roomId: input.roomId,
      kind: input.kind,
      startDate: calendarDay(input.startDate),
      endDate: calendarDay(input.endDate),
      reason: input.reason,
      workOrderRef: input.workOrderRef,
      createdBy: scope.actorId,
    },
  });
}

/**
 * Release a block. A block already released is returned as it is — a retried
 * release keeps the first actor and reason rather than overwriting them.
 */
export async function releaseInventoryBlock(
  db: PrismaClient,
  scope: HotelInventoryScope,
  input: HotelRoomBlockReleaseInput
) {
  const where = { ...inventoryWhere(scope), id: input.id };
  const block = await db.hotelRoomBlock.findFirst({ where });
  if (!block)
    throw new HotelInventoryError('NOT_FOUND', 'That block is not one of this property’s.');
  if (block.releasedAt) return block;
  const updated = await db.hotelRoomBlock.updateMany({
    where: { ...where, releasedAt: null },
    data: { releasedAt: new Date(), releasedBy: scope.actorId, releaseReason: input.reason },
  });
  if (updated.count !== 1) {
    throw new HotelInventoryError(
      'CONFLICT',
      'This block changed a moment ago. Reload and decide again.'
    );
  }
  return db.hotelRoomBlock.findFirstOrThrow({ where });
}
