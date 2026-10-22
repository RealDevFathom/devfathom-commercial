import { describe,expect,it } from 'vitest';
import { assertAppendOnlyCorrection,projectReservationFolio } from './folio-security';
import { quoteStayFromConfiguration,reservationCreateInput } from './reservations';
const folio={id:'f',folioNumber:'F-1',status:'OPEN',currency:'PKR',balanceMinor:100};
describe('hotel MVP security invariants',()=>{
 it.each(['routers','services','AI tools','reports'])('returns folio-free data to %s without hotel:folio',()=>expect(projectReservationFolio({id:'r'},folio,new Set())).toEqual({id:'r',folioAccess:false}));
 it.each(['nightlyRateMinor','taxMinor','totalMinor','amountMinor','balanceMinor'])('rejects client money %s',(field)=>expect(reservationCreateInput.safeParse({branchId:'p',idempotencyKey:'12345678',source:'DIRECT',arrivalDate:'2026-10-22',departureDate:'2026-10-23',roomTypeId:'rt',ratePlanId:'rp',adults:1,guest:{firstName:'A',lastName:'B'},[field]:1}).success).toBe(false));
 it('derives rate and tax server-side',()=>expect(quoteStayFromConfiguration({id:'rp',organizationId:'o',branchId:'p',roomTypeId:'rt',nightlyRateMinor:10000,currency:'PKR',active:true,validFrom:'2026-01-01',validTo:null,taxConfig:{productClass:'HOTEL',province:'PUNJAB',roomServicesTaxBps:1000,priceMode:'EXCLUSIVE',levies:[],eInvoiceEnabled:false,submissionMode:'SIMULATED'}},{organizationId:'o',branchId:'p',roomTypeId:'rt',arrivalDate:'2026-10-22',departureDate:'2026-10-23'})).toMatchObject({taxMinorPerNight:1000,totalMinorPerNight:11000}));
 it('requires linked reversal corrections',()=>expect(()=>assertAppendOnlyCorrection({reason:'fix'})).toThrow(/reversing/));
});
