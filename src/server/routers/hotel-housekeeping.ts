import { TRPCError } from '@trpc/server';

import { recordHotelAudit } from '@/lib/hotel/audit';
import {
  createHousekeepingTask,
  housekeepingBranchInput,
  housekeepingStatusInput,
  housekeepingTaskCreateInput,
  housekeepingTaskUpdateInput,
  listHousekeeping,
  setHousekeepingStatus,
  updateHousekeepingTask,
} from '@/lib/hotel/housekeeping';
import { HotelInventoryError } from '@/lib/hotel/inventory';
import { withLockedProperty } from '@/server/hotel-property-context';
import { requireHotelPropertyScope } from '@/server/hotel-property-scope';
import { capabilityProcedure, router } from '../trpc';

const housekeeping = capabilityProcedure('hotel:housekeeping');
const HOUSEKEEPING = 'hotel:housekeeping' as const;

function actor(ctx: { session?: { user?: { id?: string } } | null }) {
  const id = ctx.session?.user?.id;
  if (!id) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return id;
}

/** The domain's coded errors, as client-facing tRPC errors. */
function mapHousekeepingError(error: unknown): never {
  if (error instanceof HotelInventoryError) {
    throw new TRPCError({ code: error.code, message: error.message });
  }
  if (error instanceof Error) {
    if (error.message === 'ROOM_NOT_FOUND') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found.' });
    }
    if (error.message === 'TASK_NOT_FOUND') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found.' });
    }
    if (error.message === 'ASSIGNEE_NOT_FOUND') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Assign the task to an active member of this organization.',
      });
    }
    if (
      error.message === 'INVALID_HOUSEKEEPING_TRANSITION' ||
      error.message === 'INVALID_TASK_TRANSITION'
    ) {
      throw new TRPCError({ code: 'CONFLICT', message: 'That status change is not allowed.' });
    }
  }
  throw error;
}

/**
 * Writes lock the property row, THEN re-check `hotel:housekeeping` for it,
 * THEN write — all in one transaction (`withLockedProperty`), the same
 * check-then-write order as every other hotel mutation.
 */
export const hotelHousekeepingRouter = router({
  list: housekeeping.input(housekeepingBranchInput).query(async ({ ctx, input }) => {
    const property = await requireHotelPropertyScope(ctx, input.branchId, HOUSEKEEPING);
    return ctx.db.$transaction((db) =>
      listHousekeeping(db, {
        organizationId: ctx.entitlements.organizationId,
        branchId: property.branchId,
      })
    );
  }),

  /** Clean/dirty/inspected on `hotel_rooms.status`, through the PROP-03 matrix. */
  setStatus: housekeeping.input(housekeepingStatusInput).mutation(async ({ ctx, input }) => {
    const actorId = actor(ctx);
    return withLockedProperty(
      ctx,
      input.branchId,
      async (tx, property) => {
        const result = await setHousekeepingStatus(
          tx.db,
          { organizationId: tx.entitlements.organizationId, branchId: property.branchId, actorId },
          input.roomId,
          input.status,
          {
            ...(input.expectedStatus ? { expectedStatus: input.expectedStatus } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
          }
        );
        recordHotelAudit(ctx, {
          entity: { type: 'HotelRoom', id: input.roomId },
          action: 'hotel.housekeeping.setStatus',
          after: { status: input.status },
          metadata: {
            branchId: property.branchId,
            ...(input.reason ? { reason: input.reason } : {}),
          },
        });
        return result;
      },
      HOUSEKEEPING
    ).catch(mapHousekeepingError);
  }),

  createTask: housekeeping.input(housekeepingTaskCreateInput).mutation(async ({ ctx, input }) => {
    const actorId = actor(ctx);
    return withLockedProperty(
      ctx,
      input.branchId,
      async (tx, property) => {
        const task = await createHousekeepingTask(
          tx.db,
          { organizationId: tx.entitlements.organizationId, branchId: property.branchId, actorId },
          input
        );
        recordHotelAudit(ctx, {
          entity: {
            type: 'HotelHousekeepingTask',
            id: String((task as { id?: unknown }).id ?? ''),
          },
          action: 'hotel.housekeeping.createTask',
          operation: 'CREATE',
          after: {
            roomId: input.roomId,
            title: input.title,
            assignedToId: input.assignedToId ?? null,
          },
          metadata: { branchId: property.branchId },
        });
        return task;
      },
      HOUSEKEEPING
    ).catch(mapHousekeepingError);
  }),

  updateTask: housekeeping.input(housekeepingTaskUpdateInput).mutation(async ({ ctx, input }) => {
    const actorId = actor(ctx);
    return withLockedProperty(
      ctx,
      input.branchId,
      async (tx, property) => {
        const result = await updateHousekeepingTask(
          tx.db,
          { organizationId: tx.entitlements.organizationId, branchId: property.branchId, actorId },
          input.taskId,
          input.status
        );
        recordHotelAudit(ctx, {
          entity: { type: 'HotelHousekeepingTask', id: input.taskId },
          action: 'hotel.housekeeping.updateTask',
          after: { status: input.status },
          metadata: { branchId: property.branchId },
        });
        return result;
      },
      HOUSEKEEPING
    ).catch(mapHousekeepingError);
  }),
});
