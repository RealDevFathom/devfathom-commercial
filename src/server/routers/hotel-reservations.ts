import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import { recordHotelAudit } from '@/lib/hotel/audit';
import { hasModule } from '@/lib/entitlements';
import {
  confirmationNumber,
  reservationRequestHash,
  stayRangeInput,
  summarizeAvailability,
} from '@/lib/hotel/reservations';
import { currentProperty, hasSqlState, withLockedProperty } from '@/server/hotel-property-context';
import { hotelPropertySelectionInput } from '@/server/hotel-property-scope';
import { capabilityProcedure, router } from '../trpc';
import type { TRPCContext } from '../trpc';

const reservations = capabilityProcedure('hotel:reservations');
const frontDesk = capabilityProcedure('hotel:front-desk');
const consumingStatuses = ['CONFIRMED', 'CHECKED_IN'] as const;
const activeAssignments = ['HELD', 'ACTIVE'] as const;

const selectionAndRange = stayRangeInput.safeExtend(hotelPropertySelectionInput.shape);
const idInput = hotelPropertySelectionInput.extend({ reservationId: z.string().min(1) });
const idempotencyKey = z.string().trim().min(8).max(128);
const reason = z.string().trim().min(3).max(500);

function requireModule(ctx: { entitlements: Parameters<typeof hasModule>[0] }) {
  if (!hasModule(ctx.entitlements, 'hotel-reservations'))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Reservations are not enabled.' });
}

function actorId(ctx: { session: { user?: { id?: string } } | null }): string {
  const id = ctx.session?.user?.id;
  if (!id) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return id;
}

async function availability(db: Prisma.TransactionClient, organizationId: string, branchId: string, arrivalDate: Date, departureDate: Date, excludingReservationId?: string) {
  const roomTypes = await db.hotelRoomType.findMany({
    where: { organizationId, branchId, active: true },
    orderBy: [{ sort: 'asc' }, { code: 'asc' }],
    select: {
      id: true, code: true, name: true, active: true,
      rooms: {
        where: { organizationId, branchId, active: true },
        orderBy: [{ number: 'asc' }],
        select: {
          id: true, roomTypeId: true, number: true, status: true,
          blocks: { where: { releasedAt: null, startDate: { lt: departureDate }, endDate: { gt: arrivalDate } }, select: { id: true } },
          assignments: { where: { status: { in: [...activeAssignments] }, startDate: { lt: departureDate }, endDate: { gt: arrivalDate } }, select: { id: true } },
        },
      },
      stayUnits: {
        where: {
          arrivalDate: { lt: departureDate }, departureDate: { gt: arrivalDate },
          reservation: { status: { in: [...consumingStatuses] }, ...(excludingReservationId ? { id: { not: excludingReservationId } } : {}) },
        },
        select: { quantity: true },
      },
    },
  });
  return summarizeAvailability(roomTypes);
}

async function requireCapacity(db: Prisma.TransactionClient, organizationId: string, branchId: string, roomTypeId: string, arrivalDate: Date, departureDate: Date, excludingReservationId?: string) {
  const row = (await availability(db, organizationId, branchId, arrivalDate, departureDate, excludingReservationId)).find((entry) => entry.roomTypeId === roomTypeId);
  if (!row) throw new TRPCError({ code: 'BAD_REQUEST', message: 'That room type is not available at this property.' });
  if (row.available < 1) throw new TRPCError({ code: 'CONFLICT', message: 'No inventory remains for that room type and stay.' });
  return row;
}

const guestInput = z.object({
  id: z.string().min(1).optional(), firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(320).optional(), phone: z.string().trim().min(3).max(40).optional(), countryCode: z.string().trim().length(2).optional(), notes: z.string().trim().max(2000).optional(),
});
const stayInput = z.object({ roomTypeId: z.string().min(1), mealPlanId: z.string().min(1).optional(), adults: z.number().int().min(1).max(20), children: z.number().int().min(0).max(20), nightlyRateMinor: z.number().int().min(0), taxMinorPerNight: z.number().int().min(0).default(0) });

const createInput = selectionAndRange.extend({
  idempotencyKey, status: z.enum(['HOLD', 'CONFIRMED']).default('CONFIRMED'), source: z.enum(['WALK_IN', 'PHONE', 'EMAIL', 'DIRECT']),
  guest: guestInput, stay: stayInput, specialRequests: z.string().trim().max(4000).optional(),
});

function mapConflict(error: unknown): never {
  if (hasSqlState(error, '23P01')) throw new TRPCError({ code: 'CONFLICT', message: 'That room is already assigned for part of this stay.' });
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new TRPCError({ code: 'CONFLICT', message: 'This operation was completed concurrently. Reload and try again.' });
  throw error;
}

export const hotelReservationsRouter = router({
  search: reservations.input(hotelPropertySelectionInput.extend({
    query: z.string().trim().max(200).optional(), status: z.enum(['HOLD', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW']).optional(),
    from: z.coerce.date().optional(), to: z.coerce.date().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(30),
  })).query(async ({ ctx, input }) => {
    requireModule(ctx); const property = await currentProperty(ctx, input.branchId, 'hotel:reservations');
    const rows = await ctx.db.hotelReservation.findMany({ where: { organizationId: ctx.entitlements.organizationId, branchId: property.branchId,
      ...(input.status ? { status: input.status } : {}), ...(input.from ? { departureDate: { gt: input.from } } : {}), ...(input.to ? { arrivalDate: { lt: input.to } } : {}),
      ...(input.query ? { OR: [{ confirmationNumber: { contains: input.query, mode: 'insensitive' } }, { primaryGuest: { OR: [{ firstName: { contains: input.query, mode: 'insensitive' } }, { lastName: { contains: input.query, mode: 'insensitive' } }, { email: { contains: input.query, mode: 'insensitive' } }] } }] } : {}) },
      orderBy: [{ arrivalDate: 'desc' }, { id: 'desc' }], take: input.limit + 1, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}), include: { primaryGuest: true, stayUnits: { include: { roomType: true, assignments: { where: { status: { in: [...activeAssignments] } }, include: { room: true } } } }, folio: { select: { id: true, status: true, version: true } } } });
    const nextCursor = rows.length > input.limit ? rows.pop()!.id : undefined; return { reservations: rows, nextCursor };
  }),

  availability: reservations.input(selectionAndRange).query(async ({ ctx, input }) => {
    requireModule(ctx); const property = await currentProperty(ctx, input.branchId, 'hotel:reservations');
    return { arrivalDate: input.arrivalDate, departureDate: input.departureDate, roomTypes: await availability(ctx.db, ctx.entitlements.organizationId, property.branchId, input.arrivalDate, input.departureDate) };
  }),

  get: reservations.input(idInput).query(async ({ ctx, input }) => {
    requireModule(ctx); const property = await currentProperty(ctx, input.branchId, 'hotel:reservations');
    const reservation = await ctx.db.hotelReservation.findFirst({ where: { id: input.reservationId, organizationId: ctx.entitlements.organizationId, branchId: property.branchId }, include: { primaryGuest: true, stayUnits: { include: { roomType: true, mealPlan: true, assignments: { orderBy: { assignedAt: 'desc' }, include: { room: true, bed: true } } } }, events: { orderBy: { occurredAt: 'asc' } }, folio: { include: { postings: true, payments: true } } } });
    if (!reservation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Reservation not found.' }); return { reservation };
  }),

  create: reservations.input(createInput).mutation(({ ctx, input }) => {
    requireModule(ctx); const hash = reservationRequestHash(input); const userId = actorId(ctx);
    return withLockedProperty(ctx, input.branchId, async (locked, property) => {
      const organizationId = locked.entitlements.organizationId;
      const replay = await locked.db.hotelOperationIdempotencyKey.findUnique({ where: { organizationId_branchId_scope_key: { organizationId, branchId: property.branchId, scope: 'reservation.create', key: input.idempotencyKey } } });
      if (replay) { if (replay.requestHash !== hash) throw new TRPCError({ code: 'CONFLICT', message: 'That idempotency key was already used for a different request.' }); return replay.response as { reservationId: string; confirmationNumber: string; folioId: string }; }
      if (input.status === 'CONFIRMED') await requireCapacity(locked.db, organizationId, property.branchId, input.stay.roomTypeId, input.arrivalDate, input.departureDate);
      const guest = input.guest.id
        ? await locked.db.hotelGuest.update({ where: { organizationId_id: { organizationId, id: input.guest.id } }, data: { firstName: input.guest.firstName, lastName: input.guest.lastName, email: input.guest.email?.toLowerCase(), phone: input.guest.phone, countryCode: input.guest.countryCode?.toUpperCase(), notes: input.guest.notes } })
        : await locked.db.hotelGuest.create({ data: { organizationId, branchId: property.branchId, firstName: input.guest.firstName, lastName: input.guest.lastName, email: input.guest.email?.toLowerCase(), phone: input.guest.phone, countryCode: input.guest.countryCode?.toUpperCase(), notes: input.guest.notes } });
      if (guest.branchId !== property.branchId) throw new TRPCError({ code: 'NOT_FOUND', message: 'Guest not found.' });
      const sequence = await locked.db.hotelConfirmationNumberSequence.upsert({ where: { organizationId_branchId: { organizationId, branchId: property.branchId } }, create: { organizationId, branchId: property.branchId, nextNumber: 2 }, update: { nextNumber: { increment: 1 } } });
      const number = confirmationNumber(property.businessDate.getUTCFullYear(), sequence.nextNumber - 1);
      const reservation = await locked.db.hotelReservation.create({ data: { organizationId, branchId: property.branchId, confirmationNumber: number, status: input.status, source: input.source, primaryGuestId: guest.id, arrivalDate: input.arrivalDate, departureDate: input.departureDate, adults: input.stay.adults, children: input.stay.children, specialRequests: input.specialRequests, currency: property.currency,
        stayUnits: { create: { organizationId, branchId: property.branchId, roomTypeId: input.stay.roomTypeId, mealPlanId: input.stay.mealPlanId, quantity: 1, adults: input.stay.adults, children: input.stay.children, nightlyRateMinor: input.stay.nightlyRateMinor, taxMinorPerNight: input.stay.taxMinorPerNight, currency: property.currency, arrivalDate: input.arrivalDate, departureDate: input.departureDate } },
        events: { create: { organizationId, branchId: property.branchId, kind: 'CREATED', toStatus: input.status, actorId: userId, metadata: {} } },
        folio: { create: { organizationId, branchId: property.branchId, folioNumber: `FOL-${number.slice(4)}`, guestId: guest.id, currency: property.currency } } }, include: { folio: { select: { id: true } } } });
      const response = { reservationId: reservation.id, confirmationNumber: number, folioId: reservation.folio!.id };
      await locked.db.hotelOperationIdempotencyKey.create({ data: { organizationId, branchId: property.branchId, scope: 'reservation.create', key: input.idempotencyKey, requestHash: hash, resultType: 'HotelReservation', resultId: reservation.id, response } });
      recordHotelAudit(locked, { entity: { type: 'HotelReservation', id: reservation.id, label: number }, action: 'hotel.reservation.create', operation: 'CREATE', after: { status: input.status, arrivalDate: input.arrivalDate, departureDate: input.departureDate }, metadata: { branchId: property.branchId } }); return response;
    }, 'hotel:reservations');
  }),

  confirm: reservations.input(idInput.extend({ idempotencyKey, expectedVersion: z.number().int().positive() })).mutation(({ ctx, input }) => {
    requireModule(ctx); const userId = actorId(ctx); return withLockedProperty(ctx, input.branchId, async (locked, property) => {
      const org = locked.entitlements.organizationId; const hash = reservationRequestHash(input);
      const replay = await locked.db.hotelOperationIdempotencyKey.findUnique({ where: { organizationId_branchId_scope_key: { organizationId: org, branchId: property.branchId, scope: 'reservation.confirm', key: input.idempotencyKey } } });
      if (replay) { if (replay.requestHash !== hash) throw new TRPCError({ code: 'CONFLICT', message: 'That idempotency key was already used for a different request.' }); return replay.response as { reservationId: string; status: 'CONFIRMED'; version: number }; }
      const reservation = await locked.db.hotelReservation.findFirst({ where: { id: input.reservationId, organizationId: org, branchId: property.branchId }, include: { stayUnits: true } });
      if (!reservation) throw new TRPCError({ code: 'NOT_FOUND' }); if (reservation.status !== 'HOLD' || reservation.version !== input.expectedVersion) throw new TRPCError({ code: 'CONFLICT', message: 'Reservation changed or cannot be confirmed.' });
      for (const unit of reservation.stayUnits) await requireCapacity(locked.db, org, property.branchId, unit.roomTypeId, unit.arrivalDate, unit.departureDate, reservation.id);
      const updated = await locked.db.hotelReservation.update({ where: { id: reservation.id }, data: { status: 'CONFIRMED', version: { increment: 1 }, events: { create: { organizationId: org, branchId: property.branchId, kind: 'CONFIRMED', fromStatus: 'HOLD', toStatus: 'CONFIRMED', actorId: userId, metadata: {} } } } });
      const response = { reservationId: updated.id, status: 'CONFIRMED' as const, version: updated.version };
      await locked.db.hotelOperationIdempotencyKey.create({ data: { organizationId: org, branchId: property.branchId, scope: 'reservation.confirm', key: input.idempotencyKey, requestHash: hash, resultType: 'HotelReservation', resultId: updated.id, response } });
      recordHotelAudit(locked, { entity: { type: 'HotelReservation', id: updated.id }, action: 'hotel.reservation.confirm', before: { status: 'HOLD' }, after: { status: 'CONFIRMED' }, metadata: { branchId: property.branchId } }); return response;
    }, 'hotel:reservations');
  }),

  updateStay: reservations.input(idInput.extend({ expectedVersion: z.number().int().positive(), ...stayRangeInput.shape, stay: stayInput })).mutation(({ ctx, input }) => {
    requireModule(ctx); const userId = actorId(ctx); return withLockedProperty(ctx, input.branchId, async (locked, property) => {
      const org = locked.entitlements.organizationId; const reservation = await locked.db.hotelReservation.findFirst({ where: { id: input.reservationId, organizationId: org, branchId: property.branchId }, include: { stayUnits: true } });
      if (!reservation || !['HOLD', 'CONFIRMED'].includes(reservation.status) || reservation.version !== input.expectedVersion) throw new TRPCError({ code: 'CONFLICT', message: 'Reservation changed or its stay can no longer be edited.' });
      if (reservation.stayUnits.length !== 1) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This operation supports one stay unit.' });
      if (reservation.status === 'CONFIRMED') await requireCapacity(locked.db, org, property.branchId, input.stay.roomTypeId, input.arrivalDate, input.departureDate, reservation.id);
      await locked.db.hotelReservationStayUnit.update({ where: { organizationId_id: { organizationId: org, id: reservation.stayUnits[0].id } }, data: { ...input.stay, arrivalDate: input.arrivalDate, departureDate: input.departureDate, currency: property.currency } });
      const updated = await locked.db.hotelReservation.update({ where: { id: reservation.id }, data: { arrivalDate: input.arrivalDate, departureDate: input.departureDate, adults: input.stay.adults, children: input.stay.children, version: { increment: 1 }, events: { create: { organizationId: org, branchId: property.branchId, kind: 'NOTE_ADDED', fromStatus: reservation.status, toStatus: reservation.status, actorId: userId, reason: 'Stay updated', metadata: {} } } } });
      recordHotelAudit(locked, { entity: { type: 'HotelReservation', id: updated.id }, action: 'hotel.reservation.stay.update', metadata: { branchId: property.branchId } }); return { reservation: updated };
    }, 'hotel:reservations');
  }),

  assignRoom: frontDesk.input(idInput.extend({ roomId: z.string().min(1), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(3).max(500).optional() })).mutation(({ ctx, input }) => {
    requireModule(ctx); const userId = actorId(ctx); return withLockedProperty(ctx, input.branchId, async (locked, property) => { try {
      const org = locked.entitlements.organizationId; const reservation = await locked.db.hotelReservation.findFirst({ where: { id: input.reservationId, organizationId: org, branchId: property.branchId }, include: { stayUnits: { include: { assignments: { where: { status: { in: [...activeAssignments] } } } } } } });
      if (!reservation || !['HOLD', 'CONFIRMED'].includes(reservation.status) || reservation.version !== input.expectedVersion) throw new TRPCError({ code: 'CONFLICT', message: 'Reservation changed or cannot be assigned.' }); const unit = reservation.stayUnits[0];
      const room = await locked.db.hotelRoom.findFirst({ where: { id: input.roomId, organizationId: org, branchId: property.branchId, roomTypeId: unit.roomTypeId, active: true, blocks: { none: { releasedAt: null, startDate: { lt: unit.departureDate }, endDate: { gt: unit.arrivalDate } } }, assignments: { none: { status: { in: [...activeAssignments] }, startDate: { lt: unit.departureDate }, endDate: { gt: unit.arrivalDate }, stayUnitId: { not: unit.id } } } } });
      if (!room) throw new TRPCError({ code: 'CONFLICT', message: 'That room is unavailable or is not of the booked type.' });
      await locked.db.hotelRoomAssignment.updateMany({ where: { organizationId: org, branchId: property.branchId, stayUnitId: unit.id, status: { in: [...activeAssignments] } }, data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: input.reason ?? 'Room changed' } });
      const assignment = await locked.db.hotelRoomAssignment.create({ data: { organizationId: org, branchId: property.branchId, stayUnitId: unit.id, roomId: room.id, startDate: unit.arrivalDate, endDate: unit.departureDate, status: 'HELD', assignedById: userId } });
      await locked.db.hotelReservation.update({ where: { id: reservation.id }, data: { version: { increment: 1 }, events: { create: { organizationId: org, branchId: property.branchId, kind: unit.assignments.length ? 'ROOM_CHANGED' : 'ROOM_ASSIGNED', fromStatus: reservation.status, toStatus: reservation.status, actorId: userId, reason: input.reason, metadata: { roomId: room.id } } } } });
      recordHotelAudit(locked, { entity: { type: 'HotelRoomAssignment', id: assignment.id }, action: 'hotel.reservation.room.assign', operation: 'CREATE', metadata: { branchId: property.branchId, reservationId: reservation.id } }); return { assignment };
    } catch (error) { mapConflict(error); } }, 'hotel:front-desk');
  }),

  cancel: reservations.input(idInput.extend({ idempotencyKey, expectedVersion: z.number().int().positive(), reason })).mutation(({ ctx, input }) => transition(ctx, input, ['HOLD', 'CONFIRMED'], 'CANCELLED', 'CANCELLED', 'hotel:reservations')),
  markNoShow: frontDesk.input(idInput.extend({ idempotencyKey, expectedVersion: z.number().int().positive(), reason })).mutation(({ ctx, input }) => transition(ctx, input, ['CONFIRMED'], 'NO_SHOW', 'NO_SHOW', 'hotel:front-desk')),
});

async function transition(ctx: TRPCContext, input: z.infer<typeof idInput> & { idempotencyKey: string; expectedVersion: number; reason: string }, from: ('HOLD' | 'CONFIRMED')[], to: 'CANCELLED' | 'NO_SHOW', kind: 'CANCELLED' | 'NO_SHOW', capability: 'hotel:reservations' | 'hotel:front-desk') {
  requireModule(ctx); const userId = actorId(ctx); return withLockedProperty(ctx, input.branchId, async (locked, property) => {
    const org = locked.entitlements.organizationId; const scope = `reservation.${to === 'CANCELLED' ? 'cancel' : 'no-show'}`; const hash = reservationRequestHash(input);
    const replay = await locked.db.hotelOperationIdempotencyKey.findUnique({ where: { organizationId_branchId_scope_key: { organizationId: org, branchId: property.branchId, scope, key: input.idempotencyKey } } });
    if (replay) { if (replay.requestHash !== hash) throw new TRPCError({ code: 'CONFLICT', message: 'That idempotency key was already used for a different request.' }); return replay.response as { reservationId: string; status: typeof to; version: number }; }
    const reservation = await locked.db.hotelReservation.findFirst({ where: { id: input.reservationId, organizationId: org, branchId: property.branchId } });
    if (!reservation) throw new TRPCError({ code: 'NOT_FOUND' }); if (!from.includes(reservation.status as 'HOLD' | 'CONFIRMED') || reservation.version !== input.expectedVersion) throw new TRPCError({ code: 'CONFLICT', message: 'Reservation changed or cannot make that transition.' });
    await locked.db.hotelRoomAssignment.updateMany({ where: { organizationId: org, branchId: property.branchId, stayUnit: { reservationId: reservation.id }, status: { in: [...activeAssignments] } }, data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: input.reason } });
    const updated = await locked.db.hotelReservation.update({ where: { id: reservation.id }, data: { status: to, version: { increment: 1 }, ...(to === 'CANCELLED' ? { cancelledAt: new Date() } : { noShowAt: new Date() }), events: { create: { organizationId: org, branchId: property.branchId, kind, fromStatus: reservation.status, toStatus: to, actorId: userId, reason: input.reason, metadata: {} } } } });
    const response = { reservationId: updated.id, status: to, version: updated.version };
    await locked.db.hotelOperationIdempotencyKey.create({ data: { organizationId: org, branchId: property.branchId, scope, key: input.idempotencyKey, requestHash: hash, resultType: 'HotelReservation', resultId: updated.id, response } });
    recordHotelAudit(locked, { entity: { type: 'HotelReservation', id: updated.id }, action: `hotel.reservation.${to === 'CANCELLED' ? 'cancel' : 'noShow'}`, before: { status: reservation.status }, after: { status: to }, metadata: { branchId: property.branchId, reason: input.reason } }); return response;
  }, capability);
}

export { availability as hotelAvailability };
