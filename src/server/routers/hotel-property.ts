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
import { ZodError } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import {
  approveJourneyTemplate,
  assertJourneyTemplateWrite,
  canSendJourneyMessage,
  HOTEL_JOURNEY_CHANNEL_LABELS,
  HOTEL_JOURNEY_CHANNELS,
  HOTEL_JOURNEY_LANGUAGE_LABELS,
  HOTEL_JOURNEY_LANGUAGES,
  HOTEL_JOURNEY_MOMENT_KINDS,
  HOTEL_JOURNEY_MOMENT_LABELS,
  HOTEL_JOURNEY_MOMENTS,
  HOTEL_JOURNEY_PLACEHOLDERS,
  HOTEL_JOURNEY_TEMPLATE_STATUS_LABELS,
  HotelJourneyTemplateError,
  journeyTemplateDraftInput,
  journeyTemplateExpectedState,
  journeyTemplateIdInput,
  journeyTemplatePreviewInput,
  parseJourneySettings,
  renderJourneyTemplate,
  retireJourneyTemplate,
  validateJourneyTemplate,
} from '@/lib/hotel/journey-templates';
import { evaluateHotelReadiness, hotelActivationSummary } from '@/lib/hotel/onboarding-checklist';
import {
  HOTEL_PROPERTY_MODES,
  HOTEL_PROPERTY_MODE_DESCRIPTIONS,
  HOTEL_PROPERTY_MODE_LABELS,
  hotelPropertyModeInput,
  hotelPropertyUpdateInput,
} from '@/lib/hotel/property';
import { auditedProtectedProcedure, capabilityProcedure, router, type TRPCContext } from '../trpc';

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

/* ------------------------------------------------------------------------- *
 * UPS-04 — journey templates.
 *
 * 06 §1 gives journey templates to `hotel:property-admin`, and the lane brief
 * adds that marketing may draft while property-admin approves. That is two
 * capabilities on one surface, so the gate is the established in-resolver
 * pattern (`restaurant-reports`): the procedure requires an active, licensed
 * session and every resolver asks the ABAC engine which of the two the caller
 * holds. The engine is still the only decision point.
 * ------------------------------------------------------------------------- */

/** A server-side rule stated as a field error, so it reaches `data.validation`. */
function fieldError(field: string, message: string): ZodError {
  return new ZodError([{ code: 'custom', path: [field], message, input: undefined }]);
}

/** The form field a template rule belongs to, so the message lands on it. */
const ERROR_FIELDS: Record<HotelJourneyTemplateError['code'], string> = {
  UNKNOWN_PLACEHOLDER: 'body',
  MALFORMED_PLACEHOLDER: 'body',
  MISSING_PLACEHOLDER_VALUE: 'context',
  SUBJECT_NOT_ALLOWED: 'subject',
  SUBJECT_REQUIRED: 'subject',
  BODY_REQUIRED: 'body',
  INVALID_TRANSITION: 'status',
  CONCURRENT_MODIFICATION: 'status',
  APPROVER_REQUIRED: 'status',
};

function asTrpcError(error: unknown): never {
  // The existing version/approved unique indexes arbitrate races with no
  // previous approved row to compare. Do not retry or report a successful write.
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'P2002' || error.code === 'P2034')
  )
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This template changed while you were working. Reload before trying again.',
      cause: fieldError('status', 'Reload the current template before trying again.'),
    });
  if (error instanceof HotelJourneyTemplateError)
    throw new TRPCError({
      code: error.code === 'CONCURRENT_MODIFICATION' ? 'CONFLICT' : 'BAD_REQUEST',
      message: error.message,
      cause: fieldError(ERROR_FIELDS[error.code], error.message),
    });
  throw error;
}

async function holds(ctx: TRPCContext, action: Action): Promise<boolean> {
  const user = ctx.session?.user;
  return Boolean(
    user &&
      (await can(subjectFromSession(user), action, undefined, {
        db: ctx.db as Prisma.TransactionClient,
        source: 'TRPC',
        ip: ctx.requestMeta.ip,
      }))
  );
}

/**
 * Who the caller is on this surface. `admin` is the only role that may approve;
 * `draft` is enough to read the board and write a draft.
 */
async function journeyAccess(ctx: TRPCContext, need: 'DRAFT' | 'APPROVE') {
  const admin = await holds(ctx, 'hotel:property-admin');
  if (admin) return { admin: true };
  if (need === 'DRAFT' && (await holds(ctx, 'hotel:marketing'))) return { admin: false };
  throw new TRPCError({
    code: 'FORBIDDEN',
    message:
      need === 'APPROVE'
        ? 'Approving a guest message is the property administrator’s decision.'
        : 'You do not have permission for this action.',
  });
}

// Batched HTTP mutations share one scoped transaction. Its SQL statements are
// queued individually, so also keep each journey mutation's sequence together.
const journeyMutationQueue = new WeakMap<object, Promise<void>>();
const journeyProcedure = auditedProtectedProcedure.use(async ({ ctx, type, next }) => {
  if (type !== 'mutation') return next();
  const previous = journeyMutationQueue.get(ctx.db) ?? Promise.resolve();
  const result = previous.then(() => next());
  const completed = result.then(
    () => undefined,
    () => undefined
  );
  journeyMutationQueue.set(ctx.db, completed);
  try {
    return await result;
  } finally {
    if (journeyMutationQueue.get(ctx.db) === completed) journeyMutationQueue.delete(ctx.db);
  }
});

/** The template row, as every journey procedure returns it. */
const JOURNEY_SELECT = {
  id: true,
  moment: true,
  channel: true,
  language: true,
  subject: true,
  body: true,
  version: true,
  status: true,
  approvedByUserId: true,
  approvedAt: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function journeyTemplateById(ctx: TRPCContext, branchId: string, id: string) {
  const template = await ctx.db.hotelJourneyTemplate.findFirst({
    where: { organizationId: ctx.entitlements.organizationId, branchId, id },
    select: JOURNEY_SELECT,
  });
  if (!template)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'That template no longer exists. Reload the list to see the current versions.',
    });
  return template;
}

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

  /**
   * UPS-04 — the property's guest messages, one row per version.
   *
   * Nothing here sends. `canSend` is exercised as the pure hook it is; the
   * WhatsApp adapter and the send itself belong to H4.
   */
  journeyTemplates: router({
    /**
     * The board: every version the property holds, the vocabulary each moment
     * offers, and what this caller may do with them.
     */
    list: journeyProcedure.query(async ({ ctx }) => {
      const access = await journeyAccess(ctx, 'DRAFT');
      const property = await currentProperty(ctx);
      if (!property) throw notProvisioned();

      const templates = await ctx.db.hotelJourneyTemplate.findMany({
        where: {
          organizationId: ctx.entitlements.organizationId,
          branchId: property.branchId,
        },
        select: JOURNEY_SELECT,
        orderBy: [{ moment: 'asc' }, { channel: 'asc' }, { language: 'asc' }, { version: 'desc' }],
      });

      const { quietHours } = parseJourneySettings(property.journeySettings);
      return {
        templates,
        canApprove: access.admin,
        quietHours,
        propertyTimezone: property.timezone,
        moments: HOTEL_JOURNEY_MOMENTS.map((moment) => ({
          value: moment,
          label: HOTEL_JOURNEY_MOMENT_LABELS[moment],
          kind: HOTEL_JOURNEY_MOMENT_KINDS[moment],
          placeholders: HOTEL_JOURNEY_PLACEHOLDERS[moment],
        })),
        channels: HOTEL_JOURNEY_CHANNELS.map((channel) => ({
          value: channel,
          label: HOTEL_JOURNEY_CHANNEL_LABELS[channel],
        })),
        languages: HOTEL_JOURNEY_LANGUAGES.map((language) => ({
          value: language,
          label: HOTEL_JOURNEY_LANGUAGE_LABELS[language],
        })),
        statusLabels: HOTEL_JOURNEY_TEMPLATE_STATUS_LABELS,
      };
    }),

    /**
     * Write a draft. An existing draft of the same message is edited; anything
     * already approved or retired is superseded by a new version, because
     * UPS-04 makes approved words a thing that is replaced, not rewritten.
     */
    save: journeyProcedure.input(journeyTemplateDraftInput).mutation(async ({ ctx, input }) => {
      await journeyAccess(ctx, 'DRAFT');
      const property = await currentProperty(ctx);
      if (!property) throw notProvisioned();

      const subject = input.subject ?? null;
      try {
        validateJourneyTemplate({
          moment: input.moment,
          channel: input.channel,
          language: input.language,
          subject,
          body: input.body,
        });
      } catch (error) {
        asTrpcError(error);
      }

      const where = {
        organizationId: ctx.entitlements.organizationId,
        branchId: property.branchId,
        moment: input.moment,
        channel: input.channel,
        language: input.language,
      };
      const latest = await ctx.db.hotelJourneyTemplate.findFirst({
        where,
        select: JOURNEY_SELECT,
        orderBy: { version: 'desc' },
      });

      if (latest?.status === 'DRAFT') {
        try {
          return await ctx.db.$transaction(async (tx) => {
            const saved = await tx.hotelJourneyTemplate.updateMany({
              where: { ...where, ...journeyTemplateExpectedState(latest) },
              data: { subject, body: input.body },
            });
            assertJourneyTemplateWrite(saved.count);
            const template = await tx.hotelJourneyTemplate.findFirst({
              where: { ...where, id: latest.id },
              select: JOURNEY_SELECT,
            });
            assertJourneyTemplateWrite(template ? 1 : 0);
            return template!;
          });
        } catch (error) {
          asTrpcError(error);
        }
      }

      const created = await ctx.db.hotelJourneyTemplate.create({
        data: {
          ...where,
          subject,
          body: input.body,
          version: (latest?.version ?? 0) + 1,
          createdByUserId: ctx.session!.user.id,
        },
        select: JOURNEY_SELECT,
      });
      return created;
    }),

    /**
     * Approve a draft. The version that was approved before is retired in the
     * same transaction — the partial unique index allows exactly one approved
     * version per message, so "which wording did we send?" has one answer.
     */
    approve: journeyProcedure.input(journeyTemplateIdInput).mutation(async ({ ctx, input }) => {
      await journeyAccess(ctx, 'APPROVE');
      const property = await currentProperty(ctx);
      if (!property) throw notProvisioned();

      const template = await journeyTemplateById(ctx, property.branchId, input.id);
      let approval;
      try {
        approval = approveJourneyTemplate(template, {
          approvedByUserId: ctx.session!.user.id,
          approvedAt: new Date(),
        });
      } catch (error) {
        asTrpcError(error);
      }

      const where = {
        organizationId: ctx.entitlements.organizationId,
        branchId: property.branchId,
        moment: template.moment,
        channel: template.channel,
        language: template.language,
      };
      const previous = await ctx.db.hotelJourneyTemplate.findFirst({
        where: { ...where, status: 'APPROVED' },
        select: JOURNEY_SELECT,
      });

      try {
        return await ctx.db.$transaction(async (tx) => {
          // A nested scoped $transaction is not a rollback boundary: tRPC can
          // catch an application conflict and let the outer transaction commit.
          // This conditional no-op locks the validated target before retirement.
          // Preserve updatedAt explicitly so a refused approval changes nothing.
          const claimed = await tx.hotelJourneyTemplate.updateMany({
            where: { ...where, ...journeyTemplateExpectedState(template) },
            data: { updatedAt: template.updatedAt },
          });
          assertJourneyTemplateWrite(claimed.count);
          if (previous) {
            const retired = await tx.hotelJourneyTemplate.updateMany({
              where: { ...where, ...journeyTemplateExpectedState(previous) },
              data: { status: 'RETIRED' },
            });
            assertJourneyTemplateWrite(retired.count);
          }
          const approved = await tx.hotelJourneyTemplate.updateMany({
            where: { ...where, ...journeyTemplateExpectedState(template) },
            data: approval,
          });
          // The target lock excludes other transactions; the journey middleware
          // excludes interleaved writes in this same transaction. SQL failures
          // still abort the real transaction (including unique-index conflicts).
          assertJourneyTemplateWrite(approved.count);
          const result = await tx.hotelJourneyTemplate.findFirst({
            where: { ...where, id: template.id },
            select: JOURNEY_SELECT,
          });
          assertJourneyTemplateWrite(result ? 1 : 0);
          return result!;
        });
      } catch (error) {
        asTrpcError(error);
      }
    }),

    /** Retire a version. Its approval facts stay: who approved it is history. */
    retire: journeyProcedure.input(journeyTemplateIdInput).mutation(async ({ ctx, input }) => {
      await journeyAccess(ctx, 'APPROVE');
      const property = await currentProperty(ctx);
      if (!property) throw notProvisioned();

      const template = await journeyTemplateById(ctx, property.branchId, input.id);
      let retirement;
      try {
        retirement = retireJourneyTemplate(template);
      } catch (error) {
        asTrpcError(error);
      }
      await ctx.db.hotelJourneyTemplate.updateMany({
        where: {
          organizationId: ctx.entitlements.organizationId,
          branchId: property.branchId,
          id: template.id,
        },
        data: retirement,
      });
      return journeyTemplateById(ctx, property.branchId, template.id);
    }),

    /**
     * Render a version against sample values, and report the two facts a sender
     * would consult: whether the wording is approved, and whether the property
     * is inside quiet hours right now. Guest consent is the third and is a fact
     * about a guest, so it belongs to the send in H4, not to a preview.
     */
    preview: journeyProcedure.input(journeyTemplatePreviewInput).query(async ({ ctx, input }) => {
      await journeyAccess(ctx, 'DRAFT');
      const property = await currentProperty(ctx);
      if (!property) throw notProvisioned();

      const template = await journeyTemplateById(ctx, property.branchId, input.id);
      let rendered;
      try {
        rendered = renderJourneyTemplate(template, input.context);
      } catch (error) {
        asTrpcError(error);
      }

      // A guest with full consent, so the decision reported here isolates the
      // two property-side gates. The real consent check runs at send time.
      const consented = canSendJourneyMessage({
        template,
        consentEvents: [
          { purpose: 'SERVICE', channel: template.channel, version: 1, granted: true },
          { purpose: 'MARKETING', channel: template.channel, version: 1, granted: true },
        ],
        journeySettings: property.journeySettings,
        timezone: property.timezone,
        now: new Date(),
      });

      return { template, rendered, propertySideCheck: consented };
    }),
  }),
});
