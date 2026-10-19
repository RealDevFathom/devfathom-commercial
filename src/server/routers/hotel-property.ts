/**
 * PROP-01 / COMP-01 — the property settings surface.
 *
 * Every procedure here gates on `hotel:property-admin` (06 §1: "property, modes,
 * room types/rooms/beds/units, slots, extras, spaces, tax profile, compliance
 * exports and submissions, retention, journey templates"), through the ABAC
 * engine and its default-deny catalogue. Reads are included: a property record
 * carries the booking-engine slug, the tax profile and the audit time, which are
 * configuration rather than operating data.
 *
 * `modes.set` is validation only. MODE-01 makes the mode configuration that
 * selects defaults, so this lane records the decision and refuses an unknown one;
 * the defaults each mode implies arrive with H1-02 and belong to that layer, not
 * to a conditional here.
 *
 * Every query carries an explicit `organizationId` predicate. Forced row-level
 * security is the second wall and never the only one.
 */
import { TRPCError } from '@trpc/server';

import type { HotelProperty, Prisma } from '@/generated/prisma/client';
import { evaluateHotelFeatures } from '@/lib/hotel/features';
import { applyHotelModeDefaults } from '@/lib/hotel/modes';
import { evaluateHotelReadiness, hotelActivationSummary } from '@/lib/hotel/onboarding-checklist';
import {
  HOTEL_PROPERTY_MODES,
  HOTEL_PROPERTY_MODE_DESCRIPTIONS,
  HOTEL_PROPERTY_MODE_LABELS,
  hotelPropertyModeInput,
  hotelPropertyUpdateInput,
} from '@/lib/hotel/property';
import {
  createInventoryRoom,
  createInventoryBlock,
  releaseInventoryBlock,
  setInventoryStatus,
  withHotelInventory,
  inventoryWhere,
  HotelInventoryError,
  hotelRoomTypeCreateInput,
  hotelRoomCreateInput,
  hotelInventoryRoomInput,
  hotelInventoryStatusInput,
  hotelRoomBlockCreateInput,
  hotelRoomBlockReleaseInput,
  type HotelInventoryScope,
} from '@/lib/hotel/inventory';
import type { PrismaClient } from '@/generated/prisma/client';
import { annotateAudit } from '@/server/audit';
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

/** Reuse the foundation's server-selected property; the client cannot select another branch. */
async function inventoryOperation<T>(
  ctx: TRPCContext,
  reason: string,
  run: (db: PrismaClient, scope: HotelInventoryScope, property: HotelProperty) => Promise<T>
): Promise<T> {
  if (!ctx.session?.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const property = await currentProperty(ctx);
  if (!property) throw notProvisioned();
  const scope = {
    organizationId: ctx.entitlements.organizationId,
    branchId: property.branchId,
    actorId: ctx.session.user.id,
  };
  annotateAudit(ctx, { metadata: { branchId: scope.branchId, reason } });
  try {
    return await withHotelInventory(ctx.db, scope, reason, (db) => run(db, scope, property));
  } catch (error) {
    // Rethrow outside the service transaction; failures never become commits.
    if (error instanceof HotelInventoryError)
      throw new TRPCError({ code: error.code, message: error.message, cause: error });
    const driverCause = (
      error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }
    )?.meta?.driverAdapterError?.cause;
    if (driverCause?.originalCode === '23P01') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Room block overlaps an existing block.',
        cause: error,
      });
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Inventory identifier already exists.',
        cause: error,
      });
    }
    throw error;
  }
}

export const hotelPropertyRouter = router({
  roomTypes: router({
    list: propertyAdmin.query(({ ctx }) =>
      inventoryOperation(ctx, '', (db, scope) =>
        db.hotelRoomType.findMany({
          where: inventoryWhere(scope),
          orderBy: [{ sort: 'asc' }, { code: 'asc' }],
        })
      )
    ),
    create: propertyAdmin
      .input(hotelRoomTypeCreateInput)
      .mutation(({ ctx, input }) =>
        inventoryOperation(ctx, 'Create room type', (db, scope) =>
          db.hotelRoomType.create({ data: { ...input, ...inventoryWhere(scope) } })
        )
      ),
  }),
  rooms: router({
    list: propertyAdmin.query(({ ctx }) =>
      inventoryOperation(ctx, '', (db, scope) =>
        db.hotelRoom.findMany({
          where: inventoryWhere(scope),
          include: { roomType: true, beds: true },
          orderBy: { number: 'asc' },
        })
      )
    ),
    create: propertyAdmin.input(hotelRoomCreateInput).mutation(({ ctx, input }) =>
      inventoryOperation(ctx, input.reason, async (db, scope, property) => {
        const roomType = await db.hotelRoomType.findFirst({
          where: { ...inventoryWhere(scope), id: input.roomTypeId },
        });
        if (!roomType) throw new HotelInventoryError('NOT_FOUND', 'Room type not found.');
        // The configured room type enables inventory beyond mode defaults;
        // only the authoritative request snapshot can grant room entitlement.
        const configuration = applyHotelModeDefaults(property.mode, {
          inventoryKinds: [roomType.inventoryKind],
        });
        if (!evaluateHotelFeatures(configuration, ctx.entitlements).rooms) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Room creation is disabled by workspace entitlements.',
          });
        }
        return createInventoryRoom(db, scope, input);
      })
    ),
    setStatus: propertyAdmin
      .input(hotelInventoryStatusInput)
      .mutation(({ ctx, input }) =>
        inventoryOperation(ctx, input.reason, (db, scope) =>
          setInventoryStatus(db, scope, 'room', input)
        )
      ),
    history: propertyAdmin.input(hotelInventoryRoomInput).query(({ ctx, input }) =>
      inventoryOperation(ctx, '', (db, scope) =>
        db.hotelRoomStatusEvent.findMany({
          where: { ...inventoryWhere(scope), roomId: input.roomId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      )
    ),
  }),
  beds: router({
    list: propertyAdmin.input(hotelInventoryRoomInput).query(({ ctx, input }) =>
      inventoryOperation(ctx, '', (db, scope) =>
        db.hotelBed.findMany({
          where: { ...inventoryWhere(scope), roomId: input.roomId },
          orderBy: { label: 'asc' },
        })
      )
    ),
    setStatus: propertyAdmin
      .input(hotelInventoryStatusInput)
      .mutation(({ ctx, input }) =>
        inventoryOperation(ctx, input.reason, (db, scope) =>
          setInventoryStatus(db, scope, 'bed', input)
        )
      ),
  }),
  blocks: router({
    list: propertyAdmin.input(hotelInventoryRoomInput).query(({ ctx, input }) =>
      inventoryOperation(ctx, '', (db, scope) =>
        db.hotelRoomBlock.findMany({
          where: { ...inventoryWhere(scope), roomId: input.roomId },
          orderBy: { startDate: 'asc' },
        })
      )
    ),
    create: propertyAdmin
      .input(hotelRoomBlockCreateInput)
      .mutation(({ ctx, input }) =>
        inventoryOperation(ctx, input.reason, (db, scope) => createInventoryBlock(db, scope, input))
      ),
    release: propertyAdmin
      .input(hotelRoomBlockReleaseInput)
      .mutation(({ ctx, input }) =>
        inventoryOperation(ctx, input.reason, (db, scope) =>
          releaseInventoryBlock(db, scope, input)
        )
      ),
  }),

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
