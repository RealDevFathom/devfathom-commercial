import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { z } from 'zod';

import {
  HOTEL_ROOM_STATUSES,
  HOUSEKEEPING_ROOM_STATUSES,
  HotelInventoryError,
  applyInventoryActor,
  planRoomStatusChange,
  setInventoryStatus,
  type HotelInventoryStatus,
  type HotelRoomStatusValue,
  type InventoryDb,
} from './inventory';

/**
 * HK-02. A room's clean/dirty state is the room's own `hotel_rooms.status`
 * (spec §4.3): there is no second housekeeping status that could disagree with
 * it. Housekeeping sets only its subset of the PROP-03 matrix — clean, dirty,
 * inspected — through `setInventoryStatus`, so the transition matrix, the
 * stay-owned `OCCUPIED` rule and the trigger-written, attributed status ledger
 * all apply exactly as they do on the inventory board.
 */
export const HOUSEKEEPING_STATUSES = [
  'VACANT_CLEAN',
  'VACANT_DIRTY',
  'INSPECTED',
] as const satisfies readonly HotelRoomStatusValue[];
export type HousekeepingStatus = (typeof HOUSEKEEPING_STATUSES)[number];
export const HOUSEKEEPING_TASK_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type HousekeepingTaskStatus = (typeof HOUSEKEEPING_TASK_STATUSES)[number];

/** The most tasks one board read returns: open work first, newest first. */
export const HOUSEKEEPING_TASK_LIST_LIMIT = 200;

const DEFAULT_STATUS_REASON = 'Housekeeping board';

export const housekeepingBranchInput = z
  .object({ branchId: z.string().trim().min(1).max(128) })
  .strict();
export const housekeepingStatusInput = housekeepingBranchInput
  .extend({
    roomId: z.string().trim().min(1).max(191),
    status: z.enum(HOUSEKEEPING_STATUSES),
    /** The status the operator was looking at; omitted, the current status is used. */
    expectedStatus: z.enum(HOTEL_ROOM_STATUSES).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
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

const TASK_TRANSITIONS: Record<HousekeepingTaskStatus, readonly HousekeepingTaskStatus[]> = {
  OPEN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['OPEN', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** May housekeeping move a room from `from` to `to`? The PROP-03 matrix, narrowed to its subset. */
export function canTransitionHousekeeping(from: HotelRoomStatusValue, to: HotelRoomStatusValue) {
  return planRoomStatusChange({
    from,
    to,
    actorId: 'housekeeping',
    reason: DEFAULT_STATUS_REASON,
    allowed: HOUSEKEEPING_ROOM_STATUSES,
  }).ok;
}

/** Availability can compose this with reservation and block checks. */
export function isRoomSellable(status: HotelRoomStatusValue): boolean {
  return status !== 'OUT_OF_ORDER' && status !== 'OUT_OF_SERVICE';
}

export type HousekeepingDb = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
/**
 * Both tenant keys travel with every statement: the tables' RLS is keyed on the
 * organization (set by the tenant DB handle), and the property is enforced by
 * the explicit `branchId` predicate after `requireHotelPropertyScope`.
 */
export type HousekeepingScope = { organizationId: string; branchId: string; actorId: string };

export async function listHousekeeping(
  db: HousekeepingDb,
  scope: Omit<HousekeepingScope, 'actorId'>
) {
  const rooms = await db.$queryRaw(Prisma.sql`
    SELECT r.id AS "roomId", r.number, r.status::text AS status, r."statusChangedAt" AS "changedAt"
    FROM hotel_rooms r
    WHERE r."organizationId" = ${scope.organizationId} AND r."branchId" = ${scope.branchId} AND r.active = true
    ORDER BY r.number`);
  const tasks = await db.$queryRaw(Prisma.sql`
    SELECT * FROM hotel_housekeeping_tasks
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
    ORDER BY CASE WHEN status IN ('OPEN', 'IN_PROGRESS') THEN 0 ELSE 1 END, "createdAt" DESC, id
    LIMIT ${HOUSEKEEPING_TASK_LIST_LIMIT}`);
  return { rooms, tasks };
}

/**
 * Set a room's housekeeping status on `hotel_rooms.status`. Must run on the
 * transaction client of a property-locked write. The actor and the reason are
 * handed to the status trigger, which writes the attributed ledger line.
 */
export async function setHousekeepingStatus(
  db: InventoryDb,
  scope: HousekeepingScope,
  roomId: string,
  status: HousekeepingStatus,
  options: { expectedStatus?: HotelRoomStatusValue; reason?: string } = {}
) {
  const reason = options.reason?.trim() || DEFAULT_STATUS_REASON;
  let expectedStatus = options.expectedStatus;
  if (!expectedStatus) {
    const current = await db.$queryRaw<{ status: HotelRoomStatusValue }[]>(Prisma.sql`
      SELECT r.status::text AS status FROM hotel_rooms r
      WHERE r."organizationId" = ${scope.organizationId} AND r."branchId" = ${scope.branchId}
        AND r.id = ${roomId} AND r.active = true
      FOR UPDATE OF r`);
    if (!current[0]) throw new Error('ROOM_NOT_FOUND');
    expectedStatus = current[0].status;
  }
  // Decided before any write: an OCCUPIED room belongs to the stay lane, and
  // anything outside housekeeping's subset is a property administrator's call.
  const plan = planRoomStatusChange({
    from: expectedStatus,
    to: status,
    actorId: scope.actorId,
    reason,
    allowed: HOUSEKEEPING_ROOM_STATUSES,
  });
  if (!plan.ok) {
    throw new HotelInventoryError(
      plan.code === 'NOT_PERMITTED' ? 'FORBIDDEN' : 'BAD_REQUEST',
      plan.message,
      'status'
    );
  }
  await applyInventoryActor(db, scope, reason);
  return setInventoryStatus(
    db,
    scope,
    'room',
    // Not OCCUPIED: the plan above refuses a stay-owned source.
    { id: roomId, expectedStatus: expectedStatus as HotelInventoryStatus, status, reason },
    HOUSEKEEPING_ROOM_STATUSES
  );
}

export async function createHousekeepingTask(
  db: HousekeepingDb,
  scope: HousekeepingScope,
  input: z.infer<typeof housekeepingTaskCreateInput>
) {
  if (input.assignedToId) {
    // An assignee is an active member of this organization; the id is never
    // stored on the caller's word alone.
    const assignee = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT u.id FROM users u
      WHERE u."organizationId" = ${scope.organizationId}
        AND u.id = ${input.assignedToId}
        AND u.status IN ('ACTIVE', 'ON_LEAVE')
      LIMIT 1`);
    if (!assignee[0]) throw new Error('ASSIGNEE_NOT_FOUND');
  }
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
