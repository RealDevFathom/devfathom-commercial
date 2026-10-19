/**
 * PROP-01 / PROP-02 / PROP-03 / HK-03 / COMP-01 — the property settings surface.
 *
 * Most of this router gates on `hotel:property-admin` (06 §1: "property, modes,
 * room types/rooms/beds/units, slots, extras, spaces, tax profile, compliance
 * exports and submissions, retention, journey templates"), through the ABAC
 * engine and its default-deny catalogue. Reads are included: a property record
 * carries the booking-engine slug, the tax profile and the audit time, which are
 * configuration rather than operating data.
 *
 * Two groups are deliberately wider, because 06 §1 gives them to housekeeping —
 * "board, tasks, inspections, blocks" — and the role matrix (06 §2) gives a
 * Housekeeping Supervisor `hk` with no `prop-admin` at all:
 *
 * - `rooms.setStatus` and `rooms.history`, where a housekeeper may set the
 *   cleaning statuses and a property administrator may set any status the
 *   transition matrix allows; and
 * - `blocks.*`, the out-of-order / out-of-service ranges of HK-03.
 *
 * Both run through {@link inventoryProcedure}, which asks the engine for each
 * capability separately and hands the resolver what the caller actually holds.
 * Neither surface widens what the domain permits: `OCCUPIED` is refused to both,
 * because a room becomes occupied by a check-in.
 *
 * `modes.set` is validation only. MODE-01 makes the mode configuration that
 * selects defaults, so this lane records the decision and refuses an unknown one;
 * the defaults each mode implies arrive with H1-02 and belong to that layer, not
 * to a conditional here. Nothing below asks what mode a property is in.
 *
 * Every query carries an explicit `organizationId` predicate. Forced row-level
 * security is the second wall and never the only one.
 */
import { TRPCError } from '@trpc/server';

import type { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import {
  HOTEL_GENDER_POLICY_LABELS,
  HOTEL_INVENTORY_KINDS,
  HOTEL_INVENTORY_KIND_DESCRIPTIONS,
  HOTEL_INVENTORY_KIND_LABELS,
  HOTEL_ROOM_BLOCK_KINDS,
  HOTEL_ROOM_BLOCK_KIND_LABELS,
  HOTEL_ROOM_STATUSES,
  HOTEL_ROOM_STATUS_LABELS,
  HOUSEKEEPING_ROOM_STATUSES,
  calendarDay,
  deriveBedOccupancy,
  hotelBedInput,
  hotelRoomBlockInput,
  hotelRoomInput,
  hotelRoomStatusInput,
  hotelRoomTypeInput,
  planRoomStatusChange,
  type HotelRoomStatusValue,
} from '@/lib/hotel/inventory';
import { evaluateHotelReadiness, hotelActivationSummary } from '@/lib/hotel/onboarding-checklist';
import {
  HOTEL_PROPERTY_MODES,
  HOTEL_PROPERTY_MODE_DESCRIPTIONS,
  HOTEL_PROPERTY_MODE_LABELS,
  hotelPropertyModeInput,
  hotelPropertyUpdateInput,
} from '@/lib/hotel/property';
import {
  auditedProtectedProcedure,
  capabilityProcedure,
  router,
  type TRPCContext,
} from '../trpc';

const propertyAdmin = capabilityProcedure('hotel:property-admin');

/**
 * Room status and blocks: property administration OR housekeeping, with the
 * resolver told which. Built on `auditedProtectedProcedure` so reads stay
 * audited like the rest of this router; the two capability questions are asked
 * of the same ABAC engine `capabilityProcedure` uses, so there is still one
 * decision point and it is still default-deny.
 */
const inventoryProcedure = auditedProtectedProcedure.use(async ({ ctx, next }) => {
  const user = ctx.session?.user;
  if (!user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'You must be logged in.' });
  }
  const subject = subjectFromSession(user);
  const opts = {
    db: ctx.db as Prisma.TransactionClient,
    source: 'TRPC' as const,
    ip: ctx.requestMeta.ip,
  };
  // Asked in sequence rather than in parallel: the tenant client serialises its
  // statements anyway, and a denied first answer makes the second one moot.
  const propertyAdminGrant = await can(subject, 'hotel:property-admin', undefined, opts);
  const housekeepingGrant = propertyAdminGrant
    ? false
    : await can(subject, 'hotel:housekeeping', undefined, opts);

  if (!propertyAdminGrant && !housekeepingGrant) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
  }

  return next({
    ctx: {
      ...ctx,
      // A property administrator may set any status the matrix allows; a
      // housekeeper may set the cleaning statuses. Neither may set OCCUPIED —
      // `planRoomStatusChange` refuses that to every caller.
      settableStatuses: propertyAdminGrant
        ? (HOTEL_ROOM_STATUSES as readonly HotelRoomStatusValue[])
        : HOUSEKEEPING_ROOM_STATUSES,
    },
  });
});

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

/**
 * A validated policy object on its way into a JSONB column. The round-trip drops
 * anything Prisma's `InputJsonValue` cannot carry (undefined members, prototypes)
 * rather than asserting the shape and hoping.
 */
function inputJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** The mode choices, already named for an operator (UX rule 1: no bare codes). */
const modeOptions = HOTEL_PROPERTY_MODES.map((mode) => ({
  value: mode,
  label: HOTEL_PROPERTY_MODE_LABELS[mode],
  description: HOTEL_PROPERTY_MODE_DESCRIPTIONS[mode],
}));

const inventoryKindOptions = HOTEL_INVENTORY_KINDS.map((kind) => ({
  value: kind,
  label: HOTEL_INVENTORY_KIND_LABELS[kind],
  description: HOTEL_INVENTORY_KIND_DESCRIPTIONS[kind],
}));

const roomStatusOptions = HOTEL_ROOM_STATUSES.map((status) => ({
  value: status,
  label: HOTEL_ROOM_STATUS_LABELS[status],
}));

const blockKindOptions = HOTEL_ROOM_BLOCK_KINDS.map((kind) => ({
  value: kind,
  label: HOTEL_ROOM_BLOCK_KIND_LABELS[kind],
}));

const genderPolicyOptions = (
  Object.keys(HOTEL_GENDER_POLICY_LABELS) as (keyof typeof HOTEL_GENDER_POLICY_LABELS)[]
).map((value) => ({ value, label: HOTEL_GENDER_POLICY_LABELS[value] }));

/** The property, or the sentence that says who creates one. */
async function requireProperty(ctx: TRPCContext) {
  const property = await currentProperty(ctx);
  if (!property) throw notProvisioned();
  return property;
}

/** The acting user, for the `actorId` every status line and block carries. */
function actorId(ctx: TRPCContext): string {
  const id = ctx.session?.user?.id;
  if (!id) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'You must be logged in.' });
  return id;
}

/** A room type of this tenant's property, or a 404 that names the type. */
async function requireRoomType(ctx: TRPCContext, branchId: string, roomTypeId: string) {
  const roomType = await ctx.db.hotelRoomType.findFirst({
    where: { organizationId: ctx.entitlements.organizationId, branchId, id: roomTypeId },
  });
  if (!roomType) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'That room type is not on this property.' });
  }
  return roomType;
}

/** A room of this tenant's property, or a 404 that names the room. */
async function requireRoom(ctx: TRPCContext, branchId: string, roomId: string) {
  const room = await ctx.db.hotelRoom.findFirst({
    where: { organizationId: ctx.entitlements.organizationId, branchId, id: roomId },
  });
  if (!room) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'That room is not on this property.' });
  }
  return room;
}

/** The refusal codes of `planRoomStatusChange`, as tRPC statuses. */
const STATUS_REFUSAL_CODES = {
  UNCHANGED: 'BAD_REQUEST',
  STAY_OWNED: 'BAD_REQUEST',
  NOT_ALLOWED: 'BAD_REQUEST',
  NOT_PERMITTED: 'FORBIDDEN',
} as const;

export const hotelPropertyRouter = router({
  /** The property, its mode choices, and where onboarding currently stands. */
  get: propertyAdmin.query(async ({ ctx }) => {
    const [property, readiness] = await Promise.all([
      currentProperty(ctx),
      evaluateHotelReadiness(ctx.db, ctx.entitlements.organizationId),
    ]);
    return {
      property,
      modeOptions,
      checklist: readiness,
      activationSummary: hotelActivationSummary(readiness),
    };
  }),

  /** PROP-01 — record the property's own facts. */
  update: propertyAdmin.input(hotelPropertyUpdateInput).mutation(async ({ ctx, input }) => {
    const property = await currentProperty(ctx);
    if (!property) throw notProvisioned();

    // The write is scoped by `(organizationId, branchId)` rather than by the
    // primary key alone, so a crafted request cannot address another tenant's
    // property even if RLS were ever relaxed for a maintenance connection.
    await ctx.db.hotelProperty.updateMany({
      where: {
        organizationId: ctx.entitlements.organizationId,
        branchId: property.branchId,
      },
      data: {
        name: input.name,
        addressLine: input.addressLine,
        city: input.city,
        timezone: input.timezone,
        starCategory: input.starCategory ?? null,
        checkInTime: input.checkInTime,
        checkOutTime: input.checkOutTime,
        auditTime: input.auditTime,
        currency: input.currency,
        taxProfileId: input.taxProfileId ?? null,
        languages: input.languages,
        bookingEngineSlug: input.bookingEngineSlug,
        ...(input.overbookPolicy ? { overbookPolicy: inputJson(input.overbookPolicy) } : {}),
        ...(input.journeySettings ? { journeySettings: inputJson(input.journeySettings) } : {}),
        ...(input.mealAllocationPolicy
          ? { mealAllocationPolicy: inputJson(input.mealAllocationPolicy) }
          : {}),
        ...(input.businessDatePolicy
          ? { businessDatePolicy: inputJson(input.businessDatePolicy) }
          : {}),
      },
    });

    const readiness = await evaluateHotelReadiness(ctx.db, ctx.entitlements.organizationId);
    return { checklist: readiness, activationSummary: hotelActivationSummary(readiness) };
  }),

  modes: router({
    /** The current mode and the closed set it may be changed to. */
    get: propertyAdmin.query(async ({ ctx }) => {
      const property = await currentProperty(ctx);
      if (!property) throw notProvisioned();
      return { mode: property.mode, options: modeOptions };
    }),

    /**
     * Record the mode. Validation only: the input schema is the closed set, and
     * nothing downstream reads the value to pick a branch of behaviour.
     */
    set: propertyAdmin.input(hotelPropertyModeInput).mutation(async ({ ctx, input }) => {
      const property = await currentProperty(ctx);
      if (!property) throw notProvisioned();
      await ctx.db.hotelProperty.updateMany({
        where: {
          organizationId: ctx.entitlements.organizationId,
          branchId: property.branchId,
        },
        data: { mode: input.mode },
      });
      return { mode: input.mode };
    }),
  }),
});
