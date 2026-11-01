import { describe, expect, it, vi } from 'vitest';

vi.mock('../trpc', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC.context<Record<string, unknown>>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    adminProcedure: t.procedure,
    capabilityProcedure: () => t.procedure,
  };
});

import { ratePlanCreateInput, ratePlanPriceInput, ratePlanQuoteInput } from './hotel-rate-plans';

const quote = {
  branchId: 'b',
  roomTypeId: 'r',
  ratePlanId: 'p',
  arrivalDate: '2026-11-01',
  departureDate: '2026-11-02',
};

describe('hotel rate plan inputs', () => {
  it('rejects client-supplied prices on quote', () => {
    expect(ratePlanQuoteInput.safeParse(quote).success).toBe(true);
    expect(ratePlanQuoteInput.safeParse({ ...quote, netMinor: BigInt(1) }).success).toBe(false);
    expect(ratePlanQuoteInput.safeParse({ ...quote, totalMinor: 1 }).success).toBe(false);
  });

  it('requires a forward, bounded stay', () => {
    expect(ratePlanQuoteInput.safeParse({ ...quote, departureDate: '2026-11-01' }).success).toBe(false);
    expect(ratePlanQuoteInput.safeParse({ ...quote, departureDate: '2027-11-01' }).success).toBe(false);
    expect(ratePlanQuoteInput.safeParse({ ...quote, arrivalDate: '2026-02-30' }).success).toBe(false);
  });

  it('creates a plan from terms only, never a nightly amount', () => {
    const plan = {
      branchId: 'b',
      roomTypeId: 'r',
      code: 'bar',
      name: 'Best available',
      currency: 'PKR',
      taxBasisPoints: 1_600,
    };
    expect(ratePlanCreateInput.parse(plan).code).toBe('BAR');
    expect(ratePlanCreateInput.safeParse({ ...plan, nightlyRateMinor: 0 }).success).toBe(false);
    expect(ratePlanCreateInput.safeParse({ ...plan, taxBasisPoints: 100_001 }).success).toBe(false);
  });

  it('accepts a non-negative bigint price over an ordered range', () => {
    const price = {
      branchId: 'b',
      roomTypeId: 'r',
      ratePlanId: 'p',
      validFrom: '2026-11-01',
      validTo: '2026-11-30',
      netMinor: BigInt(1_500_000),
    };
    expect(ratePlanPriceInput.safeParse(price).success).toBe(true);
    expect(ratePlanPriceInput.safeParse({ ...price, netMinor: BigInt(-1) }).success).toBe(false);
    expect(ratePlanPriceInput.safeParse({ ...price, validTo: '2026-10-31' }).success).toBe(false);
  });
});
