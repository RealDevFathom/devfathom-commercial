import { createHash } from 'node:crypto';
import { z } from 'zod';

export const HOTEL_RESERVATION_TRANSITIONS = {
  HOLD: ['CONFIRMED', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['CHECKED_OUT'],
  CHECKED_OUT: [],
  CANCELLED: [],
  NO_SHOW: [],
} as const;
export type ReservationStatus = keyof typeof HOTEL_RESERVATION_TRANSITIONS;

/**
 * The statuses whose stay units consume inventory. A HOLD consumes too: the
 * create command books a HOLD, and a hold that did not consume would let a
 * second booking take the same room before the first is confirmed.
 */
export const INVENTORY_CONSUMING_STATUSES = ['HOLD', 'CONFIRMED', 'CHECKED_IN'] as const;

export const RESERVATION_SOURCES = ['WALK_IN', 'PHONE', 'EMAIL', 'DIRECT'] as const;

export const hotelDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Use a real calendar date.');

/** Stays are half-open `[arrivalDate, departureDate)`: departure must follow arrival. */
export const stayRangeInput = z
  .object({ arrivalDate: hotelDate, departureDate: hotelDate })
  .strict()
  .refine((value) => value.departureDate > value.arrivalDate, {
    path: ['departureDate'],
    message: 'Departure must follow arrival.',
  });

/** The longest stay one create may book; bounds the per-night pricing and availability work. */
export const MAX_STAY_NIGHTS = 60;

const forbiddenMoneyKeys = new Set([
  'nightlyRateMinor',
  'netMinor',
  'taxMinor',
  'totalMinor',
  'grossMinor',
  'balanceMinor',
  'amountMinor',
  'unitMinor',
  'currency',
]);

/** Strict by design: a browser identifies configuration; it never authors money. */
export const reservationCreateInput = z
  .object({
    branchId: z.string().trim().min(1).max(128),
    idempotencyKey: z.string().trim().min(8).max(128),
    source: z.enum(RESERVATION_SOURCES),
    arrivalDate: hotelDate,
    departureDate: hotelDate,
    roomTypeId: z.string().trim().min(1).max(191),
    ratePlanId: z.string().trim().min(1).max(191),
    adults: z.number().int().min(1).max(20),
    children: z.number().int().min(0).max(20).default(0),
    guest: z
      .object({
        firstName: z.string().trim().min(1).max(120),
        lastName: z.string().trim().min(1).max(120),
        email: z.string().trim().email().max(254).optional(),
        phone: z.string().trim().min(3).max(40).optional(),
      })
      .strict(),
    specialRequests: z.string().trim().max(2000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // Refinements can run on a partially invalid object; only compare real dates.
    if (!hotelDate.safeParse(value.arrivalDate).success || !hotelDate.safeParse(value.departureDate).success) {
      return;
    }
    if (value.departureDate <= value.arrivalDate) {
      context.addIssue({
        code: 'custom',
        path: ['departureDate'],
        message: 'Departure must follow arrival.',
      });
    } else if (stayDates(value.arrivalDate, value.departureDate).length > MAX_STAY_NIGHTS) {
      context.addIssue({
        code: 'custom',
        path: ['departureDate'],
        message: `A stay may be at most ${MAX_STAY_NIGHTS} nights.`,
      });
    }
  });
export type ReservationCreateRequest = z.infer<typeof reservationCreateInput>;

/** Defense in depth for non-router callers: refuse any client-authored money key. */
export function rejectClientMoney(input: Record<string, unknown>) {
  for (const key of Object.keys(input)) {
    if (forbiddenMoneyKeys.has(key)) throw new Error(`Client-authored money field is forbidden: ${key}`);
  }
}

/** Every stay night of `[arrival, departure)`, as `YYYY-MM-DD`. */
export function stayDates(arrival: string, departure: string): string[] {
  hotelDate.parse(arrival);
  hotelDate.parse(departure);
  if (departure <= arrival) throw new RangeError('Departure must follow arrival.');
  const dates: string[] = [];
  for (
    let day = new Date(`${arrival}T00:00:00Z`);
    day < new Date(`${departure}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

export function assertTransition(from: ReservationStatus, to: ReservationStatus) {
  if (!(HOTEL_RESERVATION_TRANSITIONS[from] as readonly string[]).includes(to)) {
    throw new Error(`Reservation cannot transition from ${from} to ${to}.`);
  }
}

/**
 * The facts availability is derived from, all already scoped to one property.
 * `units` is what one room sells: 1 for a room or unit, its active berths for a
 * BED room.
 */
export type AvailabilityFacts = {
  rooms: { id: string; roomTypeId: string; units: number }[];
  consuming: { roomTypeId: string; arrivalDate: string; departureDate: string; quantity: number }[];
  blocks: { roomId: string; startDate: string; endDate: string }[];
};

export type AvailabilityNight = {
  date: string;
  roomTypeId: string;
  supply: number;
  demand: number;
  available: number;
};

/** Per night and room type: active unblocked supply minus consuming stay units. */
export function calculateAvailability(
  facts: AvailabilityFacts,
  arrivalDate: string,
  departureDate: string,
  roomTypeIds: readonly string[] = []
): AvailabilityNight[] {
  const dates = stayDates(arrivalDate, departureDate);
  const overlaps = (start: string, end: string, date: string) => start <= date && date < end;
  const types = new Set([...facts.rooms.map((room) => room.roomTypeId), ...roomTypeIds]);
  return dates.flatMap((date) =>
    [...types].sort().map((roomTypeId) => {
      const supply = facts.rooms
        .filter(
          (room) =>
            room.roomTypeId === roomTypeId &&
            !facts.blocks.some(
              (block) => block.roomId === room.id && overlaps(block.startDate, block.endDate, date)
            )
        )
        .reduce((sum, room) => sum + room.units, 0);
      const demand = facts.consuming
        .filter((unit) => unit.roomTypeId === roomTypeId && overlaps(unit.arrivalDate, unit.departureDate, date))
        .reduce((sum, unit) => sum + unit.quantity, 0);
      return { date, roomTypeId, supply, demand, available: Math.max(0, supply - demand) };
    })
  );
}

/** True when one more unit of `roomTypeId` can be sold on every night of the stay. */
export function canBook(
  facts: AvailabilityFacts,
  roomTypeId: string,
  arrivalDate: string,
  departureDate: string
): boolean {
  const nights = calculateAvailability(facts, arrivalDate, departureDate, [roomTypeId]).filter(
    (night) => night.roomTypeId === roomTypeId
  );
  return (
    nights.length === stayDates(arrivalDate, departureDate).length &&
    nights.every((night) => night.available >= 1)
  );
}

/** `RSV-YYYY-NNNNNN`, from the property's locked sequence. */
export function confirmationNumber(year: number, sequence: number): string {
  if (!Number.isInteger(year) || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError('Invalid confirmation sequence.');
  }
  return `RSV-${year}-${String(sequence).padStart(6, '0')}`;
}

/** The reservation's folio number mirrors its confirmation number. */
export function folioNumberFor(confirmation: string): string {
  return confirmation.replace(/^RSV-/, 'FOL-');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)])
    );
  }
  return value;
}

/** SHA-256 of the request with keys sorted, so key order never changes the hash. */
export function reservationRequestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
