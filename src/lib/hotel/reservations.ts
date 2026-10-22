import { createHash } from 'node:crypto';

import { z } from 'zod';

export const hotelDate = z.coerce.date().refine(
  (date) => date.getUTCHours() === 0 && date.getUTCMinutes() === 0,
  'Use a hotel-local calendar date.'
);

export const stayRangeInput = z
  .object({ arrivalDate: hotelDate, departureDate: hotelDate })
  .refine(({ arrivalDate, departureDate }) => departureDate > arrivalDate, {
    path: ['departureDate'],
    message: 'Departure must be after arrival.',
  });

export type AvailabilityRoom = {
  id: string;
  roomTypeId: string;
  number: string;
  status: string;
  blocks: readonly unknown[];
  assignments: readonly unknown[];
};

export type AvailabilityType = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  rooms: readonly AvailabilityRoom[];
  stayUnits: readonly { quantity: number }[];
};

/** One canonical projection powers reservation availability and the calendar. */
export function summarizeAvailability(roomTypes: readonly AvailabilityType[]) {
  return roomTypes.map((roomType) => {
    const physical = roomType.rooms.filter((room) => room.status !== 'RETIRED');
    const blocked = physical.filter((room) => room.blocks.length > 0).length;
    const assignedRoomIds = new Set(
      physical.filter((room) => room.assignments.length > 0).map((room) => room.id)
    );
    const sold = roomType.stayUnits.reduce((total, unit) => total + unit.quantity, 0);
    const supply = physical.length - blocked;
    return {
      roomTypeId: roomType.id,
      code: roomType.code,
      name: roomType.name,
      supply,
      sold,
      available: Math.max(0, supply - sold),
      assignableRooms: physical
        .filter(
          (room) =>
            room.blocks.length === 0 &&
            !assignedRoomIds.has(room.id) &&
            ['VACANT_CLEAN', 'INSPECTED'].includes(room.status)
        )
        .map(({ id, number, status }) => ({ id, number, status })),
    };
  });
}

/** Stable object hashing for property-scoped idempotency records. */
export function reservationRequestHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)])
      );
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function confirmationNumber(year: number, sequence: number): string {
  return `RSV-${year}-${String(sequence).padStart(6, '0')}`;
}
