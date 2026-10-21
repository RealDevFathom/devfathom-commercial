import { describe, expect, it } from 'vitest';

import {
  HotelGenderPolicy,
  HotelInventoryKind,
  HotelRoomBlockKind,
  HotelRoomStatus,
} from '@/generated/prisma/enums';

import {
  HOTEL_GENDER_POLICIES,
  HOTEL_GENDER_POLICY_LABELS,
  HOTEL_INVENTORY_KINDS,
  HOTEL_INVENTORY_KIND_LABELS,
  HOTEL_INVENTORY_STATUSES,
  HOTEL_ROOM_BLOCK_KINDS,
  HOTEL_ROOM_BLOCK_KIND_LABELS,
  HOTEL_ROOM_STATUSES,
  HOTEL_ROOM_STATUS_LABELS,
  HOTEL_ROOM_TRANSITIONS,
  HOUSEKEEPING_ROOM_STATUSES,
  deriveBedOccupancy,
  hotelInventoryStatusInput,
  hotelRoomCreateInput,
  hotelRoomTypeCreateInput,
  hotelRoomBlockCreateInput,
  inventoryTransitionAllowed,
  planRoomStatusChange,
  roomIsOccupied,
  sellableUnitsOf,
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

describe('inventory vocabulary', () => {
  it('spells every generated enum value exactly once, with an operator-facing name', () => {
    expect([...HOTEL_INVENTORY_KINDS].sort()).toEqual(Object.values(HotelInventoryKind).sort());
    expect([...HOTEL_ROOM_STATUSES].sort()).toEqual(Object.values(HotelRoomStatus).sort());
    expect([...HOTEL_ROOM_BLOCK_KINDS].sort()).toEqual(Object.values(HotelRoomBlockKind).sort());
    expect([...HOTEL_GENDER_POLICIES].sort()).toEqual(Object.values(HotelGenderPolicy).sort());
    for (const kind of HOTEL_INVENTORY_KINDS)
      expect(HOTEL_INVENTORY_KIND_LABELS[kind]).not.toBe(kind);
    for (const status of HOTEL_ROOM_STATUSES) {
      expect(HOTEL_ROOM_STATUS_LABELS[status]).not.toBe(status);
      expect(Object.keys(HOTEL_ROOM_TRANSITIONS)).toContain(status);
    }
    for (const kind of HOTEL_ROOM_BLOCK_KINDS)
      expect(HOTEL_ROOM_BLOCK_KIND_LABELS[kind]).not.toBe(kind);
    for (const policy of HOTEL_GENDER_POLICIES)
      expect(HOTEL_GENDER_POLICY_LABELS[policy]).not.toBe(policy);
    // The board statuses are the six minus the stay-owned one.
    expect([...HOTEL_INVENTORY_STATUSES].sort()).toEqual(
      HOTEL_ROOM_STATUSES.filter((status) => status !== 'OCCUPIED').sort()
    );
    expect(
      HOUSEKEEPING_ROOM_STATUSES.every((status) =>
        (HOTEL_INVENTORY_STATUSES as readonly string[]).includes(status)
      )
    ).toBe(true);
  });
  it('accepts a dorm policy only through the enum and a room number of bounded length', () => {
    const room = { roomTypeId: 'type_1', number: '101', reason: 'Commissioned' };
    expect(hotelRoomCreateInput.parse(room).genderPolicy).toBe('ANY');
    expect(hotelRoomCreateInput.parse({ ...room, genderPolicy: 'FEMALE' }).genderPolicy).toBe(
      'FEMALE'
    );
    expect(hotelRoomCreateInput.safeParse({ ...room, genderPolicy: 'FEMALE_ONLY' }).success).toBe(
      false
    );
    expect(hotelRoomCreateInput.safeParse({ ...room, number: 'x'.repeat(33) }).success).toBe(false);
    expect(hotelRoomCreateInput.safeParse({ ...room, reason: '   ' }).success).toBe(false);
    expect(hotelRoomCreateInput.safeParse({ ...room, branchId: 'forged' }).success).toBe(false);
  });
  it('keeps a work-order reference optional and trimmed on a block', () => {
    const block = {
      roomId: 'room_1',
      kind: 'OUT_OF_SERVICE',
      startDate: '2026-09-12',
      endDate: '2026-09-14',
      reason: 'Refurbishment',
    };
    expect(hotelRoomBlockCreateInput.parse(block).workOrderRef).toBeUndefined();
    expect(hotelRoomBlockCreateInput.parse({ ...block, workOrderRef: ' WO-7 ' }).workOrderRef).toBe(
      'WO-7'
    );
    expect(hotelRoomBlockCreateInput.safeParse({ ...block, kind: 'VACANT_DIRTY' }).success).toBe(
      false
    );
  });
});

describe('planRoomStatusChange', () => {
  const actor = { actorId: 'user_1', reason: '  Cleaned after checkout  ' };
  it('walks the matrix: every legal pair plans an attributed event, every other pair is refused', () => {
    for (const from of HOTEL_ROOM_STATUSES) {
      for (const to of HOTEL_ROOM_STATUSES) {
        const outcome = planRoomStatusChange({ from, to, ...actor });
        if (from === to) expect(outcome).toMatchObject({ ok: false, code: 'UNCHANGED' });
        else if (from === 'OCCUPIED' || to === 'OCCUPIED')
          expect(outcome).toMatchObject({ ok: false, code: 'STAY_OWNED' });
        else if (inventoryTransitionAllowed(from, to))
          expect(outcome).toEqual({
            ok: true,
            from,
            to,
            event: {
              fromStatus: from,
              toStatus: to,
              actorId: 'user_1',
              reason: 'Cleaned after checkout',
            },
          });
        else expect(outcome).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
      }
    }
  });
  it('names the front-desk action instead of calling a stay-owned move illegal', () => {
    expect(planRoomStatusChange({ from: 'VACANT_CLEAN', to: 'OCCUPIED', ...actor })).toMatchObject({
      code: 'STAY_OWNED',
      message: expect.stringContaining('Check the guest in'),
    });
    expect(planRoomStatusChange({ from: 'OCCUPIED', to: 'VACANT_DIRTY', ...actor })).toMatchObject({
      code: 'STAY_OWNED',
      message: expect.stringContaining('checking the guest out'),
    });
  });
  it('confines housekeeping to its own statuses while a property administrator keeps the matrix', () => {
    const withheld = planRoomStatusChange({
      from: 'VACANT_DIRTY',
      to: 'OUT_OF_ORDER',
      ...actor,
      allowed: HOUSEKEEPING_ROOM_STATUSES,
    });
    expect(withheld).toMatchObject({ ok: false, code: 'NOT_PERMITTED' });
    expect((withheld as { message: string }).message).toContain('vacant, clean');
    expect(
      planRoomStatusChange({
        from: 'VACANT_DIRTY',
        to: 'VACANT_CLEAN',
        ...actor,
        allowed: HOUSEKEEPING_ROOM_STATUSES,
      })
    ).toMatchObject({ ok: true });
    expect(
      planRoomStatusChange({ from: 'VACANT_DIRTY', to: 'OUT_OF_ORDER', ...actor })
    ).toMatchObject({
      ok: true,
    });
  });
});

describe('derived occupancy', () => {
  const bed = (status: (typeof HOTEL_ROOM_STATUSES)[number], active = true) => ({ status, active });
  it('counts beds rather than reading a stored number, ignoring retired beds', () => {
    expect(
      deriveBedOccupancy([
        bed('OCCUPIED'),
        bed('VACANT_CLEAN'),
        bed('OUT_OF_ORDER'),
        bed('INSPECTED', false),
      ])
    ).toEqual({ total: 4, active: 3, occupied: 1, sellable: 1, outOfService: 1 });
    expect(deriveBedOccupancy([])).toEqual({
      total: 0,
      active: 0,
      occupied: 0,
      sellable: 0,
      outOfService: 0,
    });
  });
  it('reads a dorm room as occupied when any berth is, and a whole room from its own status', () => {
    expect(
      roomIsOccupied({ inventoryKind: 'BED', status: 'VACANT_CLEAN', beds: [bed('OCCUPIED')] })
    ).toBe(true);
    expect(
      roomIsOccupied({ inventoryKind: 'BED', status: 'OCCUPIED', beds: [bed('VACANT_CLEAN')] })
    ).toBe(false);
    expect(roomIsOccupied({ inventoryKind: 'ROOM', status: 'OCCUPIED' })).toBe(true);
    expect(roomIsOccupied({ inventoryKind: 'UNIT', status: 'INSPECTED' })).toBe(false);
  });
  it('meters the room ceiling in sellable units: one per room or unit, a berth per bed', () => {
    expect(sellableUnitsOf({ inventoryKind: 'ROOM', bedsPerRoom: null })).toBe(1);
    expect(sellableUnitsOf({ inventoryKind: 'UNIT', bedsPerRoom: null })).toBe(1);
    expect(sellableUnitsOf({ inventoryKind: 'BED', bedsPerRoom: 6 })).toBe(6);
  });
});
