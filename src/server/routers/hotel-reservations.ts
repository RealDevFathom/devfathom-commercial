import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { hasModule } from '@/lib/entitlements';
import { stayRangeInput, summarizeAvailability } from '@/lib/hotel/reservations';
import { currentProperty } from '@/server/hotel-property-context';
import { hotelPropertySelectionInput } from '@/server/hotel-property-scope';
import { capabilityProcedure, router } from '../trpc';

const reservations = capabilityProcedure('hotel:reservations');
const selectionAndRange = stayRangeInput.safeExtend(hotelPropertySelectionInput.shape);
const consumingStatuses = ['CONFIRMED', 'CHECKED_IN'] as const;
const activeAssignments = ['HELD', 'ACTIVE'] as const;
function requireModule(ctx: { entitlements: Parameters<typeof hasModule>[0] }) {
  if (!hasModule(ctx.entitlements, 'hotel-reservations')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Reservations are not enabled.' });
}
export async function hotelAvailability(db: Prisma.TransactionClient, organizationId: string, branchId: string, arrivalDate: Date, departureDate: Date) {
  const roomTypes = await db.hotelRoomType.findMany({ where: { organizationId, branchId, active: true }, orderBy: [{ sort: 'asc' }, { code: 'asc' }], select: {
    id: true, code: true, name: true, active: true,
    rooms: { where: { organizationId, branchId, active: true }, orderBy: { number: 'asc' }, select: { id: true, roomTypeId: true, number: true, status: true,
      blocks: { where: { releasedAt: null, startDate: { lt: departureDate }, endDate: { gt: arrivalDate } }, select: { id: true } },
      assignments: { where: { status: { in: [...activeAssignments] }, startDate: { lt: departureDate }, endDate: { gt: arrivalDate } }, select: { id: true } } } },
    stayUnits: { where: { arrivalDate: { lt: departureDate }, departureDate: { gt: arrivalDate }, reservation: { status: { in: [...consumingStatuses] } } }, select: { quantity: true } },
  } });
  return summarizeAvailability(roomTypes);
}
export const hotelReservationsRouter = router({
  search: reservations.input(hotelPropertySelectionInput.extend({ query: z.string().trim().optional(), limit: z.number().int().min(1).max(100).default(30) })).query(async ({ ctx, input }) => {
    requireModule(ctx); const property = await currentProperty(ctx, input.branchId, 'hotel:reservations');
    return { reservations: await ctx.db.hotelReservation.findMany({ where: { organizationId: ctx.entitlements.organizationId, branchId: property.branchId, ...(input.query ? { OR: [{ confirmationNumber: { contains: input.query, mode: 'insensitive' } }, { primaryGuest: { lastName: { contains: input.query, mode: 'insensitive' } } }] } : {}) }, take: input.limit, include: { primaryGuest: true, stayUnits: true, folio: true }, orderBy: [{ arrivalDate: 'desc' }, { id: 'desc' }] }) };
  }),
  availability: reservations.input(selectionAndRange).query(async ({ ctx, input }) => { requireModule(ctx); const property = await currentProperty(ctx, input.branchId, 'hotel:reservations'); return { arrivalDate: input.arrivalDate, departureDate: input.departureDate, roomTypes: await hotelAvailability(ctx.db, ctx.entitlements.organizationId, property.branchId, input.arrivalDate, input.departureDate) }; }),
});
