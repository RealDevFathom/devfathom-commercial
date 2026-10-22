import { describe, expect, it } from 'vitest';
import { hotelRatePlansRouter } from './hotel-rate-plans';

describe('hotel rate plan inputs', () => {
  it('rejects client-supplied prices on quote', async () => {
    const caller = hotelRatePlansRouter.createCaller({} as never);
    await expect(caller.quote({
      branchId: 'b', roomTypeId: 'r', ratePlanId: 'p',
      arrival: new Date('2026-11-01'), departure: new Date('2026-11-02'), netMinor: 1n,
    } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
