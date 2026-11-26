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

import { Prisma } from '@/generated/prisma/client';
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
  countSellableInventory,
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
  currentProperty,
  inputJson,
  notProvisioned,
  uniqueViolationColumns,
  withLockedProperty,
  type PropertyContext,
} from '@/server/hotel-property-context';
import {
  hotelCapabilityInput,
  hotelPropertySelectionInput,
  hotelRoleKeys,
  requireHotelPropertyScope,
} from '@/server/hotel-property-scope';
import { adminProcedure, capabilityProcedure, protectedProcedure, router } from '../trpc';
import { refuseSupportSession } from '@/lib/tenancy/support-session-rule';
import { hotelFunctionSpacesRouter } from './hotel-function-spaces';
import { hotelInventoryRouter } from './hotel-inventory';
import { hotelJourneyTemplatesRouter } from './hotel-journey-templates';

const propertyAdmin = capabilityProcedure('hotel:property-admin');
const expectedVersionInput = z.object({ expectedUpdatedAt: z.coerce.date() });

/** Translate only this catalog's code uniqueness violation, preserving all other errors. */
async function withExtraCodeConflict<T>(code: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = uniqueViolationColumns(error);
      const matches =
        target.includes('hotel_extras_org_branch_code_key') ||
        (target.length === 3 &&
          ['organizationId', 'branchId', 'code'].every((field) => target.includes(field)));
      if (matches && (!error.meta?.modelName || error.meta.modelName === 'HotelExtra')) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `The code ${code} is already used in this property.`,
          cause: hotelExtraFieldError(
            'code',
            'Choose another code; this property already uses it.'
          ),
        });
      }
    }
    throw error;
  }
}

async function propertyReadiness(
  ctx: PropertyContext,
  property: Awaited<ReturnType<typeof currentProperty>>
) {
  const keys = HOSPITALITY_ROLE_TEMPLATES.map((role) => role.key);
  const organizationId = ctx.entitlements.organizationId;
  const count = await ctx.db.organizationRole.count({
    where: { organizationId, key: { in: keys } },
  });
  // Room types, or active function spaces for a property whose configuration
  // sells no room inventory — whichever step 6 of its walk asks for.
  const sellable = await countSellableInventory(ctx.db, organizationId, property);
  return evaluateHotelOnboarding(
    organizationId,
    hotelEvidence(property, count, keys.length, sellable.roomTypes, sellable.functionSpaces)
  );
}

function noSuchExtra(): TRPCError {
  return new TRPCError({
    code: 'CONFLICT',
    message:
      'That catalog item changed or is no longer available. Reload the extras list and try again.',
  });
}

/**
 * PROP-05 — one code per property. The unique index is the guarantee; this read
 * exists so the operator gets the refusal on the `code` field rather than a
 * constraint name, and it is deliberately not a substitute for the index — two
 * simultaneous creates still lose to the database, which is the correct loser.
 */
async function refuseATakenCode(
  ctx: PropertyContext,
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

type HotelCapability = Parameters<typeof requireHotelPropertyScope>[2];

/**
 * The properties this identity may act on under any of `capabilities`, each
 * with the capabilities it holds there, named for a chooser or a rail. Every
 * candidate comes from the caller's own active assignments and is then put
 * through the same effective scope check the selected page will repeat, once
 * per capability asked about, so a chooser never offers a property the page
 * would refuse and a rail never shows an entry its page would deny.
 */
async function assignedPropertiesByCapability(
  ctx: Parameters<typeof requireHotelPropertyScope>[0],
  capabilities: readonly HotelCapability[]
) {
  const user = ctx.session?.user;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
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
  const properties: { branchId: string; name: string; capabilities: HotelCapability[] }[] = [];
  for (const assignment of assignments) {
    const held: HotelCapability[] = [];
    let name: string | null = null;
    for (const capability of capabilities) {
      try {
        const property = await requireHotelPropertyScope(ctx, assignment.branchId, capability);
        name = property.name;
        held.push(capability);
      } catch (error) {
        if (!(error instanceof TRPCError) || error.code !== 'FORBIDDEN') throw error;
      }
    }
    if (held.length && name !== null)
      properties.push({ branchId: assignment.branchId, name, capabilities: held });
  }
  properties.sort((a, b) => a.name.localeCompare(b.name) || a.branchId.localeCompare(b.branchId));
  return { organizationId: user.organizationId, userId: user.id, properties };
}

/** The properties this identity may act on with one `capability`, named for a chooser. */
async function assignedProperties(
  ctx: Parameters<typeof requireHotelPropertyScope>[0],
  capability: HotelCapability
) {
  const result = await assignedPropertiesByCapability(ctx, [capability]);
  return {
    organizationId: result.organizationId,
    userId: result.userId,
    properties: result.properties.map(({ branchId, name }) => ({ branchId, name })),
  };
}

/** A list of hotel capabilities, de-duplicated, for a chooser or a rail that spans more than one. */
const hotelCapabilitiesInput = z
  .array(hotelCapabilityInput)
  .min(1)
  .max(8)
  .transform((capabilities) => [...new Set(capabilities)]);

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

    /**
     * Named choices for this identity under one capability — the chooser a
     * page that is not property administration (meal plans under
     * `hotel:rates`) opens with. The organization-level ABAC check for the
     * capability is part of the scope resolution itself.
     */
    properties: protectedProcedure
      .input(z.object({ capability: hotelCapabilityInput }))
      .query(({ ctx, input }) => assignedProperties(ctx, input.capability)),

    /**
     * The same choices under several capabilities at once, each property
     * naming the ones this identity holds there — for a page two capabilities
     * share (guest messages under property administration or marketing) and
     * for the hospitality rail, which shows each entry to whoever holds that
     * page's capability at some property.
     */
    propertiesByCapability: protectedProcedure
      .input(z.object({ capabilities: hotelCapabilitiesInput }))
      .query(({ ctx, input }) => assignedPropertiesByCapability(ctx, input.capabilities)),

    assign: adminProcedure
      .meta(refuseSupportSession)
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
      .meta(refuseSupportSession)
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
    .input(expectedVersionInput)
    .input(hotelPropertyUpdateInput)
    .mutation(async ({ ctx, input }) => {
      return withLockedProperty(ctx, input.branchId, async (ctx, property) => {
        // The write is scoped by `(organizationId, branchId)` rather than by the
        // primary key alone, so a crafted request cannot address another tenant's
        // property even if RLS were ever relaxed for a maintenance connection.
        const changed = await ctx.db.hotelProperty.updateMany({
          where: {
            organizationId: ctx.entitlements.organizationId,
            branchId: property.branchId,
            active: true,
            updatedAt: input.expectedUpdatedAt,
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

        if (changed.count !== 1)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This property changed. Reload its settings and try again.',
          });
        const readiness = await propertyReadiness(ctx, await currentProperty(ctx, input.branchId));
        return { checklist: readiness, activationSummary: hotelActivationSummary(readiness) };
      });
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
          updatedAt: property.updatedAt,
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
            expectedUpdatedAt: z.coerce.date(),
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
            where: { organizationId, branchId, active: true, updatedAt: input.expectedUpdatedAt },
            data: {
              mode: input.mode,
              ...(input.overrides !== undefined ? { modeOverrides: input.overrides } : {}),
            },
          });
          if (result.count !== 1)
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'This property changed. Reload its settings and try again.',
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
   * PROP-02 / PROP-03 / HK-03 — room types, rooms, beds, the status ledger
   * and OOO/OOS blocks. Under `hotelProperty` for the same reason as extras:
   * whoever configures how a property is sold configures what it sells.
   */
  inventory: hotelInventoryRouter,

  /**
   * PROP-07 — function spaces, their layouts, pricing and turnaround buffers,
   * and the claims on their time. Gated on the `hotel-banquets` module inside
   * the router, because the whole `hotelProperty` namespace is licensed on
   * `hotel-core`.
   */
  spaces: hotelFunctionSpacesRouter,

  /**
   * UPS-04 — the guest messages a property sends at each step of a stay, one
   * row per version, and their approval. Gated on the `hotel-upsell` module
   * inside the router; property administration may do everything, marketing
   * may draft and preview.
   */
  journeyTemplates: hotelJourneyTemplatesRouter,

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
    properties: propertyAdmin.query(({ ctx }) => assignedProperties(ctx, 'hotel:property-admin')),
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
        return withLockedProperty(ctx, input.branchId, async (ctx, property) => {
          await refuseATakenCode(ctx, property.branchId, input.code, null);
          const extra = await withExtraCodeConflict(input.code, () =>
            ctx.db.hotelExtra.create({
              data: {
                organizationId: ctx.entitlements.organizationId,
                branchId: property.branchId,
                ...catalogFields(input),
              },
            })
          );
          return { extra };
        });
      }),

    /** Reprice or rename one item. */
    update: propertyAdmin
      .input(hotelPropertySelectionInput)
      .input(expectedVersionInput)
      .input(hotelExtraUpdateInput)
      .mutation(async ({ ctx, input }) => {
        return withLockedProperty(ctx, input.branchId, async (ctx, property) => {
          await refuseATakenCode(ctx, property.branchId, input.code, input.id);
          const changed = await withExtraCodeConflict(input.code, () =>
            ctx.db.hotelExtra.updateMany({
              where: {
                organizationId: ctx.entitlements.organizationId,
                branchId: property.branchId,
                id: input.id,
                updatedAt: input.expectedUpdatedAt,
              },
              data: catalogFields(input),
            })
          );
          if (changed.count !== 1) throw noSuchExtra();
          return { id: input.id };
        });
      }),

    /**
     * Retire an item, or bring a retired one back. Never a delete: a folio line
     * posted last month still names this row.
     */
    setActive: propertyAdmin
      .input(hotelPropertySelectionInput)
      .input(expectedVersionInput)
      .input(hotelExtraArchiveInput)
      .mutation(async ({ ctx, input }) => {
        return withLockedProperty(ctx, input.branchId, async (ctx, property) => {
          const changed = await ctx.db.hotelExtra.updateMany({
            where: {
              organizationId: ctx.entitlements.organizationId,
              branchId: property.branchId,
              id: input.id,
              updatedAt: input.expectedUpdatedAt,
            },
            data: { active: input.active },
          });
          if (changed.count !== 1) throw noSuchExtra();
          return { id: input.id, active: input.active };
        });
      }),
  }),
});
