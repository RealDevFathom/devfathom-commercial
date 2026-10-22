import { describe, expect, it } from 'vitest';

import {
  HOTEL_INVENTORY_STATUSES,
  hotelInventoryStatusInput,
  hotelRoomTypeCreateInput,
  hotelRoomBlockCreateInput,
  inventoryTransitionAllowed,
} from './inventory';

const roomType = {
  code: 'std',
  name: 'Standard',
  inventoryKind: 'ROOM',
  baseAdults: 1,
  maxAdults: 2,
  maxChildren: 0,
};

describe('inventory input and transition contracts', () => {
  it.each(['ROOM', 'UNIT', 'BED'])('accepts %s with valid capacity', (inventoryKind) => {
    const parsed = hotelRoomTypeCreateInput.parse({
      ...roomType,
      inventoryKind,
      ...(inventoryKind === 'BED' ? { bedsPerRoom: 4 } : {}),
    });
    expect(parsed.code).toBe('STD');
    expect(parsed.inventoryKind).toBe(inventoryKind);
  });
  it.each([
    { inventoryKind: 'BED' },
    { inventoryKind: 'UNIT', bedsPerRoom: 2 },
    { inventoryKind: 'BED', bedsPerRoom: 0 },
    { inventoryKind: 'BED', bedsPerRoom: 101 },
    { baseAdults: 3, maxAdults: 2 },
    { maxChildren: -1 },
    { organizationId: 'forged' },
    { images: ['javascript:alert(1)'] },
  ])('rejects invalid type configuration %j', (invalid) => {
    expect(hotelRoomTypeCreateInput.safeParse({ ...roomType, ...invalid }).success).toBe(false);
  });
  it('allows cleaning then inspection and requires dirty status after OOO/OOS release', () => {
    expect(inventoryTransitionAllowed('VACANT_DIRTY', 'VACANT_CLEAN')).toBe(true);
    expect(inventoryTransitionAllowed('VACANT_CLEAN', 'INSPECTED')).toBe(true);
    for (const status of ['OUT_OF_ORDER', 'OUT_OF_SERVICE'] as const) {
      expect(inventoryTransitionAllowed(status, 'VACANT_DIRTY')).toBe(true);
      expect(inventoryTransitionAllowed(status, 'INSPECTED')).toBe(false);
      expect(inventoryTransitionAllowed(status, 'VACANT_CLEAN')).toBe(false);
    }
    expect(inventoryTransitionAllowed('VACANT_DIRTY', 'INSPECTED')).toBe(false);
  });
  it('reserves occupancy for future stays and rejects no-op status changes', () => {
    for (const status of HOTEL_INVENTORY_STATUSES) {
      expect(inventoryTransitionAllowed(status, 'OCCUPIED')).toBe(false);
      expect(inventoryTransitionAllowed('OCCUPIED', status)).toBe(false);
      expect(inventoryTransitionAllowed(status, status)).toBe(false);
    }
    expect(
      hotelInventoryStatusInput.safeParse({
        id: 'room_1',
        expectedStatus: 'VACANT_CLEAN',
        status: 'OCCUPIED',
        reason: 'Override',
      }).success
    ).toBe(false);
    expect(
      hotelInventoryStatusInput.safeParse({
        id: 'room_1',
        expectedStatus: 'VACANT_DIRTY',
        status: 'VACANT_CLEAN',
        reason: '  ',
      }).success
    ).toBe(false);
  });
  it.each([
    ['2026-09-12', '2026-09-12'],
    ['2026-09-13', '2026-09-12'],
    ['2026-02-30', '2026-03-02'],
  ])('rejects invalid block range %s to %s', (startDate, endDate) => {
    expect(
      hotelRoomBlockCreateInput.safeParse({
        roomId: 'room_1',
        kind: 'OUT_OF_ORDER',
        startDate,
        endDate,
        reason: 'Repair',
      }).success
    ).toBe(false);
  });
});
