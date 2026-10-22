import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { z } from 'zod';

export const HOUSEKEEPING_STATUSES = ['CLEAN', 'DIRTY', 'INSPECTED', 'OUT_OF_ORDER'] as const;
export type HousekeepingStatus = (typeof HOUSEKEEPING_STATUSES)[number];
export const HOUSEKEEPING_TASK_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type HousekeepingTaskStatus = (typeof HOUSEKEEPING_TASK_STATUSES)[number];

export const housekeepingBranchInput = z
  .object({ branchId: z.string().trim().min(1).max(128) })
  .strict();
export const housekeepingStatusInput = housekeepingBranchInput
  .extend({
    roomId: z.string().trim().min(1).max(191),
    status: z.enum(HOUSEKEEPING_STATUSES),
  })
  .strict();
export const housekeepingTaskCreateInput = housekeepingBranchInput
  .extend({
    roomId: z.string().trim().min(1).max(191),
    title: z.string().trim().min(1).max(160),
    notes: z.string().trim().max(2000).nullable().optional(),
    assignedToId: z.string().trim().min(1).max(191).nullable().optional(),
  })
  .strict();
export const housekeepingTaskUpdateInput = housekeepingBranchInput
  .extend({
    taskId: z.string().trim().min(1).max(191),
    status: z.enum(HOUSEKEEPING_TASK_STATUSES),
  })
  .strict();

const TRANSITIONS: Record<HousekeepingStatus, readonly HousekeepingStatus[]> = {
  DIRTY: ['CLEAN', 'OUT_OF_ORDER'],
  CLEAN: ['DIRTY', 'INSPECTED', 'OUT_OF_ORDER'],
  INSPECTED: ['DIRTY', 'OUT_OF_ORDER'],
  OUT_OF_ORDER: ['DIRTY'],
};
const TASK_TRANSITIONS: Record<HousekeepingTaskStatus, readonly HousekeepingTaskStatus[]> = {
  OPEN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['OPEN', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransitionHousekeeping(from: HousekeepingStatus, to: HousekeepingStatus) {
  return TRANSITIONS[from].includes(to);
}

/** Availability can compose this with reservation and inventory checks. */
export function isRoomSellable(status: HousekeepingStatus): boolean {
  return status !== 'OUT_OF_ORDER';
}

export type HousekeepingDb = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
export type HousekeepingScope = { organizationId: string; branchId: string; actorId: string };

async function applyHousekeepingScope(
  db: HousekeepingDb,
  scope: Omit<HousekeepingScope, 'actorId'>
) {
  await db.$queryRaw(
    Prisma.sql`SELECT set_config('app.current_organization_id', ${scope.organizationId}, true), set_config('app.current_hotel_property_id', ${scope.branchId}, true)`
  );
}

export async function listHousekeeping(
  db: HousekeepingDb,
  scope: Omit<HousekeepingScope, 'actorId'>
) {
  await applyHousekeepingScope(db, scope);
  const rooms = await db.$queryRaw(Prisma.sql`
    SELECT r.id AS "roomId", r.number, COALESCE(h.status, 'DIRTY') AS status, h."changedAt"
    FROM hotel_rooms r LEFT JOIN hotel_room_housekeeping h
      ON h."organizationId" = r."organizationId" AND h."branchId" = r."branchId" AND h."roomId" = r.id
    WHERE r."organizationId" = ${scope.organizationId} AND r."branchId" = ${scope.branchId} AND r.active = true
    ORDER BY r.number`);
  const tasks = await db.$queryRaw(Prisma.sql`
    SELECT * FROM hotel_housekeeping_tasks
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
    ORDER BY "createdAt" DESC`);
  return { rooms, tasks };
}

export async function setHousekeepingStatus(
  db: HousekeepingDb,
  scope: HousekeepingScope,
  roomId: string,
  status: HousekeepingStatus
) {
  await applyHousekeepingScope(db, scope);
  const current = await db.$queryRaw<{ status: HousekeepingStatus }[]>(Prisma.sql`
    SELECT COALESCE(h.status, 'DIRTY') AS status FROM hotel_rooms r
    LEFT JOIN hotel_room_housekeeping h ON h."organizationId"=r."organizationId" AND h."branchId"=r."branchId" AND h."roomId"=r.id
    WHERE r."organizationId"=${scope.organizationId} AND r."branchId"=${scope.branchId} AND r.id=${roomId} AND r.active=true FOR UPDATE OF r`);
  if (!current[0]) throw new Error('ROOM_NOT_FOUND');
  if (!canTransitionHousekeeping(current[0].status, status))
    throw new Error('INVALID_HOUSEKEEPING_TRANSITION');
  await db.$executeRaw(Prisma.sql`
    INSERT INTO hotel_room_housekeeping (id,"organizationId","branchId","roomId",status,"changedById")
    VALUES (${randomUUID()},${scope.organizationId},${scope.branchId},${roomId},${status}::"HotelHousekeepingStatus",${scope.actorId})
    ON CONFLICT ("organizationId","branchId","roomId") DO UPDATE SET status=EXCLUDED.status,"changedById"=EXCLUDED."changedById","changedAt"=now(),"updatedAt"=now()
    WHERE hotel_room_housekeeping."organizationId"=${scope.organizationId} AND hotel_room_housekeeping."branchId"=${scope.branchId}`);
  return { roomId, status };
}

export async function createHousekeepingTask(
  db: HousekeepingDb,
  scope: HousekeepingScope,
  input: z.infer<typeof housekeepingTaskCreateInput>
) {
  await applyHousekeepingScope(db, scope);
  const id = randomUUID();
  const rows = await db.$queryRaw(Prisma.sql`
    INSERT INTO hotel_housekeeping_tasks (id,"organizationId","branchId","roomId",title,notes,"assignedToId","createdById")
    SELECT ${id},${scope.organizationId},${scope.branchId},r.id,${input.title},${input.notes ?? null},${input.assignedToId ?? null},${scope.actorId}
    FROM hotel_rooms r WHERE r."organizationId"=${scope.organizationId} AND r."branchId"=${scope.branchId} AND r.id=${input.roomId} AND r.active=true
    RETURNING *`);
  if (!(rows as unknown[]).length) throw new Error('ROOM_NOT_FOUND');
  return (rows as unknown[])[0];
}

export async function updateHousekeepingTask(
  db: HousekeepingDb,
  scope: HousekeepingScope,
  taskId: string,
  status: HousekeepingTaskStatus
) {
  await applyHousekeepingScope(db, scope);
  const found = await db.$queryRaw<{ status: HousekeepingTaskStatus }[]>(
    Prisma.sql`SELECT status FROM hotel_housekeeping_tasks WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${taskId} FOR UPDATE`
  );
  if (!found[0]) throw new Error('TASK_NOT_FOUND');
  if (!TASK_TRANSITIONS[found[0].status].includes(status))
    throw new Error('INVALID_TASK_TRANSITION');
  await db.$executeRaw(
    Prisma.sql`UPDATE hotel_housekeeping_tasks SET status=${status}::"HotelHousekeepingTaskStatus","completedAt"=CASE WHEN ${status}='COMPLETED' THEN now() ELSE NULL END,"completedById"=CASE WHEN ${status}='COMPLETED' THEN ${scope.actorId} ELSE NULL END,"updatedAt"=now() WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${taskId}`
  );
  return { taskId, status };
}
