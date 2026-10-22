/**
 * PROP-02 / PROP-03 / HK-01 / HK-03 — `hotelProperty.inventory.*`: room types,
 * rooms, beds, the status ledger and the out-of-order / out-of-service blocks.
 *
 * Inventory is property configuration, so every procedure resolves the caller's
 * selected property through `requireHotelPropertyScope` with
 * `hotel:property-admin` (06 §1: "property, modes, **room types/rooms/beds/
 * units**, slots, extras, spaces, …"), reads included. The one exception is a
 * status change, which the housekeeping board also makes: `setStatus` admits
 * `hotel:housekeeping` when property administration is denied, confined to the
 * three housekeeping statuses by `planRoomStatusChange`. `OCCUPIED` is never
 * settable here; it belongs to the stay.
 *
 * Creates are gated on the property's REAL configuration — its mode plus its
 * explicit overrides, evaluated against the organization's entitlements by
 * `evaluateHotelFeatures` — never on a mode name, and on the `hotel.rooms.max`
 * ceiling the package sells, counted in sellable units across the organization
 * under an organization-wide advisory lock (`reserveSellableUnits`), because
 * the property lock alone would let two properties overshoot it together.
 *
 * Every write runs inside `withLockedProperty` (lock, re-check access, write),
 * every query carries the organization and the resolved property as predicates,
 * and every mutation enriches the request's one audit row with the entity it
 * acted on. Forced row-level security is the second wall, never the only one.
 */
import { TRPCError } from '@trpc/server';
import { z, ZodRealError, type ZodError } from 'zod';

import { Prisma, type HotelProperty } from '@/generated/prisma/client';
import { recordHotelAudit } from '@/lib/hotel/audit';
import { evaluateHotelFeatures, hotelRoomLimit } from '@/lib/hotel/features';
import {
  HOTEL_INVENTORY_KINDS,
  HOTEL_INVENTORY_KIND_DESCRIPTIONS,
  HOTEL_INVENTORY_KIND_LABELS,
  HOTEL_ROOM_BLOCK_KINDS,
  HOTEL_ROOM_BLOCK_KIND_DESCRIPTIONS,
  HOTEL_ROOM_BLOCK_KIND_LABELS,
  HOTEL_GENDER_POLICIES,
  HOTEL_GENDER_POLICY_LABELS,
  HOTEL_INVENTORY_STATUSES,
  HOTEL_ROOM_STATUS_LABELS,
  HOUSEKEEPING_ROOM_STATUSES,
  HotelInventoryError,
  applyInventoryActor,
  createInventoryBlock,
  createInventoryRoom,
  hotelInventoryRoomInput,
  hotelInventoryStatusInput,
  hotelRoomBlockCreateInput,
  hotelRoomBlockReleaseInput,
  hotelRoomCreateInput,
  hotelRoomTypeCreateInput,
  inventoryWhere,
  releaseInventoryBlock,
  reserveSellableUnits,
  sellableUnitsOf,
  sellableUnitsUsed,
  setInventoryStatus,
  type HotelInventoryKindValue,
  type HotelInventoryScope,
  type HotelRoomStatusValue,
  type InventoryDb,
} from '@/lib/hotel/inventory';
import { readHotelModeOverrides } from '@/lib/hotel/mode-overrides';
import { hasModule } from '@/lib/entitlements';
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
import { capabilityProcedure, protectedProcedure, router, type TRPCContext } from '../trpc';
import { hotelAvailability } from './hotel-reservations';

const propertyAdmin = capabilityProcedure('hotel:property-admin');

/**
 * The property selection joined onto a lib contract as ONE parser. tRPC runs
 * each `.input()` against the whole raw payload, so a second strict parser
 * would refuse the `branchId` the first one accepted; extending keeps the lib
 * schema strict and its refinements intact.
 */
function selected<Shape extends z.ZodRawShape, Config extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<Shape, Config>
) {
  return schema.extend(hotelPropertySelectionInput.shape);
}

/** The lib contract's own fields, with the selection the router consumed removed. */
function withoutSelection<T extends { branchId: string }>(input: T): Omit<T, 'branchId'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { branchId, ...fields } = input;
  return fields;
}

/**
 * A rule the database enforces but the input schema cannot see — a code or a
 * room number already taken in this property — stated as a field error, so it
 * reaches the form through `data.validation` exactly like a shape failure does.
 */
function fieldError(field: string, message: string): ZodError {
  return new ZodRealError([{ code: 'custom', path: [field], message, input: undefined }]);
}

/**
 * Which kinds this property may add right now: the property's own
 * configuration (mode plus explicit overrides) against the organization's
 * entitlements. Computed per request from the stored property, never from the
 * room type the caller proposes.
 */
function enabledKinds(
  property: Pick<HotelProperty, 'mode' | 'modeOverrides'>,
  entitlements: EntitlementSnapshot
): Record<HotelInventoryKindValue, boolean> {
  const configuration = applyHotelModeDefaults(
    property.mode,
    readHotelModeOverrides(property.modeOverrides)
  );
  const features = evaluateHotelFeatures(configuration, entitlements);
  return {
    ROOM: features.rooms && configuration.inventoryKinds.includes('ROOM'),
    BED: features.beds,
    UNIT: features.units,
  };
}

function requireKind(
  property: Pick<HotelProperty, 'mode' | 'modeOverrides'>,
  entitlements: EntitlementSnapshot,
  kind: HotelInventoryKindValue
): void {
  if (enabledKinds(property, entitlements)[kind]) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: `This property is not configured to sell ${HOTEL_INVENTORY_KIND_LABELS[kind].toLowerCase()} inventory. Change how the property operates in property settings, or ask your DevFathom account manager about the package.`,
    cause: fieldError(
      'inventoryKind',
      `Not available for this property: ${HOTEL_INVENTORY_KIND_LABELS[kind].toLowerCase()} inventory.`
    ),
  });
}

/** The `hotel.rooms.max` ceiling, bootstrapped (`hotel-core.` prefixed) or explicit. */
function roomLimit(entitlements: EntitlementSnapshot): number {
  return hotelRoomLimit(entitlements);
}

/**
 * Translate the engine's refusals and the two constraints an operator can
 * actually hit into sentences they can act on, and re-throw everything else: a
 * swallowed database error is worse than a blunt one.
 */
function mapInventoryError(error: unknown): never {
  if (error instanceof HotelInventoryError) {
    throw new TRPCError({
      code: error.code,
      message: error.message,
      cause: error.field ? fieldError(error.field, error.message) : error,
    });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = uniqueViolationColumns(error);
    const field = target.some((column) => column.includes('code'))
      ? 'code'
      : target.some((column) => column.includes('number'))
        ? 'number'
        : target.some((column) => column.includes('label'))
          ? 'label'
          : null;
    if (field) {
      const message =
        field === 'code'
          ? 'This property already has a room type with that code. Choose another.'
          : field === 'number'
            ? 'This property already has a room with that number. Choose another.'
            : 'This room already has a bed with that label.';
      throw new TRPCError({ code: 'BAD_REQUEST', message, cause: fieldError(field, message) });
    }
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'That inventory record already exists. Reload and try again.',
      cause: error,
    });
  }
  if (hasSqlState(error, '23P01')) {
    const message =
      'This room already has a live block over those dates. Release or shorten it first.';
    throw new TRPCError({ code: 'CONFLICT', message, cause: fieldError('startDate', message) });
  }
  if (hasSqlState(error, '23514')) {
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'The inventory changed underneath this request and the database refused the write. Reload the board and decide again.',
      cause: error,
    });
  }
  throw error;
}

/**
 * Run one inventory write inside the locked property transaction, with the
 * actor and the reason handed to the status and block triggers.
 */
async function inventoryOperation<T>(
  ctx: PropertyContext,
  property: HotelProperty,
  reason: string,
  run: (db: InventoryDb, scope: HotelInventoryScope) => Promise<T>
): Promise<T> {
  const user = ctx.session?.user;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const scope: HotelInventoryScope = {
    organizationId: ctx.entitlements.organizationId,
    branchId: property.branchId,
    actorId: user.id,
  };
  try {
    await applyInventoryActor(ctx.db, scope, reason);
    return await run(ctx.db, scope);
  } catch (error) {
    mapInventoryError(error);
  }
}

/**
 * Lock the property and resolve who is changing a status: a property
 * administrator may set anything the matrix allows; otherwise housekeeping may
 * set its three statuses. The second check runs only when the first is a
 * FORBIDDEN, so any other failure (a dead session, a missing property) is
 * reported as what it is.
 */
function withStatusActor<T>(
  ctx: TRPCContext,
  branchId: string,
  run: (
    ctx: PropertyContext,
    property: HotelProperty,
    allowed: readonly HotelRoomStatusValue[] | undefined
  ) => Promise<T>
): Promise<T> {
  let allowed: readonly HotelRoomStatusValue[] | undefined;
  return withLockedProperty(
    ctx,
    branchId,
    (lockedCtx, property) => run(lockedCtx, property, allowed),
    async (lockedCtx) => {
      try {
        return await currentProperty(lockedCtx, branchId, 'hotel:property-admin');
      } catch (error) {
        if (!(error instanceof TRPCError) || error.code !== 'FORBIDDEN') throw error;
      }
      allowed = HOUSEKEEPING_ROOM_STATUSES;
      return currentProperty(lockedCtx, branchId, 'hotel:housekeeping');
    }
  );
}

const roomListInput = hotelPropertySelectionInput.extend({
  roomTypeId: z.string().trim().min(1).max(191).optional(),
  includeInactive: z.boolean().default(false),
});

const blockListInput = hotelPropertySelectionInput.extend({
  roomId: z.string().trim().min(1).max(191).optional(),
  includeReleased: z.boolean().default(false),
});

/** The named choices a form needs, already labelled for an operator. */
const statusOptions = HOTEL_INVENTORY_STATUSES.map((value) => ({
  value,
  label: HOTEL_ROOM_STATUS_LABELS[value],
  housekeeping: HOUSEKEEPING_ROOM_STATUSES.includes(value),
}));
const blockKindOptions = HOTEL_ROOM_BLOCK_KINDS.map((value) => ({
  value,
  label: HOTEL_ROOM_BLOCK_KIND_LABELS[value],
  description: HOTEL_ROOM_BLOCK_KIND_DESCRIPTIONS[value],
}));
const genderPolicyOptions = HOTEL_GENDER_POLICIES.map((value) => ({
  value,
  label: HOTEL_GENDER_POLICY_LABELS[value],
}));

export const hotelInventoryRouter = router({
  /** Operational projection; front desk gets occupant identity, housekeeping does not. */
  statusBoard: protectedProcedure.input(hotelPropertySelectionInput).query(async ({ ctx, input }) => {
    if (!hasModule(ctx.entitlements, 'hotel-front-desk'))
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Front desk operations are not enabled.' });
    let audience: 'front-desk' | 'housekeeping' = 'front-desk';
    let property: HotelProperty;
    try {
      property = await currentProperty(ctx, input.branchId, 'hotel:front-desk');
    } catch (error) {
      if (!(error instanceof TRPCError) || error.code !== 'FORBIDDEN') throw error;
      audience = 'housekeeping';
      property = await currentProperty(ctx, input.branchId, 'hotel:housekeeping');
    }
    const today = property.businessDate;
    const rooms = await ctx.db.hotelRoom.findMany({
      where: { organizationId: ctx.entitlements.organizationId, branchId: property.branchId, active: true },
      orderBy: [{ number: 'asc' }],
      include: {
        roomType: { select: { id: true, code: true, name: true } },
        beds: { where: { active: true }, orderBy: { label: 'asc' } },
        blocks: { where: { releasedAt: null, startDate: { lte: today }, endDate: { gt: today } }, take: 1 },
        assignments: { where: { status: { in: ['HELD', 'ACTIVE'] }, startDate: { lte: today }, endDate: { gt: today } }, include: { stayUnit: { include: { reservation: { include: { primaryGuest: { select: { firstName: true, lastName: true } } } } } } } },
      },
    });
    return { audience, businessDate: today, rooms: rooms.map((room) => ({
      id: room.id, number: room.number, status: room.status, roomType: room.roomType, beds: room.beds,
      activeBlock: room.blocks[0] ?? null,
      allowedTransitions: audience === 'housekeeping'
        ? (room.status === 'VACANT_DIRTY' ? ['CLEANING'] : room.status === 'CLEANING' ? ['INSPECTED', 'VACANT_DIRTY'] : room.status === 'INSPECTED' ? ['VACANT_CLEAN', 'VACANT_DIRTY'] : [])
        : [],
      ...(audience === 'front-desk' ? { occupant: room.assignments.find((assignment) => assignment.status === 'ACTIVE')?.stayUnit.reservation.primaryGuest ?? null,
        nextArrival: room.assignments.filter((assignment) => assignment.status === 'HELD').sort((a, b) => a.startDate.getTime() - b.startDate.getTime())[0]?.startDate ?? null } : {}),
    })) };
  }),

  availabilityCalendar: capabilityProcedure('hotel:reservations').input(hotelPropertySelectionInput.extend({
    startDate: z.coerce.date(), days: z.number().int().min(1).max(31).default(14),
  })).query(async ({ ctx, input }) => {
    if (!hasModule(ctx.entitlements, 'hotel-reservations')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Reservations are not enabled.' });
    const property = await currentProperty(ctx, input.branchId, 'hotel:reservations');
    const dates = Array.from({ length: input.days }, (_, offset) => {
      const date = new Date(input.startDate); date.setUTCDate(date.getUTCDate() + offset); return date;
    });
    const calendar = await Promise.all(dates.map(async (date) => {
      const departure = new Date(date); departure.setUTCDate(departure.getUTCDate() + 1);
      return { date, roomTypes: await hotelAvailability(ctx.db as Prisma.TransactionClient, ctx.entitlements.organizationId, property.branchId, date, departure) };
    }));
    return { startDate: input.startDate, days: calendar };
  }),

  roomTypes: router({
    /** The property's types, which kinds it may add, and how much of the room ceiling is used. */
    list: propertyAdmin.input(hotelPropertySelectionInput).query(async ({ ctx, input }) => {
      const property = await currentProperty(ctx, input.branchId);
      const where = {
        organizationId: ctx.entitlements.organizationId,
        branchId: property.branchId,
      };
      const roomTypes = await ctx.db.hotelRoomType.findMany({
        where,
        orderBy: [{ sort: 'asc' }, { code: 'asc' }],
        include: { _count: { select: { rooms: true } } },
      });
      const enabled = enabledKinds(property, ctx.entitlements);
      const used = await sellableUnitsUsed(ctx.db, ctx.entitlements.organizationId);
      return {
        roomTypes,
        kindOptions: HOTEL_INVENTORY_KINDS.map((value) => ({
          value,
          label: HOTEL_INVENTORY_KIND_LABELS[value],
          description: HOTEL_INVENTORY_KIND_DESCRIPTIONS[value],
          enabled: enabled[value],
        })),
        roomLimit: { max: roomLimit(ctx.entitlements), used },
      };
    }),

    /** Add a sellable class of inventory to this property. */
    create: propertyAdmin.input(selected(hotelRoomTypeCreateInput)).mutation(({ ctx, input }) =>
      withLockedProperty(ctx, input.branchId, async (ctx, property) => {
        requireKind(property, ctx.entitlements, input.inventoryKind);
        try {
          const roomType = await ctx.db.hotelRoomType.create({
            data: {
              ...withoutSelection(input),
              organizationId: ctx.entitlements.organizationId,
              branchId: property.branchId,
            },
          });
          recordHotelAudit(ctx, {
            entity: { type: 'HotelRoomType', id: roomType.id, label: roomType.name },
            action: 'hotel.inventory.roomType.create',
            operation: 'CREATE',
            after: roomType,
            metadata: { branchId: property.branchId },
          });
          return { roomType };
        } catch (error) {
          mapInventoryError(error);
        }
      })
    ),
  }),

  rooms: router({
    /** The rooms, with their type, beds and live blocks, ordered by number. */
    list: propertyAdmin.input(roomListInput).query(async ({ ctx, input }) => {
      const property = await currentProperty(ctx, input.branchId);
      const rooms = await ctx.db.hotelRoom.findMany({
        where: {
          organizationId: ctx.entitlements.organizationId,
          branchId: property.branchId,
          ...(input.roomTypeId ? { roomTypeId: input.roomTypeId } : {}),
          ...(input.includeInactive ? {} : { active: true }),
        },
        orderBy: [{ number: 'asc' }, { id: 'asc' }],
        include: {
          roomType: {
            select: { id: true, code: true, name: true, inventoryKind: true, bedsPerRoom: true },
          },
          connectingRoom: { select: { id: true, number: true } },
          beds: { orderBy: { label: 'asc' } },
          blocks: { where: { releasedAt: null }, orderBy: { startDate: 'asc' } },
        },
      });
      return { rooms, statusOptions, blockKindOptions, genderPolicyOptions };
    }),

    /** Commission a room (or a dorm room, or a unit) under one of the property's types. */
    create: propertyAdmin.input(selected(hotelRoomCreateInput)).mutation(({ ctx, input }) =>
      withLockedProperty(ctx, input.branchId, (ctx, property) =>
        inventoryOperation(ctx, property, input.reason, async (db, scope) => {
          const roomType = await db.hotelRoomType.findFirst({
            where: { ...inventoryWhere(scope), id: input.roomTypeId },
          });
          if (!roomType) {
            throw new HotelInventoryError(
              'NOT_FOUND',
              'That room type is not one of this property’s.',
              'roomTypeId'
            );
          }
          requireKind(property, ctx.entitlements, roomType.inventoryKind);
          // The ceiling spans the organization while the lock above covers one
          // property, so the count is serialised on the organization first.
          await reserveSellableUnits(
            db,
            scope.organizationId,
            sellableUnitsOf(roomType),
            roomLimit(ctx.entitlements)
          );
          const room = await createInventoryRoom(db, scope, withoutSelection(input));
          recordHotelAudit(ctx, {
            entity: { type: 'HotelRoom', id: room.id, label: room.number },
            action: 'hotel.inventory.room.create',
            operation: 'CREATE',
            after: { number: room.number, roomTypeId: room.roomTypeId, beds: room.beds.length },
            metadata: { branchId: property.branchId, reason: input.reason },
          });
          return { room };
        })
      )
    ),

    /** Change a room's status, with the reason the ledger records. */
    setStatus: protectedProcedure
      .input(selected(hotelInventoryStatusInput))
      .mutation(({ ctx, input }) =>
        withStatusActor(ctx, input.branchId, (ctx, property, allowed) =>
          inventoryOperation(ctx, property, input.reason, async (db, scope) => {
            const result = await setInventoryStatus(
              db,
              scope,
              'room',
              withoutSelection(input),
              allowed
            );
            recordHotelAudit(ctx, {
              entity: { type: 'HotelRoom', id: result.id },
              action: 'hotel.inventory.room.status',
              before: { status: input.expectedStatus },
              after: { status: result.status },
              metadata: { branchId: property.branchId, reason: input.reason },
            });
            return result;
          })
        )
      ),

    /**
     * The attributed, append-only history of one room (its beds included),
     * with each actor named rather than shown as an id (UX rule 1). A member
     * who has since left is reported as unknown, never guessed.
     */
    history: propertyAdmin
      .input(selected(hotelInventoryRoomInput))
      .query(async ({ ctx, input }) => {
        const property = await currentProperty(ctx, input.branchId);
        const organizationId = ctx.entitlements.organizationId;
        const events = await ctx.db.hotelRoomStatusEvent.findMany({
          where: { organizationId, branchId: property.branchId, roomId: input.roomId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 200,
        });
        const actorIds = [...new Set(events.map((event) => event.actorId))];
        const actors = actorIds.length
          ? await ctx.db.user.findMany({
              where: { organizationId, id: { in: actorIds } },
              select: { id: true, name: true },
            })
          : [];
        const names = new Map(actors.map((actor) => [actor.id, actor.name]));
        return events.map((event) => ({ ...event, actorName: names.get(event.actorId) ?? null }));
      }),
  }),

  beds: router({
    list: propertyAdmin.input(selected(hotelInventoryRoomInput)).query(async ({ ctx, input }) => {
      const property = await currentProperty(ctx, input.branchId);
      return ctx.db.hotelBed.findMany({
        where: {
          organizationId: ctx.entitlements.organizationId,
          branchId: property.branchId,
          roomId: input.roomId,
        },
        orderBy: { label: 'asc' },
      });
    }),

    /** Change one berth's status, under the same rules as a room's. */
    setStatus: protectedProcedure
      .input(selected(hotelInventoryStatusInput))
      .mutation(({ ctx, input }) =>
        withStatusActor(ctx, input.branchId, (ctx, property, allowed) =>
          inventoryOperation(ctx, property, input.reason, async (db, scope) => {
            const result = await setInventoryStatus(
              db,
              scope,
              'bed',
              withoutSelection(input),
              allowed
            );
            recordHotelAudit(ctx, {
              entity: { type: 'HotelBed', id: result.id },
              action: 'hotel.inventory.bed.status',
              before: { status: input.expectedStatus },
              after: { status: result.status },
              metadata: { branchId: property.branchId, reason: input.reason },
            });
            return result;
          })
        )
      ),
  }),

  blocks: router({
    list: propertyAdmin.input(blockListInput).query(async ({ ctx, input }) => {
      const property = await currentProperty(ctx, input.branchId);
      return ctx.db.hotelRoomBlock.findMany({
        where: {
          organizationId: ctx.entitlements.organizationId,
          branchId: property.branchId,
          ...(input.roomId ? { roomId: input.roomId } : {}),
          ...(input.includeReleased ? {} : { releasedAt: null }),
        },
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
        include: { room: { select: { id: true, number: true } } },
      });
    }),

    /** Withhold a room from sale for a date range. */
    create: propertyAdmin.input(selected(hotelRoomBlockCreateInput)).mutation(({ ctx, input }) =>
      withLockedProperty(ctx, input.branchId, (ctx, property) =>
        inventoryOperation(ctx, property, input.reason, async (db, scope) => {
          const block = await createInventoryBlock(db, scope, withoutSelection(input));
          recordHotelAudit(ctx, {
            entity: { type: 'HotelRoomBlock', id: block.id },
            action: 'hotel.inventory.block.create',
            operation: 'CREATE',
            after: {
              roomId: block.roomId,
              kind: block.kind,
              startDate: input.startDate,
              endDate: input.endDate,
            },
            metadata: { branchId: property.branchId, reason: input.reason },
          });
          return { block };
        })
      )
    ),

    /** Return a room to sale before the block's end date. */
    release: propertyAdmin.input(selected(hotelRoomBlockReleaseInput)).mutation(({ ctx, input }) =>
      withLockedProperty(ctx, input.branchId, (ctx, property) =>
        inventoryOperation(ctx, property, input.reason, async (db, scope) => {
          const block = await releaseInventoryBlock(db, scope, withoutSelection(input));
          recordHotelAudit(ctx, {
            entity: { type: 'HotelRoomBlock', id: block.id },
            action: 'hotel.inventory.block.release',
            before: { releasedAt: null },
            after: { releasedAt: block.releasedAt },
            metadata: { branchId: property.branchId, reason: input.reason },
          });
          return { block };
        })
      )
    ),
  }),
});
