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
import { requireHotelPropertyScope } from '@/server/hotel-property-scope';
import { capabilityProcedure, router } from '../trpc';

const housekeeping = capabilityProcedure('hotel:housekeeping');

function actor(ctx: { session?: { user?: { id?: string } } | null }) {
  const id = ctx.session?.user?.id;
  if (!id) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return id;
}

/** The domain's coded errors, as client-facing tRPC errors. */
function mapHousekeepingError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message === 'ROOM_NOT_FOUND') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found.' });
    }
    if (error.message === 'TASK_NOT_FOUND') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found.' });
    }
    if (error.message === 'INVALID_HOUSEKEEPING_TRANSITION' || error.message === 'INVALID_TASK_TRANSITION') {
      throw new TRPCError({ code: 'CONFLICT', message: 'That status change is not allowed.' });
    }
  }
  throw error;
}

export const hotelHousekeepingRouter = router({
  list: housekeeping.input(housekeepingBranchInput).query(async ({ ctx, input }) => {
    const property = await requireHotelPropertyScope(ctx, input.branchId, 'hotel:housekeeping');
    return ctx.db.$transaction((db) =>
      listHousekeeping(db, {
        organizationId: ctx.entitlements.organizationId,
        branchId: property.branchId,
      })
    );
  }),
  setStatus: housekeeping.input(housekeepingStatusInput).mutation(async ({ ctx, input }) => {
    const property = await requireHotelPropertyScope(ctx, input.branchId, 'hotel:housekeeping');
    const result = await ctx.db
      .$transaction((db) =>
        setHousekeepingStatus(
          db,
          {
            organizationId: ctx.entitlements.organizationId,
            branchId: property.branchId,
            actorId: actor(ctx),
          },
          input.roomId,
          input.status
        )
      )
      .catch(mapHousekeepingError);
    recordHotelAudit(ctx, {
      entity: { type: 'HotelRoomHousekeeping', id: input.roomId },
      action: 'hotel.housekeeping.setStatus',
      after: { status: input.status },
      metadata: { branchId: property.branchId },
    });
    return result;
  }),
  createTask: housekeeping.input(housekeepingTaskCreateInput).mutation(async ({ ctx, input }) => {
    const property = await requireHotelPropertyScope(ctx, input.branchId, 'hotel:housekeeping');
    const task = await ctx.db
      .$transaction((db) =>
        createHousekeepingTask(
          db,
          {
            organizationId: ctx.entitlements.organizationId,
            branchId: property.branchId,
            actorId: actor(ctx),
          },
          input
        )
      )
      .catch(mapHousekeepingError);
    recordHotelAudit(ctx, {
      entity: { type: 'HotelHousekeepingTask', id: String((task as { id?: unknown }).id ?? '') },
      action: 'hotel.housekeeping.createTask',
      operation: 'CREATE',
      after: { roomId: input.roomId, title: input.title, assignedToId: input.assignedToId ?? null },
      metadata: { branchId: property.branchId },
    });
    return task;
  }),
  updateTask: housekeeping.input(housekeepingTaskUpdateInput).mutation(async ({ ctx, input }) => {
    const property = await requireHotelPropertyScope(ctx, input.branchId, 'hotel:housekeeping');
    const result = await ctx.db
      .$transaction((db) =>
        updateHousekeepingTask(
          db,
          {
            organizationId: ctx.entitlements.organizationId,
            branchId: property.branchId,
            actorId: actor(ctx),
          },
          input.taskId,
          input.status
        )
      )
      .catch(mapHousekeepingError);
    recordHotelAudit(ctx, {
      entity: { type: 'HotelHousekeepingTask', id: input.taskId },
      action: 'hotel.housekeeping.updateTask',
      after: { status: input.status },
      metadata: { branchId: property.branchId },
    });
    return result;
  }),
});
