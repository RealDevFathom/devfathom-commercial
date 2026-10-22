import { readReservationProjection, type FolioReadGrant, type FolioReadScope, type HotelFolioReadStore } from './hotel-folio-read-service';
export const readReservationForRouter=(s:HotelFolioReadStore,c:FolioReadScope,id:string,g?:FolioReadGrant)=>readReservationProjection(s,c,id,g);
export const readReservationForService=(s:HotelFolioReadStore,c:FolioReadScope,id:string,g?:FolioReadGrant)=>readReservationProjection(s,c,id,g);
export const readReservationForReport=(s:HotelFolioReadStore,c:FolioReadScope,id:string,g?:FolioReadGrant)=>readReservationProjection(s,c,id,g);
export const readReservationForAiTool=(s:HotelFolioReadStore,c:FolioReadScope,id:string,g?:FolioReadGrant)=>readReservationProjection(s,c,id,g);
