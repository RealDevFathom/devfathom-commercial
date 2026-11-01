import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import { recordHotelAudit } from '@/lib/hotel/audit';
import {
  calculateAvailability,
  MAX_STAY_NIGHTS,
  reservationCreateInput,
  stayDates,
  stayRangeInput,
} from '@/lib/hotel/reservations';
import { issueFolioReadGrant, readReservationProjection } from '@/server/hotel-folio-read-service';
import { currentProperty, withLockedProperty } from '@/server/hotel-property-context';
import { hotelPropertySelectionInput } from '@/server/hotel-property-scope';
import { createReservation } from '@/server/hotel-reservation-service';
import {
  createPrismaFolioReadStore,
  createPrismaReservationStore,
  loadAvailabilityFacts,
  type ReservationRow,
} from '@/server/hotel-reservation-store';
import { capabilityProcedure, router } from '../trpc';

const reservations = capabilityProcedure('hotel:reservations');

const scopedId = hotelPropertySelectionInput.extend({ id: z.string().trim().min(1).max(191) }).strict();

/** Guest search is bounded: a real term (no bare wildcard), prefix match, capped rows. */
export const reservationSearchInput = hotelPropertySelectionInput
  .extend({ query: z.string().trim().min(2).max(120) })
  .strict();
export const SEARCH_LIMIT = 25;

export const availabilityInput = hotelPropertySelectionInput
  .extend({ arrivalDate: z.string(), departureDate: z.string() })
  .strict()
  .superRefine((value, context) => {
    const range = stayRangeInput.safeParse({
      arrivalDate: value.arrivalDate,
      departureDate: value.departureDate,
    });
    if (!range.success) {
      context.addIssue({ code: 'custom', path: ['departureDate'], message: 'Choose a valid stay.' });
    } else if (stayDates(value.arrivalDate, value.departureDate).length > MAX_STAY_NIGHTS) {
      context.addIssue({
        code: 'custom',
        path: ['departureDate'],
        message: `Check at most ${MAX_STAY_NIGHTS} nights at a time.`,
      });
    }
  });

/** LIKE metacharacters in user input are literals. */
function likePrefix(term: string): string {
  return `${term.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function actorId(ctx: { session: { user?: { id?: string } } | null }): string {
  const id = ctx.session?.user?.id;
  if (!id) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return id;
}

function badRequestOnRange(error: unknown): never {
  if (error instanceof RangeError) throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  throw error;
}

export const hotelReservationsRouter = router({
  search: reservations.input(reservationSearchInput).query(async ({ ctx, input }) => {
    const property = await currentProperty(ctx, input.branchId, 'hotel:reservations');
    const term = likePrefix(input.query);
    return ctx.db.$queryRaw<
      Pick<ReservationRow, 'id' | 'confirmationNumber' | 'status' | 'arrivalDate' | 'departureDate' | 'firstName' | 'lastName'>[]
    >(Prisma.sql`
      SELECT r.id, r."confirmationNumber", r.status::text AS status, r."arrivalDate", r."departureDate",
        g."firstName", g."lastName"
      FROM hotel_reservations r
      JOIN hotel_guests g
        ON g."organizationId" = r."organizationId" AND g."branchId" = r."branchId" AND g.id = r."primaryGuestId"
      WHERE r."organizationId" = ${ctx.entitlements.organizationId}
        AND r."branchId" = ${property.branchId}
        AND (r."confirmationNumber" ILIKE ${term} ESCAPE '\\' OR g."lastName" ILIKE ${term} ESCAPE '\\')
      ORDER BY r."arrivalDate", r.id
      LIMIT ${SEARCH_LIMIT}`);
  }),

  /** Folio-free: no `hotel:folio` grant is issued here, so the read service never loads it. */
  get: reservations.input(scopedId).query(async ({ ctx, input }) => {
    const property = await currentProperty(ctx, input.branchId, 'hotel:reservations');
    const scope = { organizationId: ctx.entitlements.organizationId, branchId: property.branchId };
    return readReservationProjection(createPrismaFolioReadStore(ctx.db), scope, input.id);
  }),

  /**
   * The projection carries guest identity and stay dates, so it is gated on
   * `hotel:reservations` like every other guest read; the folio grant is then
   * issued only after `hotel:folio` is also verified for this property. A role
   * with folio access alone (e.g. housekeeping supervision) gets neither.
   */
  getWithFolio: reservations.input(scopedId).query(async ({ ctx, input }) => {
    await currentProperty(ctx, input.branchId, 'hotel:reservations');
    const property = await currentProperty(ctx, input.branchId, 'hotel:folio');
    const scope = { organizationId: ctx.entitlements.organizationId, branchId: property.branchId };
    return readReservationProjection(
      createPrismaFolioReadStore(ctx.db),
      scope,
      input.id,
      issueFolioReadGrant(scope, new Set(['hotel:folio']))
    );
  }),

  availability: reservations.input(availabilityInput).query(async ({ ctx, input }) => {
    const property = await currentProperty(ctx, input.branchId, 'hotel:reservations');
    const scope = { organizationId: ctx.entitlements.organizationId, branchId: property.branchId };
    const roomTypes = await ctx.db.hotelRoomType.findMany({
      where: { organizationId: scope.organizationId, branchId: scope.branchId, active: true },
      select: { id: true },
    });
    const facts = await loadAvailabilityFacts(ctx.db, scope, input.arrivalDate, input.departureDate);
    return calculateAvailability(
      facts,
      input.arrivalDate,
      input.departureDate,
      roomTypes.map((type) => type.id)
    );
  }),

  create: reservations.input(reservationCreateInput).mutation(({ ctx, input }) => {
    const actor = actorId(ctx);
    return withLockedProperty(
      ctx,
      input.branchId,
      async (tx, property) => {
        const scope = { organizationId: tx.entitlements.organizationId, branchId: property.branchId };
        const created = await createReservation(
          createPrismaReservationStore(tx.db),
          scope,
          actor,
          input
        ).catch(badRequestOnRange);
        recordHotelAudit(ctx, {
          entity: { type: 'HotelReservation', id: created.id, label: created.confirmationNumber },
          action: 'hotel.reservation.create',
          operation: 'CREATE',
          after: {
            confirmationNumber: created.confirmationNumber,
            status: created.status,
            folioNumber: created.folioNumber,
            roomTypeId: input.roomTypeId,
            ratePlanId: input.ratePlanId,
            arrivalDate: input.arrivalDate,
            departureDate: input.departureDate,
            source: input.source,
          },
          metadata: { branchId: property.branchId },
        });
        return created;
      },
      'hotel:reservations'
    );
  }),
});
