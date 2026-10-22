import { describe, expect, it } from 'vitest';
import {
  confirmationNumber,
  reservationRequestHash,
  stayRangeInput,
  summarizeAvailability,
} from './reservations';
describe('hotel reservation contracts', () => {
  it('uses half-open, forward stay ranges', () => {
    expect(stayRangeInput.safeParse({ arrivalDate: '2026-10-22', departureDate: '2026-10-23' }).success).toBe(true);
    expect(stayRangeInput.safeParse({ arrivalDate: '2026-10-22', departureDate: '2026-10-22' }).success).toBe(false);
  });
  it('hashes canonical requests independent of key order', () => {
    expect(reservationRequestHash({ b: 2, a: 1 })).toBe(reservationRequestHash({ a: 1, b: 2 }));
    expect(reservationRequestHash({ a: 2 })).not.toBe(reservationRequestHash({ a: 1 }));
  });
  it('derives supply, demand and clean assignable rooms once', () => {
    const [result] = summarizeAvailability([{ id: 'type', code: 'STD', name: 'Standard', active: true,
      stayUnits: [{ quantity: 1 }], rooms: [
        { id: 'clean', roomTypeId: 'type', number: '101', status: 'VACANT_CLEAN', blocks: [], assignments: [] },
        { id: 'dirty', roomTypeId: 'type', number: '102', status: 'VACANT_DIRTY', blocks: [], assignments: [] },
        { id: 'blocked', roomTypeId: 'type', number: '103', status: 'VACANT_CLEAN', blocks: [{}], assignments: [] },
      ] }]);
    expect(result).toMatchObject({ supply: 2, sold: 1, available: 1 });
    expect(result.assignableRooms.map((room) => room.id)).toEqual(['clean']);
  });
  it('formats property sequence numbers', () => {
    expect(confirmationNumber(2026, 12)).toBe('RSV-2026-000012');
  });
});
