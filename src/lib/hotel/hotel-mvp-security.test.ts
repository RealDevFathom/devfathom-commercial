import { describe, expect, it } from 'vitest';
import { projectReservationFolio, assertAppendOnlyCorrection } from './folio-security';
import { calculateAvailability, quoteStayFromConfiguration, reservationCreateInput } from './reservations';

const folio = { id:'f1',folioNumber:'F-1',status:'OPEN',currency:'PKR',balanceMinor:1200 };
describe('Hotel MVP security invariants', () => {
  it.each(['reservations','front desk','inventory','reports','AI tools'])('returns a folio-free projection to %s without hotel:folio', () => {
    const result = projectReservationFolio({ id:'r1' },folio,new Set(['hotel:reservations']));
    expect(result).toEqual({ id:'r1',folioAccess:false });
    expect(result).not.toHaveProperty('folio');
  });
  it('discloses folio evidence only with hotel:folio', () => expect(projectReservationFolio({id:'r1'},folio,new Set(['hotel:folio']))).toEqual({id:'r1',folioAccess:true,folio}));
  it.each(['nightlyRateMinor','taxMinor','totalMinor','amountMinor','balanceMinor'])('rejects client money field %s', (field) => {
    expect(reservationCreateInput.safeParse({ branchId:'p',idempotencyKey:'12345678',source:'DIRECT',arrivalDate:'2026-10-22',departureDate:'2026-10-23',roomTypeId:'rt',ratePlanId:'rp',adults:1,guest:{firstName:'A',lastName:'B'},[field]:1 }).success).toBe(false);
  });
  it('derives the snapshot from the property-scoped rate plan and tax config', () => {
    const quote=quoteStayFromConfiguration({id:'rp',organizationId:'o',branchId:'p',roomTypeId:'rt',nightlyRateMinor:10_000,currency:'PKR',active:true,validFrom:'2026-01-01',validTo:null,taxConfig:{productClass:'HOTEL',province:'PUNJAB',roomServicesTaxBps:1000,priceMode:'EXCLUSIVE',levies:[],eInvoiceEnabled:false,submissionMode:'SIMULATED'}},{organizationId:'o',branchId:'p',roomTypeId:'rt',arrivalDate:'2026-10-22',departureDate:'2026-10-24'});
    expect(quote).toMatchObject({nightlyRateMinor:10_000,netMinorPerNight:10_000,taxMinorPerNight:1_000,totalMinorPerNight:11_000,nights:2});
  });
  it('requires correction by linked reversal rather than mutation',()=>expect(()=>assertAppendOnlyCorrection({reason:'fix'})).toThrow(/reversing/));
  it('subtracts blocks and confirmed demand through one availability calculator',()=>expect(calculateAvailability({rooms:[{id:'1',roomTypeId:'rt',active:true},{id:'2',roomTypeId:'rt',active:true}],consuming:[{roomTypeId:'rt',arrivalDate:'2026-10-22',departureDate:'2026-10-23',quantity:1}],blocks:[{roomId:'2',startDate:'2026-10-22',endDate:'2026-10-23'}]},'2026-10-22','2026-10-23')[0]).toMatchObject({supply:1,demand:1,available:0}));
});
