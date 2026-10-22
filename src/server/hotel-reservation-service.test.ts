import { describe, expect, it, vi } from 'vitest';
import { createReservation, reverseRecordedMoney, type HotelReservationStore } from './hotel-reservation-service';
const scope={organizationId:'org-a',branchId:'property-a'};
function store(): HotelReservationStore { return {lockProperty:vi.fn(),findRatePlan:vi.fn().mockResolvedValue({id:'rp',...scope,roomTypeId:'rt',nightlyRateMinor:10000,currency:'PKR',taxConfig:{productClass:'HOTEL',province:'PUNJAB',roomServicesTaxBps:0,priceMode:'EXCLUSIVE',levies:[]},active:true,validFrom:'2026-01-01',validTo:null}),findReplay:vi.fn().mockResolvedValue(null),createReservation:vi.fn().mockResolvedValue({id:'r'}),updateReservation:vi.fn(),appendReservationEvent:vi.fn(),appendReversal:vi.fn()}; }
describe('scoped reservation writes',()=>{
 it('passes organization and property scope to every create dependency',async()=>{const db=store();await createReservation(db,scope,'u',{idempotencyKey:'abcdefgh',roomTypeId:'rt',ratePlanId:'rp',arrivalDate:'2026-10-22',departureDate:'2026-10-23'});expect(db.findRatePlan).toHaveBeenCalledWith(scope,'rp');expect(db.createReservation).toHaveBeenCalledWith(scope,expect.objectContaining({nightlyRateMinor:10000}),expect.anything());});
 it('offers only appendReversal for a recorded-money correction',async()=>{const db=store();await reverseRecordedMoney(db,scope,{originalId:'posting',reason:'duplicate',amountMinor:100});expect(db.appendReversal).toHaveBeenCalledWith(scope,expect.objectContaining({originalId:'posting'}));});
 it('rejects an idempotency payload conflict without writing',async()=>{const db=store();vi.mocked(db.findReplay).mockResolvedValue({requestHash:'different',response:{id:'old'}});await expect(createReservation(db,scope,'u',{idempotencyKey:'abcdefgh',roomTypeId:'rt',ratePlanId:'rp',arrivalDate:'2026-10-22',departureDate:'2026-10-23'})).rejects.toMatchObject({code:'CONFLICT'});expect(db.createReservation).not.toHaveBeenCalled();});
});

describe('write predicate contract',()=>{
 it('requires both scopes on mutable writes',async()=>{const db=store();await db.updateReservation({...scope,id:'r',version:2},{status:'CONFIRMED'});expect(db.updateReservation).toHaveBeenCalledWith({organizationId:'org-a',branchId:'property-a',id:'r',version:2},{status:'CONFIRMED'});});
});
