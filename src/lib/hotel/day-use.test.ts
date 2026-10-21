import { describe, expect, it } from 'vitest';

import type { EntitlementSnapshot } from '@/lib/module-catalog';

import { calculateDayUseSlot, type DayUseSlotInput } from './day-use';
import { applyHotelModeDefaults, type HotelModeConfiguration } from './modes';

const property = { organizationId: 'org-a', branchId: 'property-a' };
const roomType = { ...property, roomTypeId: 'type-a' };
const dated = { ...roomType, date: '2026-09-15' }; // Tuesday.
const scope = { ...dated, slotTemplateId: 'slot-a' };
const configuration = applyHotelModeDefaults('HOTEL');
const entitlements = {
  enabledModules: ['hotel-core', 'hotel-reservations'],
  limits: { 'hotel.rooms.max': 10 },
};

function fixture(): DayUseSlotInput {
  return {
    scope: { ...scope },
    template: {
      ...roomType,
      id: 'slot-a',
      active: true,
      daysOfWeek: [2],
      startTime: '09:00',
      endTime: '18:00',
    },
    inventory: {
      ...dated,
      inventoryKind: 'ROOM',
      bedsPerRoom: null,
      roomCount: 3,
      rooms: [
        { ...roomType, id: 'room-a', status: 'VACANT_CLEAN', beds: [] },
        { ...roomType, id: 'room-b', status: 'VACANT_DIRTY', beds: [] },
        { ...roomType, id: 'room-c', status: 'INSPECTED', beds: [] },
      ],
    },
    blocks: { ...dated, rows: [] },
    sales: { ...scope, sold: 1 },
  };
}

function block(
  overrides: Partial<DayUseSlotInput['blocks']['rows'][number]> = {}
): DayUseSlotInput['blocks']['rows'][number] {
  return {
    ...property,
    id: 'block-a',
    roomId: 'room-a',
    kind: 'OUT_OF_ORDER',
    startDate: '2026-09-15',
    endDate: '2026-09-16',
    releasedAt: null,
    ...overrides,
  };
}

function bedFixture(): DayUseSlotInput {
  const input = fixture();
  input.inventory.inventoryKind = 'BED';
  input.inventory.bedsPerRoom = 2;
  input.inventory.rooms = input.inventory.rooms.map((room) => ({
    ...room,
    beds: [1, 2].map((number) => ({
      ...property,
      id: `${room.id}-bed-${number}`,
      roomId: room.id,
      status: 'VACANT_CLEAN',
    })),
  }));
  return input;
}

const bedConfiguration = {
  ...configuration,
  inventoryKinds: ['BED'],
} satisfies HotelModeConfiguration;
const project = (input = fixture(), policy = configuration) =>
  calculateDayUseSlot(input, policy, entitlements);

describe('day-use SLOT snapshot calculation', () => {
  it('projects scoped room capacity, sold and free without room-night fields', () => {
    expect(project()).toEqual({
      ...scope,
      billingCycle: 'SLOT',
      startTime: '09:00',
      endTime: '18:00',
      capacity: 3,
      sold: 1,
      free: 2,
    });
  });

  it('accepts explicit zero inventory and zero sales', () => {
    const input = fixture();
    input.inventory.rooms = [];
    input.inventory.roomCount = 0;
    input.sales.sold = 0;
    expect(project(input)).toMatchObject({ capacity: 0, sold: 0, free: 0 });
  });

  it('returns zero free for a sold-out slot', () => {
    const input = fixture();
    input.sales.sold = 3;
    expect(project(input)).toMatchObject({ capacity: 3, sold: 3, free: 0 });
  });

  it.each(['OUT_OF_ORDER', 'OUT_OF_SERVICE'] as const)('excludes %s rooms', (status) => {
    const input = fixture();
    input.inventory.rooms[0].status = status;
    expect(project(input)).toMatchObject({ capacity: 2, sold: 1, free: 1 });
  });

  it.each([
    ['start date included', '2026-09-15', '2026-09-16', null, 2],
    ['spanning date included', '2026-09-14', '2026-09-17', null, 2],
    ['end date excluded', '2026-09-14', '2026-09-15', null, 3],
    ['earlier range excluded', '2026-09-12', '2026-09-14', null, 3],
    ['later range excluded', '2026-09-16', '2026-09-17', null, 3],
    ['released range excluded', '2026-09-15', '2026-09-16', '2026-09-15T08:00:00Z', 3],
  ] as const)('%s', (_, startDate, endDate, releasedAt, capacity) => {
    const input = fixture();
    input.blocks.rows = [block({ startDate, endDate, releasedAt })];
    expect(project(input)).toMatchObject({ capacity, sold: 1, free: capacity - 1 });
  });

  it('applies whole-date blocks to a slot starting at midnight', () => {
    const input = fixture();
    input.template.startTime = '00:00';
    input.template.endTime = '00:01';
    input.blocks.rows = [block()];
    expect(project(input).capacity).toBe(2);
  });

  it('counts status and multiple overlapping blocks on one physical room only once', () => {
    const input = fixture();
    input.inventory.rooms[0].status = 'OUT_OF_ORDER';
    input.blocks.rows = [
      block(),
      block({ id: 'block-b', kind: 'OUT_OF_SERVICE' }),
      block({ id: 'block-c', startDate: '2026-09-14' }),
    ];
    expect(project(input)).toMatchObject({ capacity: 2, free: 1 });
  });

  it('counts UNIT rows once when configuration allows them', () => {
    const input = fixture();
    input.inventory.inventoryKind = 'UNIT';
    expect(project(input, { ...configuration, inventoryKinds: ['UNIT'] }).capacity).toBe(3);
  });

  it('counts actual beds, excluding bed status and room blocks without double subtraction', () => {
    const input = bedFixture();
    input.inventory.rooms[0].beds[0].status = 'OUT_OF_ORDER';
    input.inventory.rooms[1].beds[0].status = 'OUT_OF_SERVICE';
    input.blocks.rows = [block(), block({ id: 'block-b', kind: 'OUT_OF_SERVICE' })];
    expect(project(input, bedConfiguration)).toMatchObject({ capacity: 3, sold: 1, free: 2 });
  });

  it.each(['OUT_OF_ORDER', 'OUT_OF_SERVICE'] as const)(
    'excludes all beds in a %s room',
    (status) => {
      const input = bedFixture();
      input.inventory.rooms[0].status = status;
      expect(project(input, bedConfiguration).capacity).toBe(4);
    }
  );

  it.each(['HOTEL', 'HOSTEL', 'APARTMENT', 'RESORT', 'VENUE'] as const)(
    'uses explicit feature grants for %s without a mode-name restriction',
    (mode) => {
      expect(project(fixture(), applyHotelModeDefaults(mode, configuration)).capacity).toBe(3);
    }
  );

  it.each([
    ['day-use disabled', { ...configuration, dayUse: false }],
    ['SLOT disabled', { ...configuration, billingCycles: ['NIGHTLY'] }],
    ['inventory disabled', { ...configuration, inventoryKinds: [] }],
  ] satisfies [string, HotelModeConfiguration][])('denies %s', (_, policy) => {
    expect(() => project(fixture(), policy)).toThrow('Day-use SLOT is disabled');
  });

  it('rejects a room type outside configured inventory kinds', () => {
    expect(() => project(fixture(), bedConfiguration)).toThrow('Inventory kind is disabled');
  });

  it.each<EntitlementSnapshot>([
    { enabledModules: [], limits: { 'hotel.rooms.max': 10 } },
    { enabledModules: ['hotel-core'], limits: { 'hotel.rooms.max': 10 } },
    { enabledModules: ['hotel-reservations'], limits: { 'hotel.rooms.max': 10 } },
    { ...entitlements, limits: {} },
    { ...entitlements, limits: { 'hotel.rooms.max': 0 } },
  ])('denies missing module/limit grants %#', (grants) => {
    expect(() => calculateDayUseSlot(fixture(), configuration, grants)).toThrow(
      'Day-use SLOT is disabled'
    );
  });

  it.each([NaN, Infinity, -1, 0.5])('rejects malformed entitlement limit %s', (limit) => {
    expect(() =>
      calculateDayUseSlot(fixture(), configuration, {
        ...entitlements,
        limits: { 'hotel.rooms.max': limit },
      })
    ).toThrow();
  });

  it('rejects truthy non-boolean day-use configuration', () => {
    const policy = { ...configuration, dayUse: 'yes' };
    expect(() => project(fixture(), policy as unknown as HotelModeConfiguration)).toThrow();
  });

  it.each([
    ['inactive', { active: false }],
    ['wrong weekday', { daysOfWeek: [1, 3] }],
    ['empty weekdays', { daysOfWeek: [] }],
    ['duplicate weekdays', { daysOfWeek: [2, 2] }],
    ['invalid weekday', { daysOfWeek: [7] }],
    ['fractional weekday', { daysOfWeek: [2.5] }],
    ['equal times', { startTime: '09:00', endTime: '09:00' }],
    ['overnight', { startTime: '18:00', endTime: '09:00' }],
    ['invalid hour', { startTime: '24:00' }],
    ['invalid minute', { endTime: '18:60' }],
    ['noncanonical time', { startTime: '9:00' }],
    ['seconds unsupported', { startTime: '09:00:00' }],
    ['trailing newline', { startTime: '09:00\n' }],
  ] satisfies [string, Partial<DayUseSlotInput['template']>][])(
    'rejects %s template',
    (_, patch) => {
      const input = fixture();
      Object.assign(input.template, patch);
      expect(() => project(input)).toThrow();
    }
  );

  it.each([
    '2026-02-30',
    '2025-02-29',
    '2026-13-01',
    '2026-9-15',
    '2026-09-15T00:00:00Z',
    '0000-01-01',
    '2026-09-15\n',
  ])('rejects invalid or noncanonical date %s', (date) => {
    const input = fixture();
    for (const snapshot of [input.scope, input.inventory, input.blocks, input.sales])
      snapshot.date = date;
    expect(() => project(input)).toThrow();
  });

  it('uses the explicit calendar date for leap-day weekday evaluation', () => {
    const input = fixture();
    for (const snapshot of [input.scope, input.inventory, input.blocks, input.sales])
      snapshot.date = '2024-02-29';
    input.template.daysOfWeek = [4];
    expect(project(input).capacity).toBe(3);
    input.template.daysOfWeek = [3];
    expect(() => project(input)).toThrow('weekday');
  });

  it('does not depend on the host timezone', () => {
    const original = process.env.TZ;
    try {
      const results = ['Pacific/Honolulu', 'Pacific/Kiritimati'].map((timezone) => {
        process.env.TZ = timezone;
        return project();
      });
      expect(results[0]).toEqual(results[1]);
      expect(results[0].capacity).toBe(3);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it.each(['template', 'inventory', 'blocks', 'sales'] as const)(
    'rejects every scope mismatch in %s evidence',
    (key) => {
      for (const field of ['organizationId', 'branchId', 'roomTypeId'] as const) {
        const input = fixture();
        input[key][field] = 'wrong-scope';
        expect(() => project(input)).toThrow(`Snapshot scope mismatch: ${field}`);
      }
    }
  );

  it.each(['inventory', 'blocks', 'sales'] as const)('rejects wrong date in %s', (key) => {
    const input = fixture();
    input[key].date = '2026-09-16';
    expect(() => project(input)).toThrow('Snapshot scope mismatch: date');
  });

  it('rejects mismatched template and sale identities', () => {
    const input = fixture();
    input.template.id = 'other-slot';
    expect(() => project(input)).toThrow('Template identity mismatch');
    input.template.id = scope.slotTemplateId;
    input.sales.slotTemplateId = 'other-slot';
    expect(() => project(input)).toThrow('Snapshot scope mismatch: slotTemplateId');
  });

  it.each(['', ' ', ' room-a', 'room a', 'room-a\n'])(
    'rejects invalid physical identity %j',
    (id) => {
      const input = fixture();
      input.inventory.rooms[0].id = id;
      expect(() => project(input)).toThrow();
    }
  );

  it('rejects mismatched scope inside room, bed and block rows', () => {
    for (const field of ['organizationId', 'branchId', 'roomTypeId'] as const) {
      const input = fixture();
      input.inventory.rooms[0][field] = 'other';
      expect(() => project(input)).toThrow('Snapshot scope mismatch');
    }
    for (const field of ['organizationId', 'branchId'] as const) {
      const input = bedFixture();
      input.inventory.rooms[0].beds[0][field] = 'other';
      expect(() => project(input, bedConfiguration)).toThrow('Snapshot scope mismatch');
      const withBlock = fixture();
      withBlock.blocks.rows = [block({ [field]: 'other' })];
      expect(() => project(withBlock)).toThrow('Snapshot scope mismatch');
    }
  });

  it.each(['inventory', 'blocks', 'sales', 'template', 'scope'] as const)(
    'rejects missing %s snapshot',
    (key) => {
      const input = fixture();
      Reflect.deleteProperty(input, key);
      expect(() => project(input)).toThrow();
    }
  );

  it.each(['rooms', 'roomCount', 'bedsPerRoom'] as const)(
    'rejects missing inventory %s evidence',
    (key) => {
      const input = fixture();
      Reflect.deleteProperty(input.inventory, key);
      expect(() => project(input)).toThrow();
    }
  );

  it('rejects missing block rows and sold evidence', () => {
    const input = fixture();
    Reflect.deleteProperty(input.blocks, 'rows');
    expect(() => project(input)).toThrow();
    input.blocks.rows = [];
    Reflect.deleteProperty(input.sales, 'sold');
    expect(() => project(input)).toThrow();
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid quantity %s',
    (quantity) => {
      const input = fixture();
      input.sales.sold = quantity;
      expect(() => project(input)).toThrow();
      input.sales.sold = 0;
      input.inventory.roomCount = quantity;
      expect(() => project(input)).toThrow();
    }
  );

  it('does not coerce string sales counts', () => {
    const input = fixture();
    Object.assign(input.sales, { sold: '1' });
    expect(() => project(input)).toThrow();
  });

  it('rejects a partial inventory list, duplicate rooms and duplicate block evidence', () => {
    const input = fixture();
    input.inventory.rooms = input.inventory.rooms.slice(1);
    expect(() => project(input)).toThrow('Inventory room count');
    input.inventory.roomCount = 2;
    input.inventory.rooms = [input.inventory.rooms[0], input.inventory.rooms[0]];
    expect(() => project(input)).toThrow('Duplicate room evidence');
    const withBlocks = fixture();
    withBlocks.blocks.rows = [block(), block()];
    expect(() => project(withBlocks)).toThrow('Duplicate block evidence');
  });

  it('rejects unknown block rooms even for released blocks', () => {
    const input = fixture();
    input.blocks.rows = [block({ roomId: 'unknown', releasedAt: '2026-09-15T08:00:00Z' })];
    expect(() => project(input)).toThrow('Block room is absent');
  });

  it.each([
    { startDate: '2026-09-16', endDate: '2026-09-15' },
    { startDate: '2026-09-15', endDate: '2026-09-15' },
    { startDate: '2026-02-30' },
    { releasedAt: 'yesterday' },
    { releasedAt: '2026-02-30T08:00:00Z' },
    { releasedAt: '2026-09-15T08:00:00Z\n' },
  ])('rejects invalid block dates/release evidence %#', (patch) => {
    const input = fixture();
    input.blocks.rows = [block(patch)];
    expect(() => project(input)).toThrow();
  });

  it('rejects unsupported room status and block kind instead of counting them', () => {
    const input = fixture();
    Object.assign(input.inventory.rooms[0], { status: 'OCCUPIED' });
    expect(() => project(input)).toThrow();
    input.inventory.rooms[0].status = 'VACANT_CLEAN';
    input.blocks.rows = [block()];
    Object.assign(input.blocks.rows[0], { kind: 'VACANT_CLEAN' });
    expect(() => project(input)).toThrow();
  });

  it('rejects intraday block fields absent from the current inventory contract', () => {
    const input = fixture();
    input.blocks.rows = [block()];
    Object.assign(input.blocks.rows[0], { startTime: '12:00', endTime: '13:00' });
    expect(() => project(input)).toThrow();
  });

  it('rejects incomplete, duplicate and mis-parented bed evidence', () => {
    const input = bedFixture();
    input.inventory.rooms[0].beds = input.inventory.rooms[0].beds.slice(1);
    expect(() => project(input, bedConfiguration)).toThrow('Bed count');
    const duplicate = bedFixture();
    duplicate.inventory.rooms[1].beds[0].id = duplicate.inventory.rooms[0].beds[0].id;
    expect(() => project(duplicate, bedConfiguration)).toThrow('Duplicate bed evidence');
    const wrongParent = bedFixture();
    wrongParent.inventory.rooms[0].beds[0].roomId = 'room-b';
    expect(() => project(wrongParent, bedConfiguration)).toThrow('Bed parent room mismatch');
  });

  it('rejects inconsistent inventory-kind evidence', () => {
    const input = bedFixture();
    input.inventory.bedsPerRoom = null;
    expect(() => project(input, bedConfiguration)).toThrow('Only BED inventory');
    const rooms = fixture();
    rooms.inventory.bedsPerRoom = 2;
    expect(() => project(rooms)).toThrow('Only BED inventory');
    rooms.inventory.bedsPerRoom = null;
    rooms.inventory.rooms[0].beds = bedFixture().inventory.rooms[0].beds;
    expect(() => project(rooms)).toThrow('Bed count');
  });

  it('rejects sales exceeding capacity after exclusions without clamping', () => {
    const input = fixture();
    input.sales.sold = 3;
    input.blocks.rows = [block()];
    expect(() => project(input)).toThrow('Sold exceeds safe slot capacity');
  });

  it('leaves deeply frozen caller inputs unchanged and returns detached data', () => {
    function freeze(value: object): void {
      for (const child of Object.values(value)) {
        if (child !== null && typeof child === 'object') freeze(child);
      }
      Object.freeze(value);
    }
    const input = bedFixture();
    input.blocks.rows = [block()];
    const policy = applyHotelModeDefaults('HOSTEL', { dayUse: true, billingCycles: ['SLOT'] });
    const grants = structuredClone(entitlements);
    const before = structuredClone({ input, policy, grants });
    for (const value of [input, policy, grants]) freeze(value);
    const result = calculateDayUseSlot(input, policy, grants);
    expect(result).toMatchObject({ capacity: 4, sold: 1, free: 3 });
    expect(calculateDayUseSlot(input, policy, grants)).toEqual(result);
    result.date = '2000-01-01';
    expect({ input, policy, grants }).toEqual(before);
  });
});
