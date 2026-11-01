import 'server-only';

import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { calculateFolioBalance } from '@/lib/hotel/folios';
import type { FolioEvidence } from '@/lib/hotel/folio-security';
import {
  confirmationNumber,
  folioNumberFor,
  INVENTORY_CONSUMING_STATUSES,
  type AvailabilityFacts,
} from '@/lib/hotel/reservations';
import type { FolioReadScope, HotelFolioReadStore } from './hotel-folio-read-service';
import { priceStay, type RateQuoteDb } from './hotel-rate-quote';
import type { HotelReservationStore, ReservationCreated } from './hotel-reservation-service';

export type ReservationDb = RateQuoteDb;

export type ReservationRow = {
  id: string;
  confirmationNumber: string;
  status: string;
  source: string;
  arrivalDate: Date;
  departureDate: Date;
  adults: number;
  children: number;
  currency: string;
  version: number;
  firstName: string;
  lastName: string;
};

const dateOnly = (value: Date) => value.toISOString().slice(0, 10);
const consuming = Prisma.join(INVENTORY_CONSUMING_STATUSES.map((status) => Prisma.sql`${status}`));

/** Room supply, consuming stay units and live blocks overlapping `[arrival, departure)`. */
export async function loadAvailabilityFacts(
  db: ReservationDb,
  scope: FolioReadScope,
  arrivalDate: string,
  departureDate: string
): Promise<AvailabilityFacts> {
  // Sequential on purpose: inside a transaction every query shares one connection.
  const rooms = await db.$queryRaw<{ id: string; roomTypeId: string; units: number }[]>(Prisma.sql`
      SELECT r.id, r."roomTypeId",
        CASE WHEN r."inventoryKind" = 'BED' THEN (
          SELECT count(*)::int FROM hotel_beds b
          WHERE b."organizationId" = r."organizationId" AND b."branchId" = r."branchId"
            AND b."roomId" = r.id AND b.active = true
        ) ELSE 1 END AS units
      FROM hotel_rooms r
      WHERE r."organizationId" = ${scope.organizationId}
        AND r."branchId" = ${scope.branchId}
        AND r.active = true`);
  const units = await db.$queryRaw<{ roomTypeId: string; arrivalDate: Date; departureDate: Date; quantity: number }[]>(Prisma.sql`
      SELECT s."roomTypeId", s."arrivalDate", s."departureDate", s.quantity
      FROM hotel_reservation_stay_units s
      JOIN hotel_reservations r
        ON r."organizationId" = s."organizationId" AND r."branchId" = s."branchId" AND r.id = s."reservationId"
      WHERE s."organizationId" = ${scope.organizationId}
        AND s."branchId" = ${scope.branchId}
        AND r.status::text IN (${consuming})
        AND s."arrivalDate" < ${departureDate}::date
        AND s."departureDate" > ${arrivalDate}::date`);
  const blocks = await db.$queryRaw<{ roomId: string; startDate: Date; endDate: Date }[]>(Prisma.sql`
      SELECT "roomId", "startDate", "endDate"
      FROM hotel_room_blocks
      WHERE "organizationId" = ${scope.organizationId}
        AND "branchId" = ${scope.branchId}
        AND "releasedAt" IS NULL
        AND "startDate" < ${departureDate}::date
        AND "endDate" > ${arrivalDate}::date`);
  return {
    rooms: rooms.map((room) => ({ ...room, units: Number(room.units) })),
    consuming: units.map((unit) => ({
      roomTypeId: unit.roomTypeId,
      quantity: Number(unit.quantity),
      arrivalDate: dateOnly(unit.arrivalDate),
      departureDate: dateOnly(unit.departureDate),
    })),
    blocks: blocks.map((block) => ({
      roomId: block.roomId,
      startDate: dateOnly(block.startDate),
      endDate: dateOnly(block.endDate),
    })),
  };
}

/** One reservation's folio-free projection (with the primary guest's name). */
export async function readReservationRow(
  db: ReservationDb,
  scope: FolioReadScope,
  id: string
): Promise<ReservationRow | null> {
  const rows = await db.$queryRaw<ReservationRow[]>(Prisma.sql`
    SELECT r.id, r."confirmationNumber", r.status::text AS status, r.source::text AS source,
      r."arrivalDate", r."departureDate", r.adults, r.children, r.currency, r.version,
      g."firstName", g."lastName"
    FROM hotel_reservations r
    JOIN hotel_guests g
      ON g."organizationId" = r."organizationId" AND g."branchId" = r."branchId" AND g.id = r."primaryGuestId"
    WHERE r."organizationId" = ${scope.organizationId}
      AND r."branchId" = ${scope.branchId}
      AND r.id = ${id}`);
  return rows[0] ?? null;
}

/** The reservation's folio with its balance: entries net of reversals, net of payments. */
export async function readFolioEvidence(
  db: ReservationDb,
  scope: FolioReadScope,
  reservationId: string
): Promise<FolioEvidence | null> {
  const folios = await db.$queryRaw<{ id: string; folioNumber: string; status: string; currency: string }[]>(
    Prisma.sql`
      SELECT id, "folioNumber", status::text AS status, currency
      FROM hotel_folios
      WHERE "organizationId" = ${scope.organizationId}
        AND "branchId" = ${scope.branchId}
        AND "reservationId" = ${reservationId}`
  );
  const folio = folios[0];
  if (!folio) return null;
  const entries = await db.$queryRaw<{ grossMinor: bigint; currency: string; reversesEntryId: string | null }[]>(Prisma.sql`
      SELECT "grossMinor", currency, "reversesEntryId"
      FROM hotel_folio_entries
      WHERE "organizationId" = ${scope.organizationId}
        AND "branchId" = ${scope.branchId}
        AND "folioId" = ${folio.id}`);
  const payments = await db.$queryRaw<{ amountMinor: bigint; currency: string; direction: 'COLLECTION' | 'REFUND' }[]>(Prisma.sql`
      SELECT "amountMinor", currency, direction::text AS direction
      FROM hotel_folio_payments
      WHERE "organizationId" = ${scope.organizationId}
        AND "branchId" = ${scope.branchId}
        AND "folioId" = ${folio.id}`);
  return { ...folio, balanceMinor: calculateFolioBalance(folio.currency, entries, payments) };
}

export function createPrismaFolioReadStore(db: ReservationDb): HotelFolioReadStore {
  return {
    readReservation: (scope, id) => readReservationRow(db, scope, id),
    readFolio: (scope, reservationId) => readFolioEvidence(db, scope, reservationId),
  };
}

/** Must be given the transaction client of a `withLockedProperty` callback. */
export function createPrismaReservationStore(db: ReservationDb): HotelReservationStore {
  return {
    async findReplay(scope, operation, key) {
      const rows = await db.$queryRaw<{ requestHash: string; response: unknown }[]>(Prisma.sql`
        SELECT "requestHash", response
        FROM hotel_operation_idempotency_keys
        WHERE "organizationId" = ${scope.organizationId}
          AND "branchId" = ${scope.branchId}
          AND scope = ${operation}
          AND key = ${key}`);
      return rows[0] ?? null;
    },

    priceStay: (scope, request) => priceStay(db, scope, request, { lock: true }),

    availability: (scope, arrivalDate, departureDate) =>
      loadAvailabilityFacts(db, scope, arrivalDate, departureDate),

    async insertReservation(scope, actorId, input, priced) {
      const sequence = await db.$queryRaw<{ n: number }[]>(Prisma.sql`
        INSERT INTO hotel_confirmation_sequences (id, "organizationId", "branchId", "nextNumber")
        VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, 2)
        ON CONFLICT ("organizationId", "branchId")
        DO UPDATE SET "nextNumber" = hotel_confirmation_sequences."nextNumber" + 1,
                      "updatedAt" = CURRENT_TIMESTAMP
        RETURNING "nextNumber" - 1 AS n`);
      const confirmation = confirmationNumber(
        Number(input.arrivalDate.slice(0, 4)),
        Number(sequence[0].n)
      );
      const folioNumber = folioNumberFor(confirmation);
      const guestId = randomUUID();
      const reservationId = randomUUID();
      const folioId = randomUUID();
      const nightlyRates = priced.nights.map((night) => ({
        date: night.date,
        netMinor: night.netMinor.toString(),
        taxMinor: night.taxMinor.toString(),
        totalMinor: night.totalMinor.toString(),
      }));

      await db.$queryRaw(Prisma.sql`
        INSERT INTO hotel_guests (id, "organizationId", "branchId", "firstName", "lastName", email, phone)
        VALUES (${guestId}, ${scope.organizationId}, ${scope.branchId}, ${input.guest.firstName},
          ${input.guest.lastName}, ${input.guest.email ?? null}, ${input.guest.phone ?? null})
        RETURNING id`);
      await db.$queryRaw(Prisma.sql`
        INSERT INTO hotel_reservations
          (id, "organizationId", "branchId", "confirmationNumber", status, source, "primaryGuestId",
           "arrivalDate", "departureDate", adults, children, "specialRequests", currency, "createdById")
        VALUES (${reservationId}, ${scope.organizationId}, ${scope.branchId}, ${confirmation},
          'HOLD'::"HotelReservationStatus", ${input.source}::"HotelReservationSource", ${guestId},
          ${input.arrivalDate}::date, ${input.departureDate}::date, ${input.adults}, ${input.children},
          ${input.specialRequests ?? null}, ${priced.currency}, ${actorId})
        RETURNING id`);
      await db.$queryRaw(Prisma.sql`
        INSERT INTO hotel_reservation_stay_units
          (id, "organizationId", "branchId", "reservationId", "roomTypeId", "ratePlanId", quantity,
           adults, children, "arrivalDate", "departureDate", "netMinor", "taxMinor", "totalMinor",
           "taxBasisPoints", "nightlyRates", currency)
        VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${reservationId},
          ${priced.roomTypeId}, ${priced.ratePlanId}, 1, ${input.adults}, ${input.children},
          ${input.arrivalDate}::date, ${input.departureDate}::date, ${priced.netMinor},
          ${priced.taxMinor}, ${priced.totalMinor}, ${priced.taxBasisPoints},
          ${JSON.stringify(nightlyRates)}::jsonb, ${priced.currency})
        RETURNING id`);
      await db.$queryRaw(Prisma.sql`
        INSERT INTO hotel_folios (id, "organizationId", "branchId", "reservationId", "folioNumber", currency)
        VALUES (${folioId}, ${scope.organizationId}, ${scope.branchId}, ${reservationId}, ${folioNumber},
          ${priced.currency})
        RETURNING id`);

      return { id: reservationId, confirmationNumber: confirmation, status: 'HOLD', folioId, folioNumber };
    },

    async saveReplay(scope, operation, key, requestHash, result: ReservationCreated) {
      await db.$queryRaw(Prisma.sql`
        INSERT INTO hotel_operation_idempotency_keys
          (id, "organizationId", "branchId", scope, key, "requestHash", "resultType", "resultId", response)
        VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${operation}, ${key},
          ${requestHash}, 'HotelReservation', ${result.id}, ${JSON.stringify(result)}::jsonb)
        RETURNING id`);
    },
  };
}
