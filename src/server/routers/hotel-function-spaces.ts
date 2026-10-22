/**
 * PROP-07 — `hotelProperty.spaces.*`.
 *
 * Function spaces are property configuration, so every procedure here gates on
 * `hotel:property-admin` (06 §1: "property, modes, room types/rooms/beds/units,
 * slots, extras, **spaces**, tax profile, …"), reads included — a hall's price
 * list and its turnaround times are commercial configuration, not operating data.
 *
 * The shape rules and the buffer arithmetic live in `@/lib/hotel/function-spaces`;
 * this file is the gate, the tenant predicate and the operator-facing refusals.
 * Nothing here re-implements invariant 25: `availability` is a courtesy answer and
 * the exclusion constraint is the authority (see that module's header).
 *
 * Every space and booking query carries explicit organization and server-resolved
 * property predicates. Forced row-level security is the second wall.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import {
  createFunctionSpace,
  deactivateFunctionSpace,
  getFunctionSpace,
  hotelFunctionSpaceCreateInput,
  hotelFunctionSpaceUpdateInput,
  hotelSpaceWindowInput,
  listFunctionSpaces,
  spaceAvailability,
  updateFunctionSpace,
} from '@/lib/hotel/function-spaces';
import { capabilityProcedure, router, type TRPCContext } from '../trpc';

const propertyAdmin = capabilityProcedure('hotel:property-admin');

/** The property a hospitality organization operates, or null before one exists. */
async function currentProperty(ctx: TRPCContext) {
  return ctx.db.hotelProperty.findFirst({
    where: { organizationId: ctx.entitlements.organizationId, active: true },
    orderBy: { createdAt: 'asc' },
  });
}

function notProvisioned(): TRPCError {
  return new TRPCError({
    code: 'NOT_FOUND',
    message:
      'This workspace has no property yet. A property is created with the workspace, so ask your DevFathom account manager to re-run provisioning.',
  });
}

function noSuchSpace(): TRPCError {
  return new TRPCError({
    code: 'NOT_FOUND',
    message: 'That function space is not one of this property’s. It may have been removed.',
  });
}

/**
 * A constraint Prisma does not model arrives as a generic error carrying the
 * driver's SQLSTATE somewhere beneath it — for the pg driver adapter, at
 * `meta.driverAdapterError.cause.originalCode` (the same chain
 * `src/app/api/ready/route.ts` reads). The nesting has changed with Prisma
 * versions before, so this walks the chain rather than naming one path;
 * `restaurant-shifts.errors.ts` does the same for the roster's own exclusion
 * constraint, and the verticals keep their own copy rather than sharing a
 * restaurant module.
 */
function hasSqlState(error: unknown, sqlState: string, seen = new Set<unknown>()): boolean {
  if (typeof error === 'string') return error.includes(sqlState);
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const record = error as Record<string, unknown>;
  if (
    record.code === sqlState ||
    record.sqlState === sqlState ||
    record.originalCode === sqlState
  ) {
    return true;
  }
  return [
    'cause',
    'originalError',
    'driverError',
    'driverAdapterError',
    'meta',
    'database_error',
  ].some((key) => hasSqlState(record[key], sqlState, seen));
}

/**
 * Translate the two constraints an operator can actually hit into sentences they
 * can act on, and re-throw everything else: a swallowed database error is worse
 * than a blunt one.
 *
 * `23P01` is `exclusion_violation` — invariant 25. On this surface only the
 * re-ranging trigger can raise it: shortening a hall's turnaround is always
 * allowed, lengthening it is refused when it would collide bookings the space
 * already has.
 */
function mapSpaceWriteError(error: unknown, name: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `This property already has a function space called “${name}”.`,
    });
  }
  if (hasSqlState(error, '23P01')) {
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'Those setup and teardown times would overlap bookings this space already has. Move the bookings first, or choose shorter buffers.',
    });
  }
  throw error;
}

const spaceIdInput = z.object({ spaceId: z.string().trim().min(1).max(191) });

export const hotelFunctionSpacesRouter = router({
  /** Every space of the property, retired ones included. */
  list: propertyAdmin.query(async ({ ctx }) => {
    const property = await currentProperty(ctx);
    if (!property) throw notProvisioned();
    return {
      branchId: property.branchId,
      spaces: await listFunctionSpaces(ctx.db, ctx.entitlements.organizationId, property.branchId),
    };
  }),

  create: propertyAdmin.input(hotelFunctionSpaceCreateInput).mutation(async ({ ctx, input }) => {
    const property = await currentProperty(ctx);
    if (!property) throw notProvisioned();
    try {
      return await createFunctionSpace(
        ctx.db,
        ctx.entitlements.organizationId,
        property.branchId,
        input
      );
    } catch (error) {
      mapSpaceWriteError(error, input.name);
    }
  }),

  /**
   * Record a space's facts. Widening a buffer re-ranges the space's bookings and
   * is refused by the exclusion constraint if that would collide two of them —
   * reported as a conflict the operator can resolve, not as a database error.
   */
  update: propertyAdmin.input(hotelFunctionSpaceUpdateInput).mutation(async ({ ctx, input }) => {
    const property = await currentProperty(ctx);
    if (!property) throw notProvisioned();
    let count: number;
    try {
      count = await updateFunctionSpace(
        ctx.db,
        ctx.entitlements.organizationId,
        property.branchId,
        input
      );
    } catch (error) {
      mapSpaceWriteError(error, input.name);
    }
    if (count === 0) throw noSuchSpace();
    return { id: input.id };
  }),

  /** Retire a space. Never a delete: bookings and reports still name it. */
  deactivate: propertyAdmin.input(spaceIdInput).mutation(async ({ ctx, input }) => {
    const property = await currentProperty(ctx);
    if (!property) throw notProvisioned();
    const count = await deactivateFunctionSpace(
      ctx.db,
      ctx.entitlements.organizationId,
      property.branchId,
      input.spaceId
    );
    if (count === 0) throw noSuchSpace();
    return { id: input.spaceId, active: false };
  }),

  /**
   * Is this space free between these two instants, buffers included? An answer for
   * a surface to show; the exclusion constraint is what actually decides when a
   * booking is written.
   */
  availability: propertyAdmin.input(hotelSpaceWindowInput).query(async ({ ctx, input }) => {
    const property = await currentProperty(ctx);
    if (!property) throw notProvisioned();
    const space = await getFunctionSpace(
      ctx.db,
      ctx.entitlements.organizationId,
      property.branchId,
      input.spaceId
    );
    if (!space) throw noSuchSpace();

    const availability = await spaceAvailability(
      ctx.db,
      ctx.entitlements.organizationId,
      property.branchId,
      space,
      { startsAt: input.startsAt, endsAt: input.endsAt }
    );
    return {
      spaceId: space.id,
      spaceName: space.name,
      setupMinutes: space.setupMinutes,
      teardownMinutes: space.teardownMinutes,
      available: availability.available,
      buffered: availability.buffered,
      conflicts: availability.conflicts,
    };
  }),
});
