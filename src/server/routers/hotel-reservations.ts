import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { calculateAvailability, quoteStayFromConfiguration, reservationCreateInput, type RatePlan } from '@/lib/hotel/reservations';
import { projectReservationFolio } from '@/lib/hotel/folio-security';
import { currentProperty, withLockedProperty } from '@/server/hotel-property-context';
import { hotelPropertySelectionInput } from '@/server/hotel-property-scope';
import { capabilityProcedure, router } from '../trpc';

const reservations = capabilityProcedure('hotel:reservations');
const folios = capabilityProcedure('hotel:folio');
const scopedId = hotelPropertySelectionInput.extend({ id: z.string().trim().min(1) }).strict();

type ReservationRow = { id: string; confirmationNumber: string; status: string; arrivalDate: Date; departureDate: Date; firstName: string; lastName: string };
async function reservationProjection(ctx: Parameters<typeof currentProperty>[0], branchId: string, id: string) {
  await currentProperty(ctx, branchId, 'hotel:reservations');
  const rows = await ctx.db.$queryRaw<ReservationRow[]>(Prisma.sql`SELECT r.id,r."confirmationNumber",r.status,r."arrivalDate",r."departureDate",g."firstName",g."lastName" FROM hotel_reservations r JOIN hotel_guests g ON g."organizationId"=r."organizationId" AND g."branchId"=r."branchId" AND g.id=r."primaryGuestId" WHERE r."organizationId"=${ctx.entitlements.organizationId} AND r."branchId"=${branchId} AND r.id=${id}`);
  if (!rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Reservation not found.' });
  return rows[0];
}

export const hotelReservationsRouter = router({
  search: reservations.input(hotelPropertySelectionInput.extend({ query: z.string().trim().max(120).optional() }).strict()).query(async ({ ctx, input }) => {
    await currentProperty(ctx, input.branchId, 'hotel:reservations');
    const term = `%${input.query ?? ''}%`;
    return ctx.db.$queryRaw<ReservationRow[]>(Prisma.sql`SELECT r.id,r."confirmationNumber",r.status,r."arrivalDate",r."departureDate",g."firstName",g."lastName" FROM hotel_reservations r JOIN hotel_guests g ON g."organizationId"=r."organizationId" AND g."branchId"=r."branchId" AND g.id=r."primaryGuestId" WHERE r."organizationId"=${ctx.entitlements.organizationId} AND r."branchId"=${input.branchId} AND (r."confirmationNumber" ILIKE ${term} OR g."lastName" ILIKE ${term}) ORDER BY r."arrivalDate",r.id LIMIT 100`);
  }),
  get: reservations.input(scopedId).query(async ({ ctx, input }) => projectReservationFolio(await reservationProjection(ctx, input.branchId, input.id), null, new Set())),
  getWithFolio: folios.input(scopedId).query(async ({ ctx, input }) => {
    await currentProperty(ctx, input.branchId, 'hotel:folio');
    const reservation = await reservationProjection(ctx, input.branchId, input.id);
    const rows = await ctx.db.$queryRaw<{ id: string; folioNumber: string; status: string; currency: string; balanceMinor: bigint }[]>(Prisma.sql`SELECT f.id,f."folioNumber",f.status,f.currency,COALESCE(sum(p."totalMinor"),0)::bigint AS "balanceMinor" FROM hotel_folios f LEFT JOIN hotel_folio_postings p ON p."organizationId"=f."organizationId" AND p."branchId"=f."branchId" AND p."folioId"=f.id WHERE f."organizationId"=${ctx.entitlements.organizationId} AND f."branchId"=${input.branchId} AND f."reservationId"=${input.id} GROUP BY f.id`);
    const folio = rows[0] ? { ...rows[0], balanceMinor: Number(rows[0].balanceMinor) } : null;
    return projectReservationFolio(reservation, folio, new Set(['hotel:folio']));
  }),
  availability: reservations.input(hotelPropertySelectionInput.extend({ arrivalDate: z.string(), departureDate: z.string() }).strict()).query(async ({ ctx, input }) => {
    await currentProperty(ctx, input.branchId, 'hotel:reservations');
    const [rooms, consuming, blocks] = await Promise.all([
      ctx.db.$queryRaw<{id:string;roomTypeId:string;active:boolean}[]>(Prisma.sql`SELECT id,"roomTypeId",active FROM hotel_rooms WHERE "organizationId"=${ctx.entitlements.organizationId} AND "branchId"=${input.branchId}`),
      ctx.db.$queryRaw<{roomTypeId:string;arrivalDate:Date;departureDate:Date;quantity:number}[]>(Prisma.sql`SELECT s."roomTypeId",s."arrivalDate",s."departureDate",s.quantity FROM hotel_reservation_stay_units s JOIN hotel_reservations r ON r."organizationId"=s."organizationId" AND r."branchId"=s."branchId" AND r.id=s."reservationId" WHERE s."organizationId"=${ctx.entitlements.organizationId} AND s."branchId"=${input.branchId} AND r.status IN ('CONFIRMED','CHECKED_IN')`),
      ctx.db.$queryRaw<{roomId:string;startDate:Date;endDate:Date}[]>(Prisma.sql`SELECT "roomId","startDate","endDate" FROM hotel_room_blocks WHERE "organizationId"=${ctx.entitlements.organizationId} AND "branchId"=${input.branchId} AND "releasedAt" IS NULL`),
    ]);
    const date = (value: Date) => value.toISOString().slice(0,10);
    return calculateAvailability({ rooms, consuming: consuming.map(x=>({...x,arrivalDate:date(x.arrivalDate),departureDate:date(x.departureDate)})), blocks: blocks.map(x=>({...x,startDate:date(x.startDate),endDate:date(x.endDate)})) }, input.arrivalDate, input.departureDate);
  }),
  create: reservations.input(reservationCreateInput).mutation(({ ctx, input }) => withLockedProperty(ctx, input.branchId, async (tx, property) => {
    const plans = await tx.db.$queryRaw<RatePlan[]>(Prisma.sql`SELECT id,"organizationId","branchId","roomTypeId","nightlyRateMinor",currency,"taxConfig",active,"validFrom"::text,"validTo"::text FROM hotel_rate_plans WHERE "organizationId"=${tx.entitlements.organizationId} AND "branchId"=${property.branchId} AND id=${input.ratePlanId} FOR SHARE`);
    const plan = plans[0]; if (!plan) throw new TRPCError({ code:'NOT_FOUND', message:'Rate plan is unavailable.' });
    const quote = quoteStayFromConfiguration(plan,{ organizationId:tx.entitlements.organizationId,branchId:property.branchId,roomTypeId:input.roomTypeId,arrivalDate:input.arrivalDate,departureDate:input.departureDate });
    // Inserts are scope-explicit; amounts below originate only from the locked rate/tax configuration.
    const result = await tx.db.$queryRaw<{id:string;confirmationNumber:string}[]>(Prisma.sql`WITH seq AS (INSERT INTO hotel_confirmation_number_sequences(id,"organizationId","branchId","nextNumber") VALUES (gen_random_uuid()::text,${tx.entitlements.organizationId},${property.branchId},2) ON CONFLICT("organizationId","branchId") DO UPDATE SET "nextNumber"=hotel_confirmation_number_sequences."nextNumber"+1 RETURNING "nextNumber"-1 AS n), guest AS (INSERT INTO hotel_guests(id,"organizationId","branchId","firstName","lastName",email,phone) VALUES(gen_random_uuid()::text,${tx.entitlements.organizationId},${property.branchId},${input.guest.firstName},${input.guest.lastName},${input.guest.email ?? null},${input.guest.phone ?? null}) RETURNING id), reservation AS (INSERT INTO hotel_reservations(id,"organizationId","branchId","confirmationNumber",status,source,"primaryGuestId","arrivalDate","departureDate",adults,children,"specialRequests",currency) SELECT gen_random_uuid()::text,${tx.entitlements.organizationId},${property.branchId},'RSV-'||extract(year from ${input.arrivalDate}::date)::int||'-'||lpad(seq.n::text,6,'0'),'HOLD',${input.source}::"HotelReservationSource",guest.id,${input.arrivalDate}::date,${input.departureDate}::date,${input.adults},${input.children},${input.specialRequests ?? null},${quote.currency} FROM seq,guest RETURNING *) INSERT INTO hotel_reservation_stay_units(id,"organizationId","branchId","reservationId","roomTypeId","ratePlanId","mealPlanId",quantity,adults,children,"nightlyRateMinor","netMinorPerNight","taxMinorPerNight","totalMinorPerNight","taxSnapshot",currency,"arrivalDate","departureDate") SELECT gen_random_uuid()::text,"organizationId","branchId",id,${input.roomTypeId},${input.ratePlanId},${input.mealPlanId ?? null},1,${input.adults},${input.children},${quote.nightlyRateMinor},${quote.netMinorPerNight},${quote.taxMinorPerNight},${quote.totalMinorPerNight},${JSON.stringify(quote.taxSnapshot)}::jsonb,${quote.currency},"arrivalDate","departureDate" FROM reservation RETURNING "reservationId" AS id,(SELECT "confirmationNumber" FROM reservation) AS "confirmationNumber"`);
    return result[0];
  }, 'hotel:reservations')),
});
