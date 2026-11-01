import { describe, expect, it, vi } from 'vitest';

import type { ReservationCreateRequest } from '@/lib/hotel/reservations';
import {
  createReservation,
  RESERVATION_CREATE_OPERATION,
  type HotelReservationStore,
} from './hotel-reservation-service';

const scope = { organizationId: 'org-a', branchId: 'property-a' };
const input: ReservationCreateRequest = {
  branchId: 'property-a',
  idempotencyKey: 'abcdefgh',
  source: 'DIRECT',
  arrivalDate: '2026-10-22',
  departureDate: '2026-10-23',
  roomTypeId: 'rt',
  ratePlanId: 'rp',
  adults: 1,
  children: 0,
  guest: { firstName: 'A', lastName: 'B' },
};
const priced = {
  ratePlanId: 'rp',
  roomTypeId: 'rt',
  currency: 'PKR',
  taxBasisPoints: 1_600,
  nights: [{ date: '2026-10-22', netMinor: BigInt(10_000), taxMinor: BigInt(1_600), totalMinor: BigInt(11_600) }],
  netMinor: BigInt(10_000),
  taxMinor: BigInt(1_600),
  totalMinor: BigInt(11_600),
  priceIds: ['price-1'],
};
const created = {
  id: 'r',
  confirmationNumber: 'RSV-2026-000001',
  status: 'HOLD' as const,
  folioId: 'f',
  folioNumber: 'FOL-2026-000001',
};

function store(rooms = 1): HotelReservationStore {
  return {
    findReplay: vi.fn().mockResolvedValue(null),
    priceStay: vi.fn().mockResolvedValue(priced),
    availability: vi.fn().mockResolvedValue({
      rooms: Array.from({ length: rooms }, (_, index) => ({ id: `room-${index}`, roomTypeId: 'rt', units: 1 })),
      consuming: [],
      blocks: [],
    }),
    insertReservation: vi.fn().mockResolvedValue(created),
    saveReplay: vi.fn().mockResolvedValue(undefined),
  };
}

describe('scoped reservation create', () => {
  it('passes organization and property scope to every dependency and prices on the server', async () => {
    const db = store();
    await expect(createReservation(db, scope, 'u', input)).resolves.toEqual(created);
    expect(db.priceStay).toHaveBeenCalledWith(scope, expect.objectContaining({ ratePlanId: 'rp', roomTypeId: 'rt' }));
    expect(db.availability).toHaveBeenCalledWith(scope, '2026-10-22', '2026-10-23');
    expect(db.insertReservation).toHaveBeenCalledWith(scope, 'u', input, priced);
    expect(db.saveReplay).toHaveBeenCalledWith(
      scope,
      RESERVATION_CREATE_OPERATION,
      'abcdefgh',
      expect.any(String),
      created
    );
  });

  it('returns the stored result for an exact replay without writing', async () => {
    const db = store();
    await createReservation(db, scope, 'u', input);
    const requestHash = vi.mocked(db.saveReplay).mock.calls[0][3];
    const replaying = store();
    vi.mocked(replaying.findReplay).mockResolvedValue({ requestHash, response: created });
    await expect(createReservation(replaying, scope, 'u', input)).resolves.toEqual(created);
    expect(replaying.insertReservation).not.toHaveBeenCalled();
    expect(replaying.saveReplay).not.toHaveBeenCalled();
  });

  it('rejects an idempotency payload conflict without writing', async () => {
    const db = store();
    vi.mocked(db.findReplay).mockResolvedValue({ requestHash: 'different', response: { id: 'old' } });
    await expect(createReservation(db, scope, 'u', input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.insertReservation).not.toHaveBeenCalled();
  });

  it('refuses to oversell a sold-out night', async () => {
    const db = store(1);
    vi.mocked(db.availability).mockResolvedValue({
      rooms: [{ id: 'room-0', roomTypeId: 'rt', units: 1 }],
      consuming: [{ roomTypeId: 'rt', arrivalDate: '2026-10-22', departureDate: '2026-10-23', quantity: 1 }],
      blocks: [],
    });
    await expect(createReservation(db, scope, 'u', input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.insertReservation).not.toHaveBeenCalled();
  });

  it('refuses an unknown or foreign rate plan', async () => {
    const db = store();
    vi.mocked(db.priceStay).mockResolvedValue(null);
    await expect(createReservation(db, scope, 'u', input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.insertReservation).not.toHaveBeenCalled();
  });

  it('refuses a request for another property than the locked one', async () => {
    const db = store();
    await expect(
      createReservation(db, scope, 'u', { ...input, branchId: 'property-b' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.findReplay).not.toHaveBeenCalled();
  });
});
