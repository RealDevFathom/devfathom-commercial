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
 * MODE-01 persists the mode and explicit overrides. Defaults and feature flags
 * come from the shared helpers, using the current runtime entitlements.
 *
 * Every query carries an explicit `organizationId` predicate. Forced row-level
 * security is the second wall and never the only one.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import { evaluateHotelFeatures } from '@/lib/hotel/features';
import { hotelModeOverridesInput, readHotelModeOverrides } from '@/lib/hotel/mode-overrides';
import { applyHotelModeDefaults } from '@/lib/hotel/modes';
import {
  hotelDepartmentOptions,
  hotelExtraArchiveInput,
  hotelExtraFieldError,
  hotelExtraInput,
  hotelExtraListInput,
  hotelExtraRecurrenceOptions,
  hotelExtraUpdateInput,
  type HotelExtraInput,
} from '@/lib/hotel/extras';
import {
  evaluateHotelOnboarding,
  hotelEvidence,
  hotelActivationSummary,
} from '@/lib/hotel/onboarding-checklist';
import { HOSPITALITY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import {
  HOTEL_PROPERTY_MODES,
  HOTEL_PROPERTY_MODE_DESCRIPTIONS,
  HOTEL_PROPERTY_MODE_LABELS,
  hotelPropertyModeInput,
  hotelPropertyUpdateInput,
} from '@/lib/hotel/property';
import { annotateAudit } from '@/server/audit';
import {
  hotelCapabilityInput,
  hotelPropertySelectionInput,
  hotelRoleKeys,
  requireHotelPropertyScope,
} from '@/server/hotel-property-scope';
import {
  adminProcedure,
  capabilityProcedure,
  protectedProcedure,
  router,
  type TRPCContext,
} from '../trpc';

const propertyAdmin = capabilityProcedure('hotel:property-admin');

/** Every consumer must supply a selection; only fresh membership authorizes it. */
async function currentProperty(ctx: TRPCContext, branchId?: string) {
  if (!branchId)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Choose a property to continue.' });
  await requireHotelPropertyScope(ctx, branchId, 'hotel:property-admin');
  const property = await ctx.db.hotelProperty.findFirst({
    where: { organizationId: ctx.entitlements.organizationId, branchId, active: true },
  });
  if (!property)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This property is no longer available.' });
  return property;
}

async function propertyReadiness(
  ctx: TRPCContext,
  property: Awaited<ReturnType<typeof currentProperty>>
) {
  const keys = HOSPITALITY_ROLE_TEMPLATES.map((role) => role.key);
  const count = await ctx.db.organizationRole.count({
    where: { organizationId: ctx.entitlements.organizationId, key: { in: keys } },
  });
  return evaluateHotelOnboarding(
    ctx.entitlements.organizationId,
    hotelEvidence(property, count, keys.length, null)
  );
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

function noSuchExtra(): TRPCError {
  return new TRPCError({
    code: 'NOT_FOUND',
    message: 'That catalog item is not in this property’s extras list.',
  });
}

/**
 * PROP-05 — one code per property. The unique index is the guarantee; this read
 * exists so the operator gets the refusal on the `code` field rather than a
 * constraint name, and it is deliberately not a substitute for the index — two
 * simultaneous creates still lose to the database, which is the correct loser.
 */
async function refuseATakenCode(
  ctx: TRPCContext,
  branchId: string,
  code: string,
  exceptId: string | null
) {
  const clash = await ctx.db.hotelExtra.findFirst({
    where: { organizationId: ctx.entitlements.organizationId, branchId, code },
    select: { id: true, name: true },
  });
  if (!clash || clash.id === exceptId) return;
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: `The code ${code} is already used by “${clash.name}”.`,
    cause: hotelExtraFieldError(
      'code',
      `This property already charges ${code} — it is “${clash.name}”. Retire that item or choose another code.`
    ),
  });
}

/**
 * The catalog columns, from a validated input. `nameUr` and `upsellPriceMinor`
 * are normalized to null rather than left undefined, so clearing an Urdu name or
 * an offer price actually clears it instead of silently keeping the old value.
 */
function catalogFields(input: HotelExtraInput) {
  return {
    code: input.code,
    name: input.name,
    nameUr: input.nameUr ?? null,
    priceMinor: input.priceMinor,
    taxClass: input.taxClass,
    department: input.department,
    upsellable: input.upsellable,
    upsellPriceMinor: input.upsellable ? (input.upsellPriceMinor ?? null) : null,
    recurring: input.recurring,
    active: input.active,
    ...(input.postingRule ? { postingRule: inputJson(input.postingRule) } : {}),
  };
}

/** The mode choices, already named for an operator (UX rule 1: no bare codes). */
const modeOptions = HOTEL_PROPERTY_MODES.map((mode) => ({
  value: mode,
  label: HOTEL_PROPERTY_MODE_LABELS[mode],
  description: HOTEL_PROPERTY_MODE_DESCRIPTIONS[mode],
}));

export const hotelPropertyRouter = router({
  // WHA-1562 foundation only. Selection is an explicit request, not a persisted
  // grant. Existing Extras/currentProperty integration remains a separate lease.
  access: router({
    select: protectedProcedure
      .input(hotelPropertySelectionInput.extend({ capability: hotelCapabilityInput }))
      .query(({ ctx, input }) => requireHotelPropertyScope(ctx, input.branchId, input.capability)),

    assign: adminProcedure
      .input(
        hotelPropertySelectionInput.extend({
          userId: z.string().trim().min(1).max(128),
          organizationRoleId: z.string().trim().min(1).max(128),
        })
      )
      .mutation(async ({ ctx, input }) => {
        if (input.userId === ctx.session.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You cannot grant yourself property access.',
          });
        }
        const organizationId = ctx.entitlements.organizationId;
        const assignment = await ctx.db.$transaction(async (db) => {
          // Serialize assignment changes with other changes at this property.
          // RLS also applies to this lock. Never acquire an unscoped connection.
          await db.$queryRaw`SELECT "branchId" FROM "hotel_properties"
            WHERE "organizationId" = ${organizationId} AND "branchId" = ${input.branchId}
            FOR UPDATE`;
          await requireHotelPropertyScope({ ...ctx, db }, input.branchId, 'hotel:property-admin');
          const target = await db.user.findFirst({
            where: { organizationId, id: input.userId, status: { in: ['ACTIVE', 'ON_LEAVE'] } },
            select: { id: true },
          });
          const role = await db.organizationRole.findFirst({
            where: { organizationId, id: input.organizationRoleId, key: { in: hotelRoleKeys } },
            select: { id: true },
          });
          if (!target || !role) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Active member or Hotel role not found.',
            });
          }
          return db.hotelPropertyAssignment.upsert({
            where: {
              organizationId_branchId_userId: {
                organizationId,
                branchId: input.branchId,
                userId: target.id,
              },
            },
            create: {
              organizationId,
              branchId: input.branchId,
              userId: target.id,
              organizationRoleId: role.id,
            },
            update: { organizationRoleId: role.id, active: true },
            select: {
              id: true,
              branchId: true,
              userId: true,
              organizationRoleId: true,
              active: true,
            },
          });
        });
        annotateAudit(ctx, {
          targetType: 'HotelPropertyAssignment',
          targetId: assignment.id,
          description: 'Assigned property role',
          metadata: { ...input },
        });
        return assignment;
      }),

    revoke: adminProcedure
      .input(hotelPropertySelectionInput.extend({ userId: z.string().trim().min(1).max(128) }))
      .mutation(async ({ ctx, input }) => {
        if (input.userId === ctx.session.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Another authorized manager must change your assignment.',
          });
        }
        const organizationId = ctx.entitlements.organizationId;
        await ctx.db.$transaction(async (db) => {
          await db.$queryRaw`SELECT "branchId" FROM "hotel_properties"
            WHERE "organizationId" = ${organizationId} AND "branchId" = ${input.branchId}
            FOR UPDATE`;
          await requireHotelPropertyScope({ ...ctx, db }, input.branchId, 'hotel:property-admin');
          const result = await db.hotelPropertyAssignment.updateMany({
            where: { organizationId, branchId: input.branchId, userId: input.userId, active: true },
            data: { active: false },
          });
          if (result.count !== 1) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Active property assignment not found.',
            });
          }
        });
        annotateAudit(ctx, {
          targetType: 'HotelPropertyAssignment',
          description: 'Revoked property access',
          metadata: { ...input },
        });
        return { branchId: input.branchId, userId: input.userId, active: false };
      }),
  }),

  /** The property, its mode choices, and where onboarding currently stands. */
  get: propertyAdmin.input(hotelPropertySelectionInput.optional()).query(async ({ ctx, input }) => {
    const property = await currentProperty(ctx, input?.branchId);
    const readiness = await propertyReadiness(ctx, property);
    return {
      property,
      modeOptions,
      checklist: readiness,
      activationSummary: hotelActivationSummary(readiness),
    };
  }),

  /** PROP-01 — record the property's own facts. */
  update: propertyAdmin
    .input(hotelPropertySelectionInput.partial())
    .input(hotelPropertyUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const property = await currentProperty(ctx, input.branchId);
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

      const readiness = await propertyReadiness(ctx, await currentProperty(ctx, input.branchId));
      return { checklist: readiness, activationSummary: hotelActivationSummary(readiness) };
    }),

  modes: router({
    /** Resolve defaults without ever storing the resolved configuration. */
    get: propertyAdmin
      .input(hotelPropertySelectionInput.optional())
      .query(async ({ ctx, input }) => {
        const property = await currentProperty(ctx, input?.branchId);
        if (!property) throw notProvisioned();
        const overrides = readHotelModeOverrides(property.modeOverrides);
        const configuration = applyHotelModeDefaults(property.mode, overrides);
        return {
          mode: property.mode,
          options: modeOptions,
          overrides,
          configuration,
          features: evaluateHotelFeatures(configuration, ctx.entitlements),
        };
      }),

    /**
     * Omitted overrides preserve storage across mode changes. A supplied object
     * replaces all overrides; {} resets to defaults. Availability enforcement
     * remains with the future availability model/write path.
     */
    set: propertyAdmin
      .input(
        hotelPropertyModeInput
          .extend({
            branchId: hotelPropertySelectionInput.shape.branchId.optional(),
            overrides: hotelModeOverridesInput.optional(),
          })
          .strict()
      )
      .mutation(async ({ ctx, input }) => {
        const branchId = input.branchId;
        if (!branchId)
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Choose a property to continue.',
          });
        const organizationId = ctx.entitlements.organizationId;
        await ctx.db.$transaction(async (db) => {
          // Same tenant transaction and property lock as assignment changes.
          await db.$queryRaw`SELECT "branchId" FROM "hotel_properties"
            WHERE "organizationId" = ${organizationId} AND "branchId" = ${branchId}
            FOR UPDATE`;
          await requireHotelPropertyScope({ ...ctx, db }, branchId, 'hotel:property-admin');
          const result = await db.hotelProperty.updateMany({
            where: { organizationId, branchId, active: true },
            data: {
              mode: input.mode,
              ...(input.overrides !== undefined ? { modeOverrides: input.overrides } : {}),
            },
          });
          if (result.count !== 1)
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'This property is no longer available.',
            });
        });
        annotateAudit(ctx, {
          targetType: 'HotelProperty',
          targetId: branchId,
          description: 'Updated property mode configuration',
          metadata: {
            branchId,
            mode: input.mode,
            overridesReplaced: input.overrides !== undefined,
          },
        });
        return { mode: input.mode };
      }),
  }),

  /**
   * PROP-05 — the extras and services catalog.
   *
   * Under `hotelProperty` because 06 §1 puts extras in the same
   * `hotel:property-admin` sentence as the property, the room types and the
   * function spaces: whoever configures how a property is sold configures what it
   * sells. Front desk and folio roles read the catalog through the posting
   * surfaces of a later lane, not through here.
   *
   * The catalog is scoped to the property, and every write is scoped by
   * `(organizationId, branchId, id)`. Retiring an item sets `active` false and
   * never deletes: PROP-05's acceptance criterion has folio lines referencing
   * catalog items, and a deleted item would leave a charge with no name.
   */
  extras: router({
    /** Named choices for this identity, after the same effective capability check. */
    properties: propertyAdmin.query(async ({ ctx }) => {
      const user = ctx.session.user;
      if (user.organizationId !== ctx.entitlements.organizationId)
        throw new TRPCError({ code: 'FORBIDDEN' });
      const assignments = await ctx.db.hotelPropertyAssignment.findMany({
        where: {
          organizationId: ctx.entitlements.organizationId,
          userId: user.id,
          active: true,
          user: {
            organizationId: ctx.entitlements.organizationId,
            status: { in: ['ACTIVE', 'ON_LEAVE'] },
          },
          property: { organizationId: ctx.entitlements.organizationId, active: true },
        },
        select: { branchId: true },
      });
      const properties: { branchId: string; name: string }[] = [];
      for (const assignment of assignments) {
        try {
          const property = await requireHotelPropertyScope(
            ctx,
            assignment.branchId,
            'hotel:property-admin'
          );
          properties.push({ branchId: property.branchId, name: property.name });
        } catch (error) {
          if (!(error instanceof TRPCError) || error.code !== 'FORBIDDEN') throw error;
        }
      }
      properties.sort(
        (a, b) => a.name.localeCompare(b.name) || a.branchId.localeCompare(b.branchId)
      );
      return { organizationId: user.organizationId, userId: user.id, properties };
    }),
    /** The catalog, plus the named choices a form needs to add to it. */
    list: propertyAdmin
      .input(hotelPropertySelectionInput)
      .input(hotelExtraListInput)
      .query(async ({ ctx, input }) => {
        const property = await currentProperty(ctx, input.branchId);
        if (!property) throw notProvisioned();
        const extras = await ctx.db.hotelExtra.findMany({
          where: {
            organizationId: ctx.entitlements.organizationId,
            branchId: property.branchId,
            ...(input.includeInactive ? {} : { active: true }),
            ...(input.department ? { department: input.department } : {}),
            ...(input.upsellableOnly ? { upsellable: true } : {}),
          },
          orderBy: [{ department: 'asc' }, { code: 'asc' }],
        });
        return {
          extras,
          departmentOptions: hotelDepartmentOptions,
          recurrenceOptions: hotelExtraRecurrenceOptions,
        };
      }),

    /** Add one item to this property's catalog. */
    create: propertyAdmin
      .input(hotelPropertySelectionInput)
      .input(hotelExtraInput)
      .mutation(async ({ ctx, input }) => {
        const property = await currentProperty(ctx, input.branchId);
        if (!property) throw notProvisioned();
        await refuseATakenCode(ctx, property.branchId, input.code, null);
        const extra = await ctx.db.hotelExtra.create({
          data: {
            organizationId: ctx.entitlements.organizationId,
            branchId: property.branchId,
            ...catalogFields(input),
          },
        });
        return { extra };
      }),

    /** Reprice or rename one item. */
    update: propertyAdmin
      .input(hotelPropertySelectionInput)
      .input(hotelExtraUpdateInput)
      .mutation(async ({ ctx, input }) => {
        const property = await currentProperty(ctx, input.branchId);
        if (!property) throw notProvisioned();
        await refuseATakenCode(ctx, property.branchId, input.code, input.id);
        const changed = await ctx.db.hotelExtra.updateMany({
          where: {
            organizationId: ctx.entitlements.organizationId,
            branchId: property.branchId,
            id: input.id,
          },
          data: catalogFields(input),
        });
        if (changed.count === 0) throw noSuchExtra();
        return { id: input.id };
      }),

    /**
     * Retire an item, or bring a retired one back. Never a delete: a folio line
     * posted last month still names this row.
     */
    setActive: propertyAdmin
      .input(hotelPropertySelectionInput)
      .input(hotelExtraArchiveInput)
      .mutation(async ({ ctx, input }) => {
        const property = await currentProperty(ctx, input.branchId);
        if (!property) throw notProvisioned();
        const changed = await ctx.db.hotelExtra.updateMany({
          where: {
            organizationId: ctx.entitlements.organizationId,
            branchId: property.branchId,
            id: input.id,
          },
          data: { active: input.active },
        });
        if (changed.count === 0) throw noSuchExtra();
        return { id: input.id, active: input.active };
      }),
  }),
});
