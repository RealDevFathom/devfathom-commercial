import { TRPCError } from '@trpc/server';

import {
  canBook,
  rejectClientMoney,
  reservationRequestHash,
  type AvailabilityFacts,
  type ReservationCreateRequest,
} from '@/lib/hotel/reservations';
import type { PricedStay, StayPriceRequest } from './hotel-rate-quote';

export type HotelWriteScope = { organizationId: string; branchId: string };

export const RESERVATION_CREATE_OPERATION = 'reservation.create';

export type ReservationCreated = {
  id: string;
  confirmationNumber: string;
  status: 'HOLD';
  folioId: string;
  folioNumber: string;
};

export type StoredReplay = { requestHash: string; response: unknown };

/** The room type's sellable state and occupancy limits, read under the property lock. */
export type ReservationRoomType = {
  active: boolean;
  maxAdults: number;
  maxChildren: number;
  inventoryKind: 'ROOM' | 'BED' | 'UNIT';
};

/**
 * The persistence port. Every method takes both tenant keys. The caller must
 * run the whole command inside one transaction that holds the property lock
 * (`withLockedProperty`), which is what makes "check availability, then
 * insert" and "look up the key, then record it" atomic per property.
 */
export interface HotelReservationStore {
  findReplay(scope: HotelWriteScope, operation: string, key: string): Promise<StoredReplay | null>;
  roomType(scope: HotelWriteScope, roomTypeId: string): Promise<ReservationRoomType | null>;
  priceStay(scope: HotelWriteScope, request: StayPriceRequest): Promise<PricedStay | null>;
  availability(
    scope: HotelWriteScope,
    arrivalDate: string,
    departureDate: string
  ): Promise<AvailabilityFacts>;
  insertReservation(
    scope: HotelWriteScope,
    actorId: string,
    input: ReservationCreateRequest,
    priced: PricedStay
  ): Promise<ReservationCreated>;
  saveReplay(
    scope: HotelWriteScope,
    operation: string,
    key: string,
    requestHash: string,
    result: ReservationCreated
  ): Promise<void>;
}

/**
 * Create a HOLD reservation with its stay unit and open folio.
 *
 * - The idempotency key is bound to the canonical request hash: an exact
 *   replay returns the stored result without writing, and reuse of the key for
 *   a different request is a CONFLICT without writing.
 * - The party must fit the active room type's occupancy limits. A BED stay
 *   unit is one berth (quantity 1), so it takes one guest.
 * - Money comes only from the server-side rate plan prices.
 * - Availability is re-derived under the property lock; no night may be sold
 *   beyond supply.
 */
export async function createReservation(
  store: HotelReservationStore,
  scope: HotelWriteScope,
  actorId: string,
  input: ReservationCreateRequest
): Promise<ReservationCreated> {
  rejectClientMoney(input as unknown as Record<string, unknown>);
  if (input.branchId !== scope.branchId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'That reservation belongs to another property.',
    });
  }
  const requestHash = reservationRequestHash(input);
  const replay = await store.findReplay(scope, RESERVATION_CREATE_OPERATION, input.idempotencyKey);
  if (replay) {
    if (replay.requestHash !== requestHash) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'That idempotency key was already used for a different reservation.',
      });
    }
    return replay.response as ReservationCreated;
  }

  const roomType = await store.roomType(scope, input.roomTypeId);
  if (!roomType || !roomType.active) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'That room type is not available for booking.',
    });
  }
  if (input.adults > roomType.maxAdults || input.children > roomType.maxChildren) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The party is larger than that room type allows.',
    });
  }
  if (roomType.inventoryKind === 'BED' && input.adults + input.children > 1) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A bed booking holds one guest.' });
  }

  const priced = await store.priceStay(scope, {
    roomTypeId: input.roomTypeId,
    ratePlanId: input.ratePlanId,
    arrivalDate: input.arrivalDate,
    departureDate: input.departureDate,
  });
  if (!priced) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'That rate plan is not available for this room type.',
    });
  }

  const facts = await store.availability(scope, input.arrivalDate, input.departureDate);
  if (!canBook(facts, input.roomTypeId, input.arrivalDate, input.departureDate)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'No room of that type is available for every night of the stay.',
    });
  }

  const created = await store.insertReservation(scope, actorId, input, priced);
  await store.saveReplay(
    scope,
    RESERVATION_CREATE_OPERATION,
    input.idempotencyKey,
    requestHash,
    created
  );
  return created;
}
