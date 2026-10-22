import { TRPCError } from '@trpc/server';
import { HOTEL_FOLIO_CAPABILITY, projectReservationFolio, type FolioEvidence } from '@/lib/hotel/folio-security';
export type FolioReadScope={organizationId:string;branchId:string};
export type FolioReadGrant={capability:typeof HOTEL_FOLIO_CAPABILITY;organizationId:string;branchId:string};
export interface HotelFolioReadStore{readReservation(scope:FolioReadScope,id:string):Promise<Record<string,unknown>|null>;readFolio(scope:FolioReadScope,reservationId:string):Promise<FolioEvidence|null>}
export function issueFolioReadGrant(scope:FolioReadScope,capabilities:ReadonlySet<string>):FolioReadGrant|undefined{return capabilities.has(HOTEL_FOLIO_CAPABILITY)?{...scope,capability:HOTEL_FOLIO_CAPABILITY}:undefined;}
/** All routers, services, reports and AI tools use this boundary; callers cannot opt into fields. */
export async function readReservationProjection(store:HotelFolioReadStore,scope:FolioReadScope,id:string,grant?:FolioReadGrant){const reservation=await store.readReservation(scope,id);if(!reservation)throw new TRPCError({code:'NOT_FOUND',message:'Reservation not found.'});const valid=grant?.capability===HOTEL_FOLIO_CAPABILITY&&grant.organizationId===scope.organizationId&&grant.branchId===scope.branchId;const folio=valid?await store.readFolio(scope,id):null;return projectReservationFolio(reservation,folio,new Set(valid?[HOTEL_FOLIO_CAPABILITY]:[]));}
