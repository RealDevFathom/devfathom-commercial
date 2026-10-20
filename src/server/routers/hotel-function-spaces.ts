/**
 * PROP-07 — `hotelProperty.spaces.*`: the function spaces a property sells,
 * their buffers, and the claims on their time.
 *
 * Function spaces are property configuration, so every procedure gates on
 * `hotel:property-admin` (06 §1: "property, modes, room types/rooms/beds/units,
 * slots, extras, **spaces**, tax profile, …"), reads included — a hall's price
 * list and its turnaround times are commercial configuration, not operating data
 * — and on the `hotel-banquets` module, which is what sells function space (the
 * Venue package carries it; the room packages do not). Writes additionally need
 * the property's REAL configuration to enable function spaces: its mode plus its
 * explicit overrides, evaluated against the organization's entitlements by
 * `evaluateHotelFeatures` — never a mode name.
 *
 * The shape rules, the buffer arithmetic and the SQL booking write live in
 * `@/lib/hotel/function-spaces`; this file is the gates, the tenant predicate
 * and the operator-facing refusals. Nothing here re-implements invariant 25:
 * `availability` is a courtesy answer, the pre-check before a hold is a courtesy
 * sentence, and the exclusion constraint is the authority.
 *
 * Every write runs inside `withLockedProperty` (lock, re-check access, write),
 * every statement carries the organization and the resolved property, and every
 * mutation enriches the request's audit row. Forced row-level security is the
 * second wall and never the only one.
 */
import { TRPCError } from '@trpc/server';
import { z, ZodRealError, type ZodError } from 'zod';

import { Prisma, type HotelProperty } from '@/generated/prisma/client';
import { hasModule } from '@/lib/entitlements';
import { recordHotelAudit } from '@/lib/hotel/audit';
import { evaluateHotelFeatures } from '@/lib/hotel/features';
import {
  HOTEL_SPACE_BOOKING_KINDS,
  HOTEL_SPACE_BOOKING_KIND_LABELS,
  createFunctionSpace,
  getFunctionSpace,
  hotelFunctionSpaceActiveInput,
  hotelFunctionSpaceCreateInput,
  hotelFunctionSpaceUpdateInput,
  hotelSpaceBookingInput,
  hotelSpaceBookingListInput,
  hotelSpaceBookingReleaseInput,
  hotelSpaceWindowInput,
  insertSpaceBooking,
  listFunctionSpaces,
  listSpaceBookings,
  releaseSpaceHold,
  setFunctionSpaceActive,
  spaceAvailability,
  unavailableReason,
  updateFunctionSpace,
} from '@/lib/hotel/function-spaces';
import { readHotelModeOverrides } from '@/lib/hotel/mode-overrides';
import { applyHotelModeDefaults } from '@/lib/hotel/modes';
import type { EntitlementSnapshot } from '@/lib/module-catalog';
import {
  currentProperty,
  hasSqlState,
  uniqueViolationColumns,
  withLockedProperty,
  type PropertyContext,
} from '@/server/hotel-property-context';
import { hotelPropertySelectionInput } from '@/server/hotel-property-scope';
import { capabilityProcedure, router, type TRPCContext } from '../trpc';

const propertyAdmin = capabilityProcedure('hotel:property-admin');
const BANQUETS = 'hotel-banquets';
const expectedVersionInput = z.object({ expectedUpdatedAt: z.coerce.date() });

/**
 * The property selection joined onto a lib contract as ONE parser, so the lib
 * schema keeps its refinements and the selection is parsed once.
 */
function selected<Shape extends z.ZodRawShape, Config extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<Shape, Config>
) {
  return schema.extend(hotelPropertySelectionInput.shape);
}

/** A refined (non-object) lib schema joined onto the selection the same way. */
const bookingInput = hotelPropertySelectionInput.and(hotelSpaceBookingInput);
const windowInput = hotelPropertySelectionInput.and(hotelSpaceWindowInput);

/** A rule the database holds but the input schema cannot see, stated on its field. */
function fieldError(field: string, message: string): ZodError {
  return new ZodRealError([{ code: 'custom', path: [field], message, input: undefined }]);
}

/**
 * The module gate, before any read: a workspace without Banquets and Events has
 * no function spaces to show, whatever role the caller holds.
 */
function requireBanquets(ctx: Pick<TRPCContext, 'entitlements'>): void {
  if (hasModule(ctx.entitlements, BANQUETS)) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message:
      'Function spaces need the Banquets and Events module, which this workspace does not have. Ask your DevFathom account manager about the Venue package.',
  });
}

/**
 * Whether this property sells function space right now: its mode plus explicit
 * overrides against the organization's entitlements. Computed per request from
 * the stored property, never from a mode name.
 */
export function functionSpacesEnabled(
  property: Pick<HotelProperty, 'mode' | 'modeOverrides'>,
  entitlements: EntitlementSnapshot
): boolean {
  const configuration = applyHotelModeDefaults(
    property.mode,
    readHotelModeOverrides(property.modeOverrides)
  );
  return evaluateHotelFeatures(configuration, entitlements).functionSpaces;
}

function requireFunctionSpaces(
  property: Pick<HotelProperty, 'mode' | 'modeOverrides'>,
  entitlements: EntitlementSnapshot
): void {
  if (functionSpacesEnabled(property, entitlements)) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message:
      'This property is not configured to sell function spaces. Turn on function spaces in how the property operates, or ask your DevFathom account manager about the Venue package.',
  });
}

function noSuchSpace(): TRPCError {
  return new TRPCError({
    code: 'NOT_FOUND',
    message: 'That function space is not one of this property’s. It may have been removed.',
  });
}

function spaceChanged(): TRPCError {
  return new TRPCError({
    code: 'CONFLICT',
    message: 'That function space changed or no longer exists. Reload the list and try again.',
  });
}

/**
 * Translate the constraints an operator can actually hit into sentences they
 * can act on, and re-throw everything else: a swallowed database error is worse
 * than a blunt one.
 *
 * `23P01` is `exclusion_violation` — invariant 25. On a space write only the
 * re-ranging trigger can raise it: shortening a hall's turnaround is always
 * allowed, lengthening it is refused when it would collide bookings the space
 * already has.
 */
function mapSpaceWriteError(error: unknown, name: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = uniqueViolationColumns(error);
    if (
      target.includes('hotel_function_spaces_org_branch_name_key') ||
      target.some((column) => column.includes('name'))
    ) {
      const message = `This property already has a function space called “${name}”. Choose another name, or edit that space.`;
      throw new TRPCError({ code: 'BAD_REQUEST', message, cause: fieldError('name', message) });
    }
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'That function space already exists. Reload the list and try again.',
      cause: error,
    });
  }
  if (hasSqlState(error, '23P01')) {
    // BAD_REQUEST, not CONFLICT: the transport publishes `data.validation` for
    // BAD_REQUEST alone, and this refusal belongs on the Setup field — the
    // operator changes a number, nobody reloads anything.
    const message =
      'Those setup and teardown times would overlap bookings this space already has. Move the bookings first, or choose shorter buffers.';
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message,
      cause: fieldError('setupMinutes', message),
    });
  }
  throw error;
}

/** The actor every write is attributed to. */
function actorId(ctx: PropertyContext): string {
  const user = ctx.session?.user;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return user.id;
}

/** An instant as the property's own clock reads it, for refusal sentences. */
function instantFormatter(timezone: string): (value: Date) => string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (value) => formatter.format(value);
}

/** A write under both gates: module, lock, access, then the property's configuration. */
function spaceWrite<T>(
  ctx: TRPCContext,
  branchId: string,
  run: (ctx: PropertyContext, property: HotelProperty) => Promise<T>
): Promise<T> {
  requireBanquets(ctx);
  return withLockedProperty(ctx, branchId, async (lockedCtx, property) => {
    requireFunctionSpaces(property, lockedCtx.entitlements);
    return run(lockedCtx, property);
  });
}

const kindOptions = HOTEL_SPACE_BOOKING_KINDS.map((value) => ({
  value,
  label: HOTEL_SPACE_BOOKING_KIND_LABELS[value],
}));

export const hotelFunctionSpacesRouter = router({
  /**
   * Every space of the property, retired ones included, with whether this
   * property may add or change one right now and the diary ahead.
   */
  list: propertyAdmin.input(hotelPropertySelectionInput).query(async ({ ctx, input }) => {
    requireBanquets(ctx);
    const property = await currentProperty(ctx, input.branchId);
    const organizationId = ctx.entitlements.organizationId;
    const [spaces, bookings] = await Promise.all([
      listFunctionSpaces(ctx.db, organizationId, property.branchId),
      listSpaceBookings(ctx.db, organizationId, property.branchId),
    ]);
    return {
      branchId: property.branchId,
      timezone: property.timezone,
      enabled: functionSpacesEnabled(property, ctx.entitlements),
      spaces,
      bookings,
      kindOptions,
    };
  }),

  create: propertyAdmin.input(selected(hotelFunctionSpaceCreateInput)).mutation(({ ctx, input }) =>
    spaceWrite(ctx, input.branchId, async (ctx, property) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { branchId, ...fields } = input;
      try {
        const space = await createFunctionSpace(
          ctx.db,
          ctx.entitlements.organizationId,
          property.branchId,
          fields
        );
        recordHotelAudit(ctx, {
          entity: { type: 'HotelFunctionSpace', id: space.id, label: space.name },
          action: 'hotel.spaces.create',
          operation: 'CREATE',
          after: {
            name: space.name,
            layouts: space.layouts,
            pricing: space.pricing,
            setupMinutes: space.setupMinutes,
            teardownMinutes: space.teardownMinutes,
            active: space.active,
          },
          metadata: { branchId: property.branchId },
        });
        return { space };
      } catch (error) {
        mapSpaceWriteError(error, input.name);
      }
    })
  ),

  /**
   * Record a space's facts. Widening a buffer re-ranges the space's bookings and
   * is refused by the exclusion constraint if that would collide two of them —
   * reported as a conflict the operator can resolve, not as a database error.
   */
  update: propertyAdmin
    .input(selected(hotelFunctionSpaceUpdateInput).extend(expectedVersionInput.shape))
    .mutation(({ ctx, input }) =>
      spaceWrite(ctx, input.branchId, async (ctx, property) => {
        const organizationId = ctx.entitlements.organizationId;
        const before = await getFunctionSpace(ctx.db, organizationId, property.branchId, input.id);
        if (!before || before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
          throw spaceChanged();
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { branchId, expectedUpdatedAt, ...fields } = input;
        let count: number;
        try {
          count = await updateFunctionSpace(
            ctx.db,
            organizationId,
            property.branchId,
            fields,
            expectedUpdatedAt
          );
        } catch (error) {
          mapSpaceWriteError(error, input.name);
        }
        if (count !== 1) throw spaceChanged();
        const space = await getFunctionSpace(ctx.db, organizationId, property.branchId, input.id);
        if (!space) throw spaceChanged();
        recordHotelAudit(ctx, {
          entity: { type: 'HotelFunctionSpace', id: space.id, label: space.name },
          action: 'hotel.spaces.update',
          before: {
            name: before.name,
            layouts: before.layouts,
            pricing: before.pricing,
            setupMinutes: before.setupMinutes,
            teardownMinutes: before.teardownMinutes,
          },
          after: {
            name: space.name,
            layouts: space.layouts,
            pricing: space.pricing,
            setupMinutes: space.setupMinutes,
            teardownMinutes: space.teardownMinutes,
          },
          metadata: { branchId: property.branchId },
        });
        return { space };
      })
    ),

  /** Retire a space, or bring one back. Never a delete: bookings and reports still name it. */
  setActive: propertyAdmin
    .input(selected(hotelFunctionSpaceActiveInput).extend(expectedVersionInput.shape))
    .mutation(({ ctx, input }) =>
      spaceWrite(ctx, input.branchId, async (ctx, property) => {
        const count = await setFunctionSpaceActive(
          ctx.db,
          ctx.entitlements.organizationId,
          property.branchId,
          input.spaceId,
          input.active,
          input.expectedUpdatedAt
        );
        if (count !== 1) throw spaceChanged();
        recordHotelAudit(ctx, {
          entity: { type: 'HotelFunctionSpace', id: input.spaceId },
          action: input.active ? 'hotel.spaces.restore' : 'hotel.spaces.retire',
          before: { active: !input.active },
          after: { active: input.active },
          metadata: { branchId: property.branchId },
        });
        return { id: input.spaceId, active: input.active };
      })
    ),

  /**
   * Is this space free between these two instants, buffers included? An answer for
   * a surface to show; the exclusion constraint is what actually decides when a
   * booking is written.
   */
  availability: propertyAdmin.input(windowInput).query(async ({ ctx, input }) => {
    requireBanquets(ctx);
    const property = await currentProperty(ctx, input.branchId);
    const organizationId = ctx.entitlements.organizationId;
    const space = await getFunctionSpace(ctx.db, organizationId, property.branchId, input.spaceId);
    if (!space) throw noSuchSpace();
    const availability = await spaceAvailability(ctx.db, organizationId, property.branchId, space, {
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    });
    return {
      spaceId: space.id,
      spaceName: space.name,
      setupMinutes: space.setupMinutes,
      teardownMinutes: space.teardownMinutes,
      available: availability.available,
      buffered: availability.buffered,
      conflicts: availability.conflicts,
      reason: unavailableReason(space.name, availability, instantFormatter(property.timezone)),
    };
  }),

  bookings: router({
    /** The diary ahead for the property, or for one space. */
    list: propertyAdmin
      .input(selected(hotelSpaceBookingListInput))
      .query(async ({ ctx, input }) => {
        requireBanquets(ctx);
        const property = await currentProperty(ctx, input.branchId);
        return listSpaceBookings(ctx.db, ctx.entitlements.organizationId, property.branchId, {
          spaceId: input.spaceId,
          from: input.from,
        });
      }),

    /**
     * Claim a space's time: a tentative hold, or a confirmed function. The
     * availability read first, so a busy hall is refused with the time it is
     * next free (UX rule 13); then the SQL insert, which the exclusion
     * constraint judges — a race that slips past the read still ends in one
     * booking, reported as a conflict rather than a database error.
     */
    hold: propertyAdmin.input(bookingInput).mutation(({ ctx, input }) =>
      spaceWrite(ctx, input.branchId, async (ctx, property) => {
        const organizationId = ctx.entitlements.organizationId;
        const space = await getFunctionSpace(
          ctx.db,
          organizationId,
          property.branchId,
          input.spaceId
        );
        if (!space) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: noSuchSpace().message,
            cause: fieldError('spaceId', 'Choose one of this property’s function spaces.'),
          });
        }
        if (!space.active) {
          const message = `${space.name} is retired. Restore it before booking it.`;
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message,
            cause: fieldError('spaceId', message),
          });
        }
        const availability = await spaceAvailability(
          ctx.db,
          organizationId,
          property.branchId,
          space,
          {
            startsAt: input.startsAt,
            endsAt: input.endsAt,
          }
        );
        const reason = unavailableReason(
          space.name,
          availability,
          instantFormatter(property.timezone)
        );
        if (reason) {
          // The courtesy refusal lands on the From field (BAD_REQUEST carries
          // `data.validation`); the race below, which no field can fix, is the
          // CONFLICT.
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: reason,
            cause: fieldError('startsAt', reason),
          });
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { branchId, ...claim } = input;
        try {
          const booking = await insertSpaceBooking(
            ctx.db,
            organizationId,
            property.branchId,
            actorId(ctx),
            claim
          );
          recordHotelAudit(ctx, {
            entity: { type: 'HotelSpaceBooking', id: booking.id, label: booking.label },
            action: 'hotel.spaces.booking.create',
            operation: 'CREATE',
            after: {
              spaceId: booking.spaceId,
              kind: booking.kind,
              startsAt: booking.startsAt,
              endsAt: booking.endsAt,
              label: booking.label,
            },
            metadata: { branchId: property.branchId, spaceName: space.name },
          });
          return { booking };
        } catch (error) {
          if (hasSqlState(error, '23P01')) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: `${space.name} was booked for that time a moment ago. Reload the diary and choose another time.`,
              cause: error,
            });
          }
          throw error;
        }
      })
    ),

    /** Release a tentative hold. A confirmed function belongs to its event, not to this page. */
    release: propertyAdmin
      .input(selected(hotelSpaceBookingReleaseInput))
      .mutation(({ ctx, input }) =>
        spaceWrite(ctx, input.branchId, async (ctx, property) => {
          const count = await releaseSpaceHold(
            ctx.db,
            ctx.entitlements.organizationId,
            property.branchId,
            input.bookingId
          );
          if (count !== 1) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message:
                'That hold is no longer here, or it is a confirmed function, which is released from its event rather than from the space.',
            });
          }
          recordHotelAudit(ctx, {
            entity: { type: 'HotelSpaceBooking', id: input.bookingId },
            action: 'hotel.spaces.booking.release',
            operation: 'DELETE',
            metadata: { branchId: property.branchId },
          });
          return { id: input.bookingId, released: true };
        })
      ),
  }),
});
