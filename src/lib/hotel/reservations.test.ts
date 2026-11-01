import { describe, expect, it } from 'vitest';
import {
  calculateAvailability,
  canBook,
  confirmationNumber,
  folioNumberFor,
  reservationCreateInput,
  reservationRequestHash,
  stayRangeInput,
  type AvailabilityFacts,
} from './reservations';

const create = {
  branchId: 'p',
  idempotencyKey: '12345678',
  source: 'DIRECT',
  arrivalDate: '2026-10-22',
  departureDate: '2026-10-24',
  roomTypeId: 'type',
  ratePlanId: 'plan',
  adults: 2,
  guest: { firstName: 'A', lastName: 'B' },
};

describe('hotel reservation contracts', () => {
  it('uses half-open, forward stay ranges', () => {
    expect(stayRangeInput.safeParse({ arrivalDate: '2026-10-22', departureDate: '2026-10-23' }).success).toBe(true);
    expect(stayRangeInput.safeParse({ arrivalDate: '2026-10-22', departureDate: '2026-10-22' }).success).toBe(false);
    expect(stayRangeInput.safeParse({ arrivalDate: '2026-02-30', departureDate: '2026-03-02' }).success).toBe(false);
  });

  it('hashes canonical requests independent of key order', () => {
    expect(reservationRequestHash({ b: 2, a: 1 })).toBe(reservationRequestHash({ a: 1, b: 2 }));
    expect(reservationRequestHash({ a: 2 })).not.toBe(reservationRequestHash({ a: 1 }));
  });

  it('accepts configuration and refuses client money or an unbounded stay', () => {
    expect(reservationCreateInput.safeParse(create).success).toBe(true);
    expect(reservationCreateInput.safeParse({ ...create, totalMinor: 1 }).success).toBe(false);
    expect(reservationCreateInput.safeParse({ ...create, departureDate: '2027-10-22' }).success).toBe(false);
    expect(reservationCreateInput.safeParse({ ...create, arrivalDate: 'not-a-date' }).success).toBe(false);
  });

  it('subtracts blocks from supply and consuming stays from it per night', () => {
    const facts: AvailabilityFacts = {
      rooms: [
        { id: 'r1', roomTypeId: 'type', units: 1 },
        { id: 'r2', roomTypeId: 'type', units: 1 },
        { id: 'r3', roomTypeId: 'type', units: 1 },
      ],
      consuming: [{ roomTypeId: 'type', arrivalDate: '2026-10-22', departureDate: '2026-10-23', quantity: 1 }],
      blocks: [{ roomId: 'r3', startDate: '2026-10-22', endDate: '2026-10-24' }],
    };
    expect(calculateAvailability(facts, '2026-10-22', '2026-10-24')).toEqual([
      { date: '2026-10-22', roomTypeId: 'type', supply: 2, demand: 1, available: 1 },
      { date: '2026-10-23', roomTypeId: 'type', supply: 2, demand: 0, available: 2 },
    ]);
  });

  it('refuses a booking when any night is sold out or the type has no rooms', () => {
    const facts: AvailabilityFacts = {
      rooms: [{ id: 'r1', roomTypeId: 'type', units: 1 }],
      consuming: [{ roomTypeId: 'type', arrivalDate: '2026-10-23', departureDate: '2026-10-24', quantity: 1 }],
      blocks: [],
    };
    expect(canBook(facts, 'type', '2026-10-22', '2026-10-23')).toBe(true);
    expect(canBook(facts, 'type', '2026-10-22', '2026-10-24')).toBe(false);
    expect(canBook(facts, 'other', '2026-10-22', '2026-10-23')).toBe(false);
  });

  it('formats property sequence numbers', () => {
    expect(confirmationNumber(2026, 12)).toBe('RSV-2026-000012');
    expect(folioNumberFor('RSV-2026-000012')).toBe('FOL-2026-000012');
  });
});
