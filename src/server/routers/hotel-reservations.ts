import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { reservationCreateInput } from '@/lib/hotel/reservations';
import { issueFolioReadGrant, readReservationProjection, type HotelFolioReadStore } from '@/server/hotel-folio-read-service';
import { currentProperty, withLockedProperty } from '@/server/hotel-property-context';
import { hotelPropertySelectionInput } from '@/server/hotel-property-scope';
import { capabilityProcedure, router } from '../trpc';
const reservations=capabilityProcedure('hotel:reservations'); const folios=capabilityProcedure('hotel:folio');
const scopedId=hotelPropertySelectionInput.extend({id:z.string().trim().min(1)}).strict();
function store(ctx:any):HotelFolioReadStore{return{readReservation:async(scope,id)=>(await ctx.db.$queryRaw<Record<string,unknown>[]>(Prisma.sql`SELECT id,"confirmationNumber",status,"arrivalDate","departureDate" FROM hotel_reservations WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${id}`))[0]??null,readFolio:async(scope,id)=>{const row=(await ctx.db.$queryRaw<any[]>(Prisma.sql`SELECT f.id,f."folioNumber",f.status,f.currency,COALESCE(sum(p."totalMinor"),0)::bigint "balanceMinor" FROM hotel_folios f LEFT JOIN hotel_folio_postings p ON p."organizationId"=f."organizationId" AND p."branchId"=f."branchId" AND p."folioId"=f.id WHERE f."organizationId"=${scope.organizationId} AND f."branchId"=${scope.branchId} AND f."reservationId"=${id} GROUP BY f.id`))[0];return row?{...row,balanceMinor:Number(row.balanceMinor)}:null;}}}
export const hotelReservationsRouter=router({
 get:reservations.input(scopedId).query(async({ctx,input})=>{const property=await currentProperty(ctx,input.branchId,'hotel:reservations');return readReservationProjection(store(ctx),{organizationId:ctx.entitlements.organizationId,branchId:property.branchId},input.id);}),
 getWithFolio:folios.input(scopedId).query(async({ctx,input})=>{const property=await currentProperty(ctx,input.branchId,'hotel:folio');const scope={organizationId:ctx.entitlements.organizationId,branchId:property.branchId};return readReservationProjection(store(ctx),scope,input.id,issueFolioReadGrant(scope,new Set(['hotel:folio'])));}),
 create:reservations.input(reservationCreateInput).mutation(({ctx,input})=>withLockedProperty(ctx,input.branchId,async(tx,property)=>tx.db.$executeRaw(Prisma.sql`INSERT INTO hotel_reservations(id,"organizationId","branchId","confirmationNumber",status,"arrivalDate","departureDate",currency) SELECT gen_random_uuid()::text,${tx.entitlements.organizationId},${property.branchId},gen_random_uuid()::text,'HOLD',${input.arrivalDate}::date,${input.departureDate}::date,r.currency FROM hotel_rate_plans r WHERE r."organizationId"=${tx.entitlements.organizationId} AND r."branchId"=${property.branchId} AND r.id=${input.ratePlanId} AND r."roomTypeId"=${input.roomTypeId} AND r.active`),'hotel:reservations'))
});
