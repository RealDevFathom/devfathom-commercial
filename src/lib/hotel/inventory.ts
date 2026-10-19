import { z } from 'zod';

import type { PrismaClient } from '@/generated/prisma/client';

/** Consumer contracts do not require importing the generated client at runtime. */
export const HOTEL_INVENTORY_KINDS = ['ROOM', 'BED', 'UNIT'] as const;
export const HOTEL_INVENTORY_STATUSES = [
  'VACANT_CLEAN',
  'VACANT_DIRTY',
  'INSPECTED',
  'OUT_OF_ORDER',
  'OUT_OF_SERVICE',
] as const;
export type HotelInventoryKind = (typeof HOTEL_INVENTORY_KINDS)[number];
export type HotelInventoryStatus = (typeof HOTEL_INVENTORY_STATUSES)[number];
export type HotelRoomStatusValue = HotelInventoryStatus | 'OCCUPIED';
export type HotelInventoryScope = { organizationId: string; branchId: string; actorId: string };

const transitions: Record<HotelRoomStatusValue, readonly HotelInventoryStatus[]> = {
  VACANT_DIRTY: ['VACANT_CLEAN', 'OUT_OF_ORDER', 'OUT_OF_SERVICE'],
  VACANT_CLEAN: ['VACANT_DIRTY', 'INSPECTED', 'OUT_OF_ORDER', 'OUT_OF_SERVICE'],
  INSPECTED: ['VACANT_DIRTY', 'OUT_OF_ORDER', 'OUT_OF_SERVICE'],
  OUT_OF_ORDER: ['VACANT_DIRTY', 'OUT_OF_SERVICE'],
  OUT_OF_SERVICE: ['VACANT_DIRTY', 'OUT_OF_ORDER'],
  OCCUPIED: [],
};

export function inventoryTransitionAllowed(from: HotelRoomStatusValue, to: HotelRoomStatusValue) {
  return (transitions[from] as readonly string[]).includes(to);
}

const id = z.string().trim().min(1).max(191);
const reason = z.string().trim().min(1).max(500);
const shortText = z.string().trim().min(1).max(160);
const status = z.enum(HOTEL_INVENTORY_STATUSES);
export const hotelRoomTypeCreateInput = z
  .strictObject({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/),
    name: shortText,
    nameUr: shortText.optional(),
    inventoryKind: z.enum(HOTEL_INVENTORY_KINDS),
    bedsPerRoom: z.number().int().min(1).max(100).optional(),
    description: z.string().trim().max(4000).optional(),
    baseAdults: z.number().int().min(1).max(100),
    maxAdults: z.number().int().min(1).max(100),
    maxChildren: z.number().int().min(0).max(100),
    bedConfig: shortText.optional(),
    amenities: z.array(shortText).max(100).default([]),
    images: z
      .array(z.url({ protocol: /^https$/ }).max(2048))
      .max(20)
      .default([]),
    upgradeRank: z.number().int().min(0).default(0),
    sort: z.number().int().min(0).default(0),
  })
  .refine((value) => value.maxAdults >= value.baseAdults, {
    message: 'Maximum adults must include base adults.',
    path: ['maxAdults'],
  })
  .refine((value) => (value.inventoryKind === 'BED') === (value.bedsPerRoom !== undefined), {
    message: 'Only BED inventory requires beds per room.',
    path: ['bedsPerRoom'],
  });
export const hotelRoomCreateInput = z.strictObject({
  roomTypeId: id,
  number: z.string().trim().min(1).max(32),
  floor: shortText.optional(),
  features: z.array(shortText).max(100).default([]),
  connectingRoomId: id.optional(),
  genderPolicy: z.enum(['MIXED', 'FEMALE_ONLY', 'MALE_ONLY']).optional(),
  reason,
});
export const hotelInventoryIdInput = z.strictObject({ id });
export const hotelInventoryRoomInput = z.strictObject({ roomId: id });
export const hotelInventoryStatusInput = z.strictObject({
  id,
  expectedStatus: status,
  status,
  reason,
});
const date = z.iso.date();
export const hotelRoomBlockCreateInput = z
  .strictObject({
    roomId: id,
    kind: z.enum(['OUT_OF_ORDER', 'OUT_OF_SERVICE']),
    startDate: date,
    endDate: date,
    reason,
  })
  .refine((value) => value.startDate < value.endDate, {
    message: 'Block end date must follow its start date.',
    path: ['endDate'],
  });
export const hotelRoomBlockReleaseInput = z.strictObject({ id, reason });
export type HotelRoomTypeCreateInput = z.infer<typeof hotelRoomTypeCreateInput>;
export type HotelRoomCreateInput = z.infer<typeof hotelRoomCreateInput>;
export type HotelInventoryStatusInput = z.infer<typeof hotelInventoryStatusInput>;
export type HotelRoomBlockCreateInput = z.infer<typeof hotelRoomBlockCreateInput>;

export class HotelInventoryError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST',
    message: string
  ) {
    super(message);
  }
}

/** Call on a tenant client. Errors must escape the owning transaction. */
export function withHotelInventory<T>(
  db: PrismaClient,
  scope: HotelInventoryScope,
  changeReason: string,
  run: (tx: PrismaClient) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_branch_id', ${scope.branchId}, true),
      set_config('app.current_user_id', ${scope.actorId}, true),
      set_config('app.hotel_inventory_reason', ${changeReason}, true)`;
    return run(tx as PrismaClient);
  });
}

export function inventoryWhere(scope: HotelInventoryScope) {
  return { organizationId: scope.organizationId, branchId: scope.branchId };
}

export async function createInventoryRoom(
  db: PrismaClient,
  scope: HotelInventoryScope,
  input: HotelRoomCreateInput
) {
  const where = inventoryWhere(scope);
  const roomType = await db.hotelRoomType.findFirst({ where: { ...where, id: input.roomTypeId } });
  if (!roomType) throw new HotelInventoryError('NOT_FOUND', 'Room type not found.');
  if (
    input.connectingRoomId &&
    !(await db.hotelRoom.findFirst({ where: { ...where, id: input.connectingRoomId } }))
  ) {
    throw new HotelInventoryError('NOT_FOUND', 'Connecting room not found.');
  }
  if (input.genderPolicy && roomType.inventoryKind !== 'BED') {
    throw new HotelInventoryError('BAD_REQUEST', 'Gender policy requires BED inventory.');
  }
  const room = await db.hotelRoom.create({
    data: {
      ...where,
      roomTypeId: input.roomTypeId,
      number: input.number,
      floor: input.floor,
      features: input.features,
      connectingRoomId: input.connectingRoomId,
      genderPolicy: input.genderPolicy,
      statusChangedBy: scope.actorId,
    },
  });
  if (roomType.inventoryKind === 'BED') {
    await db.hotelBed.createMany({
      data: Array.from({ length: roomType.bedsPerRoom! }, (_, index) => ({
        ...where,
        roomId: room.id,
        label: String(index + 1),
        statusChangedBy: scope.actorId,
      })),
    });
  }
  return db.hotelRoom.findFirstOrThrow({
    where: { ...where, id: room.id },
    include: { beds: { orderBy: { label: 'asc' } } },
  });
}

export async function setInventoryStatus(
  db: PrismaClient,
  scope: HotelInventoryScope,
  target: 'room' | 'bed',
  input: HotelInventoryStatusInput
) {
  if (!inventoryTransitionAllowed(input.expectedStatus, input.status)) {
    throw new HotelInventoryError('BAD_REQUEST', 'Invalid inventory status transition.');
  }
  const where = { ...inventoryWhere(scope), id: input.id };
  const row =
    target === 'room'
      ? await db.hotelRoom.findFirst({ where })
      : await db.hotelBed.findFirst({ where });
  if (!row) throw new HotelInventoryError('NOT_FOUND', 'Inventory item not found.');
  if (row.status !== input.expectedStatus)
    throw new HotelInventoryError('CONFLICT', 'Inventory status changed. Reload before retrying.');
  const args = {
    where: { ...where, status: input.expectedStatus },
    data: { status: input.status },
  };
  const updated =
    target === 'room' ? await db.hotelRoom.updateMany(args) : await db.hotelBed.updateMany(args);
  if (updated.count !== 1)
    throw new HotelInventoryError('CONFLICT', 'Inventory status changed. Reload before retrying.');
  return { id: input.id, status: input.status };
}

export async function createInventoryBlock(
  db: PrismaClient,
  scope: HotelInventoryScope,
  input: HotelRoomBlockCreateInput
) {
  const where = inventoryWhere(scope);
  if (!(await db.hotelRoom.findFirst({ where: { ...where, id: input.roomId } }))) {
    throw new HotelInventoryError('NOT_FOUND', 'Room not found.');
  }
  return db.hotelRoomBlock.create({
    data: {
      ...input,
      ...where,
      startDate: new Date(input.startDate),
      endDate: new Date(input.endDate),
      createdBy: scope.actorId,
    },
  });
}

export async function releaseInventoryBlock(
  db: PrismaClient,
  scope: HotelInventoryScope,
  input: z.infer<typeof hotelRoomBlockReleaseInput>
) {
  const where = { ...inventoryWhere(scope), id: input.id };
  const block = await db.hotelRoomBlock.findFirst({ where });
  if (!block) throw new HotelInventoryError('NOT_FOUND', 'Room block not found.');
  if (block.releasedAt) return block; // Retried release retains the first actor and reason.
  const updated = await db.hotelRoomBlock.updateMany({
    where: { ...where, releasedAt: null },
    data: { releasedAt: new Date(), releasedBy: scope.actorId, releaseReason: input.reason },
  });
  if (updated.count !== 1)
    throw new HotelInventoryError('CONFLICT', 'Room block changed. Reload before retrying.');
  return db.hotelRoomBlock.findFirstOrThrow({ where });
}
