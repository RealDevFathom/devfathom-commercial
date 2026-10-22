import { TRPCError } from '@trpc/server';

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
    return ctx.db.$transaction((db) =>
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
    );
  }),
  createTask: housekeeping.input(housekeepingTaskCreateInput).mutation(async ({ ctx, input }) => {
    const property = await requireHotelPropertyScope(ctx, input.branchId, 'hotel:housekeeping');
    return ctx.db.$transaction((db) =>
      createHousekeepingTask(
        db,
        {
          organizationId: ctx.entitlements.organizationId,
          branchId: property.branchId,
          actorId: actor(ctx),
        },
        input
      )
    );
  }),
  updateTask: housekeeping.input(housekeepingTaskUpdateInput).mutation(async ({ ctx, input }) => {
    const property = await requireHotelPropertyScope(ctx, input.branchId, 'hotel:housekeeping');
    return ctx.db.$transaction((db) =>
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
    );
  }),
});
