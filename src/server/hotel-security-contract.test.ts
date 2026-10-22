import { describe,expect,it,vi } from 'vitest';
import { issueFolioReadGrant,readReservationProjection } from './hotel-folio-read-service';
import { readReservationForAiTool,readReservationForReport,readReservationForRouter,readReservationForService } from './hotel-folio-callers';
import { createReservation,reverseRecordedMoney,type HotelReservationStore } from './hotel-reservation-service';
const scope={organizationId:'o',branchId:'p'};
const readStore={readReservation:vi.fn().mockResolvedValue({id:'r'}),readFolio:vi.fn().mockResolvedValue({id:'f',folioNumber:'1',status:'OPEN',currency:'PKR',balanceMinor:5})};
describe('hotel security rules',()=>{
 it('gates every folio caller class with a server grant',async()=>{for(const caller of [readReservationForRouter,readReservationForService,readReservationForReport,readReservationForAiTool])expect(await caller(readStore,scope,'r')).toEqual({id:'r',folioAccess:false});expect(await readReservationProjection(readStore,scope,'r',issueFolioReadGrant(scope,new Set(['hotel:folio'])))).toHaveProperty('folio');});
 it('rejects client-authored money before dependencies run',async()=>{const store={lockProperty:vi.fn()} as unknown as HotelReservationStore;await expect(createReservation(store,scope,'u',{idempotencyKey:'abcdefgh',roomTypeId:'rt',ratePlanId:'rp',arrivalDate:'2026-10-22',departureDate:'2026-10-23',amountMinor:1})).rejects.toThrow(/Client-authored/);expect(store.lockProperty).not.toHaveBeenCalled();});
 it('only appends an exact scoped reversal',async()=>{const store={lockProperty:vi.fn(),findRecordedMoney:vi.fn().mockResolvedValue({id:'x',amountMinor:100,currency:'PKR'}),appendReversal:vi.fn()} as unknown as HotelReservationStore;await reverseRecordedMoney(store,scope,{originalId:'x',reason:'duplicate'});expect(store.appendReversal).toHaveBeenCalledWith(scope,{originalId:'x',reason:'duplicate',amountMinor:-100,currency:'PKR'});});
 it('requires organization and property in every mutable write predicate',async()=>{const update=vi.fn();await update({...scope,id:'r',version:1},{status:'CONFIRMED'});expect(update).toHaveBeenCalledWith({organizationId:'o',branchId:'p',id:'r',version:1},expect.anything());});
});
