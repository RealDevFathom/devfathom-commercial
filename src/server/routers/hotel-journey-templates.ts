/**
 * UPS-04 (H1-14) — `hotelProperty.journeyTemplates.*`: the words a property
 * sends a guest at each step of a stay, one row per version, and the approval
 * that lets a version be sent.
 *
 * Two capabilities share this surface. 06 §1 gives journey templates to
 * `hotel:property-admin`, and the lane brief adds that marketing may draft
 * while the property administrator approves. So every procedure resolves the
 * caller's selected property through `requireHotelPropertyScope` with
 * `hotel:property-admin` first and, for reading the board, saving a draft and
 * previewing, falls back to `hotel:marketing`; `approve` and `retire` accept
 * property administration alone. The scope check is the engine's decision —
 * the ABAC `can`, an active assignment at the property, that role's ALLOW —
 * repeated for every call; nothing here caches a grant. Every procedure also
 * needs the `hotel-upsell` module (Guest Journey and Upsell), which is what
 * sells the guest journey: the Pro and Chain packages carry it, Essentials
 * and Venue do not.
 *
 * The rules — the placeholder catalogue, rendering, the approval machine, the
 * send gate — live in `@/lib/hotel/journey-templates`; this file is the gates,
 * the tenant predicate, the conditional writes and the operator-facing
 * refusals. Every write runs inside `withLockedProperty` (lock, re-check
 * access, write), is scoped by `(organizationId, branchId)` plus the version
 * the caller read, and enriches the request's audit row. That version comes
 * from the caller — its `updatedAt` and, for a draft edit, a draft retirement
 * or an approval, the wording on its screen — because the lock serializes
 * writers: a row read under it is always current and cannot show that a
 * colleague changed it after the caller's page was drawn. Forced row-level
 * security is the second wall and never the only one.
 *
 * Nothing here sends. `canSendJourneyMessage` is exercised as the pure hook it
 * is; the WhatsApp adapter and the send itself belong to H4.
 */
import { TRPCError } from '@trpc/server';
import { z, ZodRealError, type ZodError } from 'zod';

import { Prisma, type HotelProperty } from '@/generated/prisma/client';
import { hasModule } from '@/lib/entitlements';
import { recordHotelAudit } from '@/lib/hotel/audit';
import {
  approveJourneyTemplate,
  assertJourneyDraftWordingNamed,
  assertJourneyTemplateAsRead,
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
  journeyTemplateApproveInput,
  journeyTemplateDraftInput,
  journeyTemplateExpectedState,
  journeyTemplatePreviewInput,
  journeyTemplateRetireInput,
  parseJourneySettings,
  renderJourneyTemplate,
  retireJourneyTemplate,
  validateJourneyTemplate,
  type HotelJourneyTemplateReading,
} from '@/lib/hotel/journey-templates';
import {
  currentProperty,
  withLockedProperty,
  type PropertyContext,
} from '@/server/hotel-property-context';
import { hotelPropertySelectionInput } from '@/server/hotel-property-scope';
import { auditedProtectedProcedure, router, type TRPCContext } from '../trpc';

const UPSELL = 'hotel-upsell';
const PROPERTY_ADMIN = 'hotel:property-admin' as const;
const MARKETING = 'hotel:marketing' as const;

/**
 * The property selection joined onto a lib contract as ONE parser, so the lib
 * schema keeps its refinements and the selection is parsed once.
 */
function selected<Shape extends z.ZodRawShape, Config extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<Shape, Config>
) {
  return schema.extend(hotelPropertySelectionInput.shape);
}

/** A server-side rule stated as a field error, so it reaches `data.validation`. */
function fieldError(field: string, message: string): ZodError {
  // tRPC preserves Error instances; the plain ZodError constructor is not one
  // in the installed Zod version and loses its validation shape when wrapped.
  return new ZodRealError([{ code: 'custom', path: [field], message, input: undefined }]);
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
  // Where the draft input's refinement reports the same rule.
  READING_INCOMPLETE: 'expectedUpdatedAt',
};

const CHANGED_MESSAGE =
  'This message changed while you were working. Reload the current version before trying again.';

/** The version the caller read is not the stored one, or no longer the one in play. */
function changedWhileWorking(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: CHANGED_MESSAGE });
}

/**
 * Translate the lib's refusals and the two races the database arbitrates into
 * the operator's sentences, and re-throw everything else. A placeholder, a
 * subject or a body rule is BAD_REQUEST on its field (the transport publishes
 * `data.validation` for BAD_REQUEST alone); a lost race — the version or
 * approved unique index, a transaction conflict, a conditional write that
 * matched nothing — is a CONFLICT, because no field can fix it: the caller
 * reloads.
 */
function asTrpcError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P2002 is the version or the approved unique index arbitrating a race the
    // reads above did not see; P2034 is a serialization failure. Neither is
    // retried here, and neither is reported as a successful write.
    if (error.code === 'P2002' || error.code === 'P2034') {
      throw new TRPCError({ code: 'CONFLICT', message: CHANGED_MESSAGE, cause: error });
    }
  }
  if (error instanceof HotelJourneyTemplateError) {
    if (error.code === 'CONCURRENT_MODIFICATION') {
      throw new TRPCError({ code: 'CONFLICT', message: error.message, cause: error });
    }
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: error.message,
      cause: fieldError(ERROR_FIELDS[error.code], error.message),
    });
  }
  throw error;
}

/**
 * The module gate, before any read: a workspace without Guest Journey and
 * Upsell has no guest messages to show, whatever role the caller holds.
 */
function requireUpsell(ctx: Pick<TRPCContext, 'entitlements'>): void {
  if (hasModule(ctx.entitlements, UPSELL)) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message:
      'Guest messages need the Guest Journey and Upsell module, which this workspace does not have. Ask your DevFathom account manager about the Hotel Pro package.',
  });
}

type JourneyAccess = { property: HotelProperty; admin: boolean };

/**
 * Who the caller is on this surface, resolved through the scope for the
 * selected property: property administration first, which may do everything;
 * otherwise marketing, which may read, draft and preview. The second check
 * runs only when the first is a FORBIDDEN, so any other failure (a dead
 * session, a property gone) is reported as what it is. For an approval,
 * marketing is told whose decision it is rather than handed a generic refusal.
 */
async function journeyAccess(
  ctx: PropertyContext,
  branchId: string,
  need: 'DRAFT' | 'APPROVE'
): Promise<JourneyAccess> {
  try {
    return { property: await currentProperty(ctx, branchId, PROPERTY_ADMIN), admin: true };
  } catch (error) {
    if (!(error instanceof TRPCError) || error.code !== 'FORBIDDEN') throw error;
    if (need === 'DRAFT') {
      return { property: await currentProperty(ctx, branchId, MARKETING), admin: false };
    }
    let marketer = false;
    try {
      await currentProperty(ctx, branchId, MARKETING);
      marketer = true;
    } catch {
      // Not a marketer either: the original refusal stands.
    }
    if (!marketer) throw error;
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Approving a guest message is the property administrator’s decision.',
    });
  }
}

/**
 * A write under both gates: module, lock, access (property-admin or, for a
 * draft, marketing), then the work — the same lock → re-check → write order
 * every hotel write follows, with the access the resolver settled on handed in.
 */
function journeyWrite<T>(
  ctx: TRPCContext,
  branchId: string,
  need: 'DRAFT' | 'APPROVE',
  run: (ctx: PropertyContext, access: JourneyAccess) => Promise<T>
): Promise<T> {
  requireUpsell(ctx);
  let access: JourneyAccess | null = null;
  return withLockedProperty(
    ctx,
    branchId,
    (lockedCtx) => run(lockedCtx, access!),
    async (lockedCtx) => {
      access = await journeyAccess(lockedCtx, branchId, need);
      return access.property;
    }
  );
}

/**
 * Batched HTTP mutations share one request-wide transaction whose statements
 * are queued individually, so two journey mutations in one batch could
 * interleave read-then-conditional-write sequences and each refuse the other.
 * This keeps each journey mutation's sequence together per transaction; a
 * refused mutation releases the queue for the next.
 */
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

type JourneyRow = Prisma.HotelJourneyTemplateGetPayload<{ select: typeof JOURNEY_SELECT }>;

/** The actor every write is attributed to. */
function actorId(ctx: PropertyContext): string {
  const user = ctx.session?.user;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return user.id;
}

async function journeyTemplateById(
  ctx: PropertyContext,
  branchId: string,
  id: string
): Promise<JourneyRow> {
  const template = await ctx.db.hotelJourneyTemplate.findFirst({
    where: { organizationId: ctx.entitlements.organizationId, branchId, id },
    select: JOURNEY_SELECT,
  });
  if (!template) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message:
        'That message version no longer exists. Reload the list to see the current versions.',
    });
  }
  return template;
}

/** What a template row looks like in an audit `before`/`after`. */
function auditFacts(template: JourneyRow) {
  return {
    moment: template.moment,
    channel: template.channel,
    language: template.language,
    version: template.version,
    status: template.status,
    subject: template.subject,
    body: template.body,
    approvedByUserId: template.approvedByUserId,
  };
}

function auditLabel(template: Pick<JourneyRow, 'moment' | 'channel' | 'language' | 'version'>) {
  return `${HOTEL_JOURNEY_MOMENT_LABELS[template.moment]} · ${HOTEL_JOURNEY_CHANNEL_LABELS[template.channel]} · ${HOTEL_JOURNEY_LANGUAGE_LABELS[template.language]} v${template.version}`;
}

/** The named choices a form needs, already labelled for an operator (UX rule 1). */
const moments = HOTEL_JOURNEY_MOMENTS.map((moment) => ({
  value: moment,
  label: HOTEL_JOURNEY_MOMENT_LABELS[moment],
  kind: HOTEL_JOURNEY_MOMENT_KINDS[moment],
  placeholders: HOTEL_JOURNEY_PLACEHOLDERS[moment],
}));
const channels = HOTEL_JOURNEY_CHANNELS.map((channel) => ({
  value: channel,
  label: HOTEL_JOURNEY_CHANNEL_LABELS[channel],
}));
const languages = HOTEL_JOURNEY_LANGUAGES.map((language) => ({
  value: language,
  label: HOTEL_JOURNEY_LANGUAGE_LABELS[language],
}));

export const hotelJourneyTemplatesRouter = router({
  /**
   * The board: every version the property holds, the vocabulary each moment
   * offers, what this caller may do with them, and the property's quiet hours.
   */
  list: journeyProcedure.input(hotelPropertySelectionInput).query(async ({ ctx, input }) => {
    requireUpsell(ctx);
    const { property, admin } = await journeyAccess(ctx, input.branchId, 'DRAFT');
    const templates = await ctx.db.hotelJourneyTemplate.findMany({
      where: { organizationId: ctx.entitlements.organizationId, branchId: property.branchId },
      select: JOURNEY_SELECT,
      orderBy: [{ moment: 'asc' }, { channel: 'asc' }, { language: 'asc' }, { version: 'desc' }],
    });
    const { quietHours } = parseJourneySettings(property.journeySettings);
    return {
      branchId: property.branchId,
      templates,
      canApprove: admin,
      quietHours,
      propertyTimezone: property.timezone,
      moments,
      channels,
      languages,
      statusLabels: HOTEL_JOURNEY_TEMPLATE_STATUS_LABELS,
    };
  }),

  /**
   * Write a draft. An existing draft of the same message is edited in place;
   * anything already approved or retired is superseded by a new version,
   * because UPS-04 makes approved words a thing that is replaced, not rewritten.
   * An edit names the version its editor read — timestamp and wording — and is
   * conditional on it, so a colleague's save, approval or retirement since the
   * editor read the draft is a conflict rather than a silent overwrite; a save
   * naming no version (a new draft, a replacement) never rewrites a draft.
   */
  save: journeyProcedure.input(selected(journeyTemplateDraftInput)).mutation(({ ctx, input }) =>
    journeyWrite(ctx, input.branchId, 'DRAFT', async (ctx, { property }) => {
      const subject = input.subject ?? null;
      // The module and the scope come first (journeyWrite), so a caller who may
      // not draft here is told that rather than which placeholder is wrong.
      // The pure rules then refuse a typo before any template is read.
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
      const reading: HotelJourneyTemplateReading | null =
        input.expectedUpdatedAt === undefined
          ? null
          : {
              updatedAt: input.expectedUpdatedAt,
              subject: input.expectedSubject,
              body: input.expectedBody,
            };
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
      try {
        if (latest?.status === 'DRAFT') {
          // A draft is rewritten only at the version its editor read. A save
          // that read none has never seen this draft's words.
          if (!reading)
            throw new TRPCError({
              code: 'CONFLICT',
              message: `This message already has a draft (version ${latest.version}). Reload the list and open that draft to change it.`,
            });
          assertJourneyTemplateAsRead(latest, reading);
          // Its time and its wording, whatever the input contract let through.
          assertJourneyDraftWordingNamed(latest, reading);
          const saved = await ctx.db.hotelJourneyTemplate.updateMany({
            where: { ...where, ...journeyTemplateExpectedState(latest, reading) },
            data: { subject, body: input.body },
          });
          assertJourneyTemplateWrite(saved.count);
          const template = await ctx.db.hotelJourneyTemplate.findFirst({
            where: { ...where, id: latest.id },
            select: JOURNEY_SELECT,
          });
          assertJourneyTemplateWrite(template ? 1 : 0);
          recordHotelAudit(ctx, {
            entity: {
              type: 'HotelJourneyTemplate',
              id: template!.id,
              label: auditLabel(template!),
            },
            action: 'hotel.journey.template.save',
            before: auditFacts(latest),
            after: auditFacts(template!),
            metadata: { branchId: property.branchId },
          });
          return template!;
        }
        // No draft to rewrite. A save that was editing one finds it approved or
        // retired since it was read; its words do not quietly become a new
        // version the editor never chose to start.
        if (reading) throw changedWhileWorking();
        const created = await ctx.db.hotelJourneyTemplate.create({
          data: {
            ...where,
            subject,
            body: input.body,
            version: (latest?.version ?? 0) + 1,
            createdByUserId: actorId(ctx),
          },
          select: JOURNEY_SELECT,
        });
        recordHotelAudit(ctx, {
          entity: { type: 'HotelJourneyTemplate', id: created.id, label: auditLabel(created) },
          action: 'hotel.journey.template.draft',
          operation: 'CREATE',
          after: auditFacts(created),
          metadata: { branchId: property.branchId, supersedes: latest?.id ?? null },
        });
        return created;
      } catch (error) {
        asTrpcError(error);
      }
    })
  ),

  /**
   * Approve a draft. The version that was approved before is retired in the
   * same transaction — the partial unique index allows exactly one approved
   * version per message, so "which wording did we send?" has one answer. The
   * approver names the version and the wording it read and the approval it
   * saw standing; anything else found under the lock is a conflict, and every
   * write is conditional on what was named, so unread words are never approved.
   */
  approve: journeyProcedure
    .input(selected(journeyTemplateApproveInput))
    .mutation(({ ctx, input }) =>
      journeyWrite(ctx, input.branchId, 'APPROVE', async (ctx, { property }) => {
        const template = await journeyTemplateById(ctx, property.branchId, input.id);
        const reading: HotelJourneyTemplateReading = {
          updatedAt: input.expectedUpdatedAt,
          subject: input.expectedSubject,
          body: input.expectedBody,
        };
        let approval;
        try {
          // What the approver read comes before any rule: a version that moved on
          // since — a colleague's edit, an approval, a retirement — is a conflict
          // to reload, whatever it has become.
          assertJourneyTemplateAsRead(template, reading);
          approval = approveJourneyTemplate(template, {
            approvedByUserId: actorId(ctx),
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
        // Approving retires whatever stands approved, so that must be the
        // approval the approver saw: one made since is a colleague's decision to
        // read, not one to retire unseen.
        if ((previous?.id ?? null) !== input.expectedApprovedId) throw changedWhileWorking();
        const expected = { ...where, ...journeyTemplateExpectedState(template, reading) };
        try {
          // Claim the validated target first with a conditional no-op (updatedAt
          // kept as read, so a refused approval changes nothing); then retire the
          // previous approval; then approve. Each step must match exactly one
          // row, so wording that changed since the approver read it is never
          // approved.
          const claimed = await ctx.db.hotelJourneyTemplate.updateMany({
            where: expected,
            data: { updatedAt: template.updatedAt },
          });
          assertJourneyTemplateWrite(claimed.count);
          if (previous) {
            const retired = await ctx.db.hotelJourneyTemplate.updateMany({
              where: { ...where, ...journeyTemplateExpectedState(previous) },
              data: { status: 'RETIRED' },
            });
            assertJourneyTemplateWrite(retired.count);
          }
          const approved = await ctx.db.hotelJourneyTemplate.updateMany({
            where: expected,
            data: approval,
          });
          assertJourneyTemplateWrite(approved.count);
          const result = await ctx.db.hotelJourneyTemplate.findFirst({
            where: { ...where, id: template.id },
            select: JOURNEY_SELECT,
          });
          assertJourneyTemplateWrite(result ? 1 : 0);
          recordHotelAudit(ctx, {
            entity: { type: 'HotelJourneyTemplate', id: result!.id, label: auditLabel(result!) },
            action: 'hotel.journey.template.approve',
            before: auditFacts(template),
            after: auditFacts(result!),
            metadata: { branchId: property.branchId, retired: previous?.id ?? null },
          });
          return result!;
        } catch (error) {
          asTrpcError(error);
        }
      })
    ),

  /**
   * Retire a version. Its approval facts stay: who approved it is history. The
   * caller names the version it read (for a draft, its wording as well, since a
   * colleague's save can share its time), and one changed since is a conflict.
   */
  retire: journeyProcedure.input(selected(journeyTemplateRetireInput)).mutation(({ ctx, input }) =>
    journeyWrite(ctx, input.branchId, 'APPROVE', async (ctx, { property }) => {
      const template = await journeyTemplateById(ctx, property.branchId, input.id);
      const reading: HotelJourneyTemplateReading = {
        updatedAt: input.expectedUpdatedAt,
        subject: input.expectedSubject,
        body: input.expectedBody,
      };
      let retirement;
      try {
        assertJourneyTemplateAsRead(template, reading);
        assertJourneyDraftWordingNamed(template, reading);
        retirement = retireJourneyTemplate(template);
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
      try {
        const retired = await ctx.db.hotelJourneyTemplate.updateMany({
          where: { ...where, ...journeyTemplateExpectedState(template, reading) },
          data: retirement,
        });
        assertJourneyTemplateWrite(retired.count);
      } catch (error) {
        asTrpcError(error);
      }
      const result = await journeyTemplateById(ctx, property.branchId, template.id);
      recordHotelAudit(ctx, {
        entity: { type: 'HotelJourneyTemplate', id: result.id, label: auditLabel(result) },
        action: 'hotel.journey.template.retire',
        before: auditFacts(template),
        after: auditFacts(result),
        metadata: { branchId: property.branchId },
      });
      return result;
    })
  ),

  /**
   * Render a version against sample values, and report the two facts a sender
   * would consult: whether the wording is approved, and whether the property is
   * inside quiet hours right now. Guest consent is the third and is a fact
   * about a guest, so it belongs to the send in H4, not to a preview.
   */
  preview: journeyProcedure
    .input(selected(journeyTemplatePreviewInput))
    .query(async ({ ctx, input }) => {
      requireUpsell(ctx);
      const { property } = await journeyAccess(ctx, input.branchId, 'DRAFT');
      const template = await journeyTemplateById(ctx, property.branchId, input.id);
      let rendered;
      try {
        rendered = renderJourneyTemplate(template, input.context);
      } catch (error) {
        asTrpcError(error);
      }
      // A guest with full consent, so the decision reported here isolates the
      // two property-side gates. The real consent check runs at send time.
      const propertySideCheck = canSendJourneyMessage({
        template,
        consentEvents: [
          { purpose: 'SERVICE', channel: template.channel, version: 1, granted: true },
          { purpose: 'MARKETING', channel: template.channel, version: 1, granted: true },
        ],
        journeySettings: property.journeySettings,
        timezone: property.timezone,
        now: new Date(),
      });
      return { template, rendered, propertySideCheck };
    }),
});
