import { z } from 'zod';

import type { EntitlementSnapshot } from '@/lib/module-catalog';

import { evaluateHotelFeatures } from './features';
import { HOTEL_INVENTORY_KINDS, HOTEL_INVENTORY_STATUSES } from './inventory';
import type { HotelModeConfiguration } from './modes';

const id = z
  .string()
  .min(1)
  .max(191)
  .refine((value) => !/\s/.test(value));
const date = z.iso
  .date()
  .length(10)
  .refine((value) => !value.startsWith('0000-'));
const time = z
  .string()
  .length(5)
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const status = z.enum(HOTEL_INVENTORY_STATUSES);
const propertyScope = { organizationId: id, branchId: id };
const typeScope = { ...propertyScope, roomTypeId: id };
const datedScope = { ...typeScope, date };
const slotScope = { ...datedScope, slotTemplateId: id };

const inputSchema = z.strictObject({
  scope: z.strictObject(slotScope),
  template: z.strictObject({
    ...typeScope,
    id,
    active: z.boolean(),
    // Property-local calendar weekdays: Sunday = 0, Saturday = 6.
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).readonly(),
    startTime: time,
    endTime: time,
  }),
  inventory: z.strictObject({
    ...datedScope,
    inventoryKind: z.enum(HOTEL_INVENTORY_KINDS),
    bedsPerRoom: count.min(1).max(100).nullable(),
    roomCount: count,
    rooms: z
      .array(
        z.strictObject({
          ...typeScope,
          id,
          status,
          beds: z.array(z.strictObject({ ...propertyScope, id, roomId: id, status })).readonly(),
        })
      )
      .readonly(),
  }),
  blocks: z.strictObject({
    ...datedScope,
    rows: z
      .array(
        z.strictObject({
          ...propertyScope,
          id,
          roomId: id,
          kind: z.enum(['OUT_OF_ORDER', 'OUT_OF_SERVICE']),
          startDate: date,
          endDate: date,
          releasedAt: z.iso
            .datetime()
            .refine((value) => value === value.trim())
            .nullable(),
        })
      )
      .readonly(),
  }),
  sales: z.strictObject({ ...slotScope, sold: count }),
});

export type DayUseSlotInput = z.infer<typeof inputSchema>;
export type DayUseSlotProjection = DayUseSlotInput['scope'] & {
  billingCycle: 'SLOT';
  startTime: string;
  endTime: string;
  capacity: number;
  sold: number;
  free: number;
};

/**
 * PROP-06 / MODE-04 calculation only: supplied snapshots are neither current
 * database authorization nor transactional sellability proof. The future reader
 * must authorize organization/property access, bind resolved configuration and
 * entitlements to that scope, and supply complete, mutually consistent inventory,
 * block and sold evidence for the requested property-local date and template.
 * roomCount is an independent count, not the length of a paginated room list.
 * BED inventory needs every bed of every room; ROOM/UNIT needs no bed rows.
 * Explicit empty arrays and sold: 0 mean known zero, never missing evidence.
 *
 * Templates are same-day [startTime, endTime) local wall times. Existing
 * HotelRoomBlock rows are whole-date [startDate, endDate) ranges (schema.prisma);
 * they cover every slot on included dates. Intraday blocks are not represented
 * by the current source contract. releasedAt means released in the supplied
 * snapshot, not a request to reconstruct historical state using a present clock.
 *
 * This does not reserve inventory, consume room-nights, resolve other templates,
 * reconcile overnight stays/holds, or permit a sale. Those remain reader and
 * transactional booking gates. No persistence, pricing, API or UI is implied.
 */
export function calculateDayUseSlot(
  input: DayUseSlotInput,
  configuration: HotelModeConfiguration,
  entitlements: EntitlementSnapshot
): DayUseSlotProjection {
  const { scope, template, inventory, blocks, sales } = inputSchema.parse(input);
  // Validate feature-driving values without introducing a second mode resolver.
  z.object({
    inventoryKinds: z.array(z.enum(HOTEL_INVENTORY_KINDS)),
    billingCycles: z.array(z.enum(['NIGHTLY', 'WEEKLY', 'MONTHLY', 'SLOT'])),
    dayUse: z.boolean(),
  }).parse(configuration);
  z.object({
    enabledModules: z.array(id),
    limits: z.record(z.string(), count.optional()),
  }).parse(entitlements);
  if (!evaluateHotelFeatures(configuration, entitlements).dayUse) {
    throw new Error('Day-use SLOT is disabled by property configuration or entitlements.');
  }
  if (!configuration.inventoryKinds.includes(inventory.inventoryKind)) {
    throw new Error('Inventory kind is disabled by property configuration.');
  }

  const assertScope = (value: {
    organizationId: string;
    branchId: string;
    roomTypeId?: string;
    date?: string;
    slotTemplateId?: string;
  }) => {
    for (const key of [
      'organizationId',
      'branchId',
      'roomTypeId',
      'date',
      'slotTemplateId',
    ] as const) {
      if (value[key] !== undefined && value[key] !== scope[key]) {
        throw new Error(`Snapshot scope mismatch: ${key}.`);
      }
    }
  };
  for (const snapshot of [template, inventory, blocks, sales]) assertScope(snapshot);
  if (template.id !== scope.slotTemplateId) throw new Error('Template identity mismatch.');
  if (template.startTime >= template.endTime) {
    throw new Error('Slot end time must follow start time on the same date.');
  }
  if (new Set(template.daysOfWeek).size !== template.daysOfWeek.length) {
    throw new Error('Template weekdays must be unique.');
  }
  const weekday = new Date(`${scope.date}T00:00:00Z`).getUTCDay();
  if (!template.active || !template.daysOfWeek.includes(weekday)) {
    throw new Error('Template is inactive or unavailable on this weekday.');
  }
  if (inventory.roomCount !== inventory.rooms.length) {
    throw new Error('Inventory room count does not match supplied room evidence.');
  }
  const isBed = inventory.inventoryKind === 'BED';
  if (isBed !== (inventory.bedsPerRoom !== null)) {
    throw new Error('Only BED inventory requires bedsPerRoom evidence.');
  }

  const roomIds = new Set<string>();
  const bedIds = new Set<string>();
  for (const room of inventory.rooms) {
    assertScope(room);
    if (roomIds.has(room.id)) throw new Error('Duplicate room evidence.');
    roomIds.add(room.id);
    if (room.beds.length !== (inventory.bedsPerRoom ?? 0)) {
      throw new Error('Bed count does not match inventory kind and bedsPerRoom evidence.');
    }
    for (const bed of room.beds) {
      assertScope(bed);
      if (bed.roomId !== room.id) throw new Error('Bed parent room mismatch.');
      if (bedIds.has(bed.id)) throw new Error('Duplicate bed evidence.');
      bedIds.add(bed.id);
    }
  }

  const blockedRooms = new Set<string>();
  const blockIds = new Set<string>();
  for (const block of blocks.rows) {
    assertScope(block);
    if (!roomIds.has(block.roomId))
      throw new Error('Block room is absent from inventory evidence.');
    if (blockIds.has(block.id)) throw new Error('Duplicate block evidence.');
    blockIds.add(block.id);
    if (block.startDate >= block.endDate) throw new Error('Invalid block date range.');
    if (block.releasedAt === null && block.startDate <= scope.date && scope.date < block.endDate) {
      blockedRooms.add(block.roomId);
    }
  }

  const excluded = (value: string) => value === 'OUT_OF_ORDER' || value === 'OUT_OF_SERVICE';
  let capacity = 0;
  for (const room of inventory.rooms) {
    if (excluded(room.status) || blockedRooms.has(room.id)) continue;
    capacity += isBed ? room.beds.filter((bed) => !excluded(bed.status)).length : 1;
  }
  if (!Number.isSafeInteger(capacity) || sales.sold > capacity) {
    throw new Error('Sold exceeds safe slot capacity.');
  }
  return {
    ...scope,
    billingCycle: 'SLOT',
    startTime: template.startTime,
    endTime: template.endTime,
    capacity,
    sold: sales.sold,
    free: capacity - sales.sold,
  };
}
