import { describe, expect, it } from 'vitest';
import { assertAppendOnlyCorrection, projectReservationFolio } from './folio-security';
import { reservationCreateInput } from './reservations';

const folio = { id: 'f', folioNumber: 'FOL-1', status: 'OPEN', currency: 'PKR', balanceMinor: BigInt(100) };
const create = {
  branchId: 'p',
  idempotencyKey: '12345678',
  source: 'DIRECT',
  arrivalDate: '2026-10-22',
  departureDate: '2026-10-23',
  roomTypeId: 'rt',
  ratePlanId: 'rp',
  adults: 1,
  guest: { firstName: 'A', lastName: 'B' },
};

describe('hotel MVP security invariants', () => {
  it.each(['routers', 'services', 'AI tools', 'reports'])(
    'returns folio-free data to %s without hotel:folio',
    () => expect(projectReservationFolio({ id: 'r' }, folio, new Set())).toEqual({ id: 'r', folioAccess: false })
  );
  it.each(['nightlyRateMinor', 'taxMinor', 'totalMinor', 'amountMinor', 'balanceMinor', 'currency'])(
    'rejects client money %s',
    (field) => expect(reservationCreateInput.safeParse({ ...create, [field]: 1 }).success).toBe(false)
  );
  it('requires linked reversal corrections', () =>
    expect(() => assertAppendOnlyCorrection({ reason: 'fix' })).toThrow(/reversing/));
});
