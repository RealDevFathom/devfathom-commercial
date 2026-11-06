import { describe, expect, it, vi } from 'vitest';

import { issueFolioReadGrant, readReservationProjection } from './hotel-folio-read-service';
import { createReservation, type HotelReservationStore } from './hotel-reservation-service';

const scope = { organizationId: 'o', branchId: 'p' };
const folio = {
  id: 'f',
  folioNumber: 'FOL-1',
  status: 'OPEN',
  currency: 'PKR',
  balanceMinor: BigInt(5),
};

function readStore() {
  return {
    readReservation: vi.fn().mockResolvedValue({ id: 'r' }),
    readFolio: vi.fn().mockResolvedValue(folio),
  };
}

describe('hotel security rules', () => {
  it('never loads the folio without a server-issued hotel:folio grant', async () => {
    const store = readStore();
    expect(await readReservationProjection(store, scope, 'r')).toEqual({
      id: 'r',
      folioAccess: false,
    });
    expect(issueFolioReadGrant(scope, new Set(['hotel:reservations']))).toBeUndefined();
    expect(store.readFolio).not.toHaveBeenCalled();
  });

  it('loads the folio only for a grant matching both tenant keys', async () => {
    const store = readStore();
    const grant = issueFolioReadGrant(scope, new Set(['hotel:folio']));
    expect(await readReservationProjection(store, scope, 'r', grant)).toEqual({
      id: 'r',
      folioAccess: true,
      folio,
    });
    const foreign = issueFolioReadGrant(
      { organizationId: 'o', branchId: 'other' },
      new Set(['hotel:folio'])
    );
    expect(await readReservationProjection(readStore(), scope, 'r', foreign)).toEqual({
      id: 'r',
      folioAccess: false,
    });
  });

  it('rejects client-authored money before any dependency runs', async () => {
    const store = { findReplay: vi.fn() } as unknown as HotelReservationStore;
    await expect(
      createReservation(store, scope, 'u', {
        branchId: 'p',
        idempotencyKey: 'abcdefgh',
        source: 'DIRECT',
        arrivalDate: '2026-10-22',
        departureDate: '2026-10-23',
        roomTypeId: 'rt',
        ratePlanId: 'rp',
        adults: 1,
        children: 0,
        guest: { firstName: 'A', lastName: 'B' },
        amountMinor: 1,
      } as never)
    ).rejects.toThrow(/Client-authored/);
    expect(store.findReplay).not.toHaveBeenCalled();
  });
});
