import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { assertInOrganization } from '../org-refs';
import { router, capabilityProcedure } from '../trpc';
import { annotateAudit } from '../audit';
import {
  SopTemplateError,
  addStep,
  createAssignment,
  createDraftVersion,
  createTemplate,
  getAssignment,
  getTemplate,
  getVersion,
  listAssignments,
  listTemplates,
  listVersions,
  publishVersion,
  removeStep,
  reorderSteps,
  retireVersion,
  setAssignmentActive,
  setTemplateActive,
  updateAssignment,
  updateStep,
  updateTemplate,
  assignmentRecurrenceRule,
} from '@/lib/restaurant/sop-templates';
import { RecurrenceError, enumerateOccurrences } from '@/lib/restaurant/sop-recurrence';
import { resolveEntitlementLimit, SOP_TEMPLATES_LIMIT } from '@/lib/entitlement-limits';
import {
  type AssigneeTarget,
  AssigneeTargetError,
  claimSopOccurrence,
  listClaimablePoolOccurrences,
  listStaffSopOccurrences,
} from '@/lib/restaurant/sop-assignment';
import {
  SOP_TEMPLATE_PACKS,
  installAllSopPacks,
  installSopPack,
} from '@/lib/restaurant/sop-template-packs';
import {
  SopEscalationConfigError,
  createEscalationPolicy,
  getEscalationPolicy,
  listEscalationPolicies,
  removeEscalationStep,
  setEscalationPolicyActive,
  updateEscalationPolicy,
  upsertEscalationStep,
} from '@/lib/restaurant/sop-escalation';
import { buildScoreReport } from '@/lib/restaurant/sop-score';
import { getOccurrenceAuditTrail } from '@/lib/restaurant/sop-audit';
import { businessDateToUtcDate } from '@/lib/restaurant/business-date';
import { resolveStaffBranchAuthorization } from '@/lib/restaurant/staff-branch-authorization';

/**
 * M7-L3 — the SOP authoring console (back-office server surface).
 *
 * Every procedure gates on the `sop:manage` capability (ABAC, org-role-driven)
 * and the `restaurant-sop` module (module-catalog). Tenant scoping is the
 * RLS-forced `organizationId` default on every row (C1). Domain rules —
 * publish immutability, `sop.templates.max`, recurrence validity — live in the
 * `sop-templates` / `sop-recurrence` libs; this router is a thin, strictly-typed
 * mapping layer that translates domain errors to tRPC status codes.
 *
 * Strict-zod boundary: EVERY input schema is `.strict()`, so an unknown key is
 * REJECTED with a 400 rather than silently stripped.
 */

const manageProcedure = capabilityProcedure('sop:manage');
/** SOP-1: doing the work (claiming from a pool, reading your own queue). */
const completeProcedure = capabilityProcedure('sop:complete');

/** Translate SOP/recurrence domain errors to tRPC status. Rethrows unknowns. */
function mapSopError(err: unknown): never {
  if (err instanceof SopTemplateError) {
    const code =
      err.reason === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : err.reason === 'TEMPLATE_LIMIT_REACHED' ||
            err.reason === 'DRAFT_EXISTS' ||
            err.reason === 'VERSION_NOT_DRAFT' ||
            err.reason === 'INVALID_STATE'
          ? 'CONFLICT'
          : 'BAD_REQUEST'; // NO_STEPS, INVALID
    throw new TRPCError({ code, message: err.message });
  }
  if (err instanceof RecurrenceError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  }
  if (err instanceof AssigneeTargetError) {
    throw new TRPCError({
      code: err.reason === 'ROLE_INACTIVE' ? 'CONFLICT' : 'BAD_REQUEST',
      message: err.message,
    });
  }
  if (err instanceof SopEscalationConfigError) {
    throw new TRPCError({
      code: err.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST',
      message: err.message,
    });
  }
  throw err;
}

// ── Shared field schemas ──────────────────────────────────────────────────────

const NAME = z.string().min(1).max(200);
const OPTIONAL_TEXT = z.string().max(2_000).nullable().optional();
const STEP_TITLE = z.string().min(1).max(500);
const DATE_ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date.');
const FREQUENCY = z.enum(['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'INTERVAL']);
const MINUTES_OF_DAY = z.number().int().min(0).max(1439);
const DAYS_OF_WEEK = z.array(z.number().int().min(0).max(6)).max(7);
const MONTH_DAY = z.number().int().min(1).max(31).nullable();
const ESCALATION_SCOPE = z.enum(['ORG', 'BRANCH']);
const NOTIFICATION_CHANNEL = z.enum(['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WHATSAPP']);

/**
 * SOP-1: the assignee target, as a discriminated union so an input naming a
 * person cannot also smuggle a role id past the strict boundary. The DB CHECK is
 * the last line of defence; this is the first.
 */
const ASSIGNEE_TARGET = z.discriminatedUnion('type', [
  z.object({ type: z.literal('person'), staffProfileId: z.string() }).strict(),
  z.object({ type: z.literal('role'), jobRoleId: z.string() }).strict(),
]) satisfies z.ZodType<AssigneeTarget>;

function sopTemplatesMax(limits: Record<string, number>): number {
  const resolution = resolveEntitlementLimit(limits, SOP_TEMPLATES_LIMIT);
  if (resolution.status === 'missing') {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `The SOP template entitlement limit is not configured. Set ${resolution.explicitKey} (preferred) or ${resolution.bootstrappedKey}.`,
    });
  }
  return resolution.value;
}

/** The recurrence fields shared by createAssignment and previewSchedule. */
const recurrenceShape = {
  frequency: FREQUENCY,
  interval: z.number().int().min(1).max(1440).default(1),
  daysOfWeek: DAYS_OF_WEEK.default([]),
  monthDay: MONTH_DAY.default(null),
  startDate: DATE_ISO,
  endDate: DATE_ISO.nullable().default(null),
  dueTimeMinutes: MINUTES_OF_DAY.default(0),
  intervalEndTimeMinutes: MINUTES_OF_DAY.nullable().default(null),
  windowMinutes: z.number().int().min(0).max(1440).default(1440),
} as const;

function validateIntervalRecurrence(
  value: { frequency: z.infer<typeof FREQUENCY>; interval: number; daysOfWeek: number[] },
  ctx: z.RefinementCtx
) {
  if (value.frequency !== 'INTERVAL') return;
  if (value.interval < 15) {
    ctx.addIssue({ code: 'custom', path: ['interval'], message: 'Minimum is 15 minutes.' });
  }
  if (value.daysOfWeek.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['daysOfWeek'], message: 'Select at least one weekday.' });
  }
}

export const restaurantSopRouter = router({
  // ── Templates ───────────────────────────────────────────────────────────────

  createTemplate: manageProcedure
    .input(
      z
        .object({
          name: NAME,
          description: OPTIONAL_TEXT,
          category: z.string().max(200).nullable().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const templatesMax = sopTemplatesMax(ctx.entitlements.limits);
        const template = await createTemplate(ctx.db, input, templatesMax);
        annotateAudit(ctx, {
          targetType: 'RestaurantSopTemplate',
          targetId: template.id,
          targetLabel: template.name,
          description: `Created SOP template "${template.name}"`,
        });
        return template;
      } catch (err) {
        mapSopError(err);
      }
    }),

  updateTemplate: manageProcedure
    .input(
      z
        .object({
          id: z.string(),
          name: NAME.optional(),
          description: OPTIONAL_TEXT,
          category: z.string().max(200).nullable().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        return await updateTemplate(ctx.db, id, patch);
      } catch (err) {
        mapSopError(err);
      }
    }),

  setTemplateActive: manageProcedure
    .input(z.object({ id: z.string(), isActive: z.boolean() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const templatesMax = sopTemplatesMax(ctx.entitlements.limits);
        return await setTemplateActive(ctx.db, input.id, input.isActive, templatesMax);
      } catch (err) {
        mapSopError(err);
      }
    }),

  listTemplates: manageProcedure
    .input(z.object({ includeInactive: z.boolean().optional() }).strict().optional())
    .query(async ({ ctx, input }) => {
      try {
        return await listTemplates(ctx.db, { includeInactive: input?.includeInactive });
      } catch (err) {
        mapSopError(err);
      }
    }),

  getTemplate: manageProcedure
    .input(z.object({ id: z.string() }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await getTemplate(ctx.db, input.id);
      } catch (err) {
        mapSopError(err);
      }
    }),

  // ── Versions ──────────────────────────────────────────────────────────────

  createDraftVersion: manageProcedure
    .input(z.object({ templateId: z.string(), cloneFromVersionId: z.string().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const version = await createDraftVersion(ctx.db, input.templateId, {
          cloneFromVersionId: input.cloneFromVersionId,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantSopTemplateVersion',
          targetId: version.id,
          description: `Opened SOP draft version v${version.versionNumber}`,
        });
        return version;
      } catch (err) {
        mapSopError(err);
      }
    }),

  publishVersion: manageProcedure
    .input(z.object({ versionId: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const version = await publishVersion(ctx.db, input.versionId);
        annotateAudit(ctx, {
          targetType: 'RestaurantSopTemplateVersion',
          targetId: version.id,
          description: `Published SOP version v${version.versionNumber}`,
        });
        return version;
      } catch (err) {
        mapSopError(err);
      }
    }),

  retireVersion: manageProcedure
    .input(z.object({ versionId: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await retireVersion(ctx.db, input.versionId);
      } catch (err) {
        mapSopError(err);
      }
    }),

  listVersions: manageProcedure
    .input(z.object({ templateId: z.string() }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await listVersions(ctx.db, input.templateId);
      } catch (err) {
        mapSopError(err);
      }
    }),

  getVersion: manageProcedure
    .input(z.object({ versionId: z.string() }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await getVersion(ctx.db, input.versionId);
      } catch (err) {
        mapSopError(err);
      }
    }),

  // ── Steps (DRAFT-only mutations, server-guarded) ──────────────────────────────

  addStep: manageProcedure
    .input(
      z
        .object({
          templateVersionId: z.string(),
          title: STEP_TITLE,
          instructions: OPTIONAL_TEXT,
          requiresPhoto: z.boolean().optional(),
          requiresSignature: z.boolean().optional(),
          requiresNote: z.boolean().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await addStep(ctx.db, input);
      } catch (err) {
        mapSopError(err);
      }
    }),

  updateStep: manageProcedure
    .input(
      z
        .object({
          stepId: z.string(),
          title: STEP_TITLE.optional(),
          instructions: OPTIONAL_TEXT,
          requiresPhoto: z.boolean().optional(),
          requiresSignature: z.boolean().optional(),
          requiresNote: z.boolean().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { stepId, ...patch } = input;
      try {
        return await updateStep(ctx.db, stepId, patch);
      } catch (err) {
        mapSopError(err);
      }
    }),

  removeStep: manageProcedure
    .input(z.object({ stepId: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await removeStep(ctx.db, input.stepId);
      } catch (err) {
        mapSopError(err);
      }
    }),

  reorderSteps: manageProcedure
    .input(z.object({ versionId: z.string(), orderedStepIds: z.array(z.string()).min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await reorderSteps(ctx.db, input.versionId, input.orderedStepIds);
      } catch (err) {
        mapSopError(err);
      }
    }),

  // ── Assignments ───────────────────────────────────────────────────────────

  createAssignment: manageProcedure
    .input(
      z
        .object({
          ...recurrenceShape,
          branchId: z.string(),
          templateId: z.string(),
          graceMinutes: z.number().int().min(0).max(1440).default(0),
          assigneeTarget: ASSIGNEE_TARGET,
        })
        .strict()
        .superRefine(validateIntervalRecurrence)
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const organizationId = ctx.entitlements.organizationId ?? ctx.session?.user.organizationId;
        if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
        await assertInOrganization(ctx.db.restaurantBranch, organizationId, [input.branchId], {
          active: true,
        });
        const assignment = await createAssignment(ctx.db, input);
        const targetLabel =
          input.assigneeTarget.type === 'person'
            ? `staff ${input.assigneeTarget.staffProfileId}`
            : `role pool ${input.assigneeTarget.jobRoleId}`;
        annotateAudit(ctx, {
          targetType: 'RestaurantSopAssignment',
          targetId: assignment.id,
          description: `Assigned SOP template ${input.templateId} to branch ${input.branchId} for ${targetLabel}`,
        });
        return assignment;
      } catch (err) {
        mapSopError(err);
      }
    }),

  updateAssignment: manageProcedure
    .input(
      z
        .object({
          id: z.string(),
          effectiveDate: DATE_ISO,
          frequency: FREQUENCY.optional(),
          interval: z.number().int().min(1).max(1440).optional(),
          daysOfWeek: DAYS_OF_WEEK.optional(),
          monthDay: MONTH_DAY.optional(),
          startDate: DATE_ISO.optional(),
          endDate: DATE_ISO.nullable().optional(),
          dueTimeMinutes: MINUTES_OF_DAY.optional(),
          intervalEndTimeMinutes: MINUTES_OF_DAY.nullable().optional(),
          windowMinutes: z.number().int().min(0).max(1440).optional(),
          graceMinutes: z.number().int().min(0).max(1440).optional(),
          assigneeTarget: ASSIGNEE_TARGET.optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        return await updateAssignment(ctx.db, id, patch);
      } catch (err) {
        mapSopError(err);
      }
    }),

  setAssignmentActive: manageProcedure
    .input(z.object({ id: z.string(), active: z.boolean() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await setAssignmentActive(ctx.db, input.id, input.active);
      } catch (err) {
        mapSopError(err);
      }
    }),

  listAssignments: manageProcedure
    .input(
      z
        .object({ branchId: z.string().optional(), templateId: z.string().optional() })
        .strict()
        .optional()
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listAssignments(ctx.db, input ?? {});
      } catch (err) {
        mapSopError(err);
      }
    }),

  getAssignment: manageProcedure
    .input(z.object({ id: z.string() }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await getAssignment(ctx.db, input.id);
      } catch (err) {
        mapSopError(err);
      }
    }),

  // ── Schedule preview (pure recurrence evaluation, no persistence) ─────────────

  /** Preview an ad-hoc recurrence against a branch's timezone before saving it. */
  previewSchedule: manageProcedure
    .input(
      z
        .object({
          ...recurrenceShape,
          branchId: z.string(),
          from: DATE_ISO,
          to: DATE_ISO,
        })
        .strict()
        .superRefine(validateIntervalRecurrence)
    )
    .query(async ({ ctx, input }) => {
      const branch = await ctx.db.restaurantBranch.findUnique({
        where: { id: input.branchId },
        select: { timezone: true },
      });
      if (!branch) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Branch ${input.branchId} was not found.`,
        });
      }
      try {
        return enumerateOccurrences(
          {
            frequency: input.frequency,
            interval: input.interval,
            daysOfWeek: input.daysOfWeek,
            monthDay: input.monthDay,
            startDate: input.startDate,
            endDate: input.endDate,
            dueTimeMinutes: input.dueTimeMinutes,
            intervalEndTimeMinutes: input.intervalEndTimeMinutes,
            windowMinutes: input.windowMinutes,
          },
          branch.timezone,
          input.from,
          input.to
        );
      } catch (err) {
        mapSopError(err);
      }
    }),

  /** Preview an existing assignment's schedule over a date window. */
  previewAssignmentSchedule: manageProcedure
    .input(z.object({ assignmentId: z.string(), from: DATE_ISO, to: DATE_ISO }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const assignment = await getAssignment(ctx.db, input.assignmentId);
        return enumerateOccurrences(
          assignmentRecurrenceRule(assignment),
          assignment.branch.timezone,
          input.from,
          input.to
        );
      } catch (err) {
        mapSopError(err);
      }
    }),

  /**
   * The job roles an assignment may be pooled to. Deliberately duplicated here
   * rather than reused from the staff router: this console gates on `sop:manage`,
   * and an SOP author who is not also a staff administrator must still be able to
   * pick a role. It returns identity only — no membership, no capabilities — so it
   * widens nothing.
   */
  listAssignableJobRoles: manageProcedure.query(({ ctx }) =>
    ctx.db.restaurantJobRole.findMany({
      where: { active: true },
      select: { id: true, key: true, name: true },
      orderBy: { name: 'asc' },
    })
  ),

  // ── Starter packs ─────────────────────────────────────────────────────────

  /** The nine packs on offer. Static catalogue — no tenant read. */
  listPacks: manageProcedure.query(() =>
    SOP_TEMPLATE_PACKS.map((pack) => ({
      key: pack.key,
      name: pack.name,
      category: pack.category,
      description: pack.description,
      defaultJobRoleKey: pack.defaultJobRoleKey,
      suggestedRecurrence: pack.suggestedRecurrence,
      stepCount: pack.steps.length,
    }))
  ),

  installPack: manageProcedure
    .input(z.object({ packKey: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      const pack = SOP_TEMPLATE_PACKS.find((candidate) => candidate.key === input.packKey);
      if (!pack) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Unknown SOP pack "${input.packKey}".` });
      }
      const result = await installSopPack(ctx.db, input.packKey);
      if (result.created) {
        annotateAudit(ctx, {
          targetType: 'RestaurantSopTemplate',
          targetId: result.templateId,
          description: `Installed SOP pack "${pack.name}"`,
        });
      }
      return result;
    }),

  installAllPacks: manageProcedure.mutation(async ({ ctx }) => {
    const results = await installAllSopPacks(ctx.db);
    const created = results.filter((result) => result.created);
    if (created.length > 0) {
      annotateAudit(ctx, {
        targetType: 'RestaurantSopTemplate',
        targetId: created[0]!.templateId,
        description: `Installed ${created.length} SOP starter pack(s)`,
      });
    }
    return results;
  }),

  // ── Assignment pools ──────────────────────────────────────────────────────
  //
  // These read and mutate one operator's own work queue. They gate on
  // `sop:complete` rather than `sop:manage`: claiming a checklist off your role's
  // pool is doing the work, not administering it, and requiring the authoring
  // capability would lock every barista out of their own list.

  /** Unclaimed pool items at a branch this operator is eligible to take. */
  listClaimablePool: completeProcedure
    .input(z.object({ staffProfileId: z.string(), branchId: z.string() }).strict())
    .query(({ ctx, input }) =>
      listClaimablePoolOccurrences(ctx.db, input.staffProfileId, { branchId: input.branchId })
    ),

  /**
   * Everything owed by this operator at a branch, from BOTH assignment modes,
   * unioned and de-duplicated (see `listStaffSopOccurrences`).
   */
  listMySopOccurrences: completeProcedure
    .input(z.object({ staffProfileId: z.string(), branchId: z.string() }).strict())
    .query(({ ctx, input }) =>
      listStaffSopOccurrences(ctx.db, input.staffProfileId, { branchId: input.branchId })
    ),

  /**
   * Take a pool occurrence. Never throws on a lost race — the outcome is data, so
   * the client can say "Jamie already picked this up" instead of showing an error
   * for a perfectly ordinary event. A genuinely ineligible or non-pool occurrence
   * IS an error.
   */
  claimOccurrence: completeProcedure
    .input(z.object({ occurrenceId: z.string(), staffProfileId: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      const outcome = await claimSopOccurrence(ctx.db, input.occurrenceId, input.staffProfileId);
      if (outcome.status === 'NOT_CLAIMABLE') {
        throw new TRPCError({
          code: outcome.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'FORBIDDEN',
          message:
            outcome.reason === 'NOT_ELIGIBLE'
              ? 'You do not hold the job role this checklist is pooled to at this branch.'
              : outcome.reason === 'NOT_FOUND'
                ? 'That checklist occurrence was not found.'
                : 'That checklist is not a claimable pool item.',
        });
      }
      if (outcome.status === 'CLAIMED') {
        annotateAudit(ctx, {
          targetType: 'RestaurantSopOccurrence',
          targetId: input.occurrenceId,
          description: `Claimed SOP occurrence from role pool`,
        });
      }
      return outcome;
    }),

  // ── Escalation policy configuration ─────────────────────────────────────────
  // Read/write over the EXISTING M7 policy model — the chain that
  // `sopEscalationHandler` already interprets, previously configurable only
  // through a database session.

  listEscalationPolicies: manageProcedure
    .input(
      z
        .object({ branchId: z.string().optional(), activeOnly: z.boolean().optional() })
        .strict()
        .optional()
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listEscalationPolicies(ctx.db, input ?? {});
      } catch (err) {
        mapSopError(err);
      }
    }),

  getEscalationPolicy: manageProcedure
    .input(z.object({ id: z.string() }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await getEscalationPolicy(ctx.db, input.id);
      } catch (err) {
        mapSopError(err);
      }
    }),

  createEscalationPolicy: manageProcedure
    .input(
      z
        .object({
          name: NAME,
          scope: ESCALATION_SCOPE,
          branchId: z.string().nullable().default(null),
          stopOnAcknowledged: z.boolean().default(true),
          stopOnVerified: z.boolean().default(true),
          quietHoursStartMinutes: MINUTES_OF_DAY.nullable().default(null),
          quietHoursEndMinutes: MINUTES_OF_DAY.nullable().default(null),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const policy = await createEscalationPolicy(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantSopEscalationPolicy',
          targetId: policy.id,
          targetLabel: policy.name,
          description: `Created SOP escalation policy "${policy.name}" (${policy.scope})`,
        });
        return policy;
      } catch (err) {
        mapSopError(err);
      }
    }),

  updateEscalationPolicy: manageProcedure
    .input(
      z
        .object({
          id: z.string(),
          name: NAME.optional(),
          stopOnAcknowledged: z.boolean().optional(),
          stopOnVerified: z.boolean().optional(),
          quietHoursStartMinutes: MINUTES_OF_DAY.nullable().optional(),
          quietHoursEndMinutes: MINUTES_OF_DAY.nullable().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const policy = await updateEscalationPolicy(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantSopEscalationPolicy',
          targetId: policy.id,
          targetLabel: policy.name,
          description: `Updated SOP escalation policy "${policy.name}"`,
        });
        return policy;
      } catch (err) {
        mapSopError(err);
      }
    }),

  setEscalationPolicyActive: manageProcedure
    .input(z.object({ id: z.string(), active: z.boolean() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const policy = await setEscalationPolicyActive(ctx.db, input.id, input.active);
        annotateAudit(ctx, {
          targetType: 'RestaurantSopEscalationPolicy',
          targetId: policy.id,
          targetLabel: policy.name,
          description: `${input.active ? 'Activated' : 'Deactivated'} SOP escalation policy "${policy.name}"`,
        });
        return policy;
      } catch (err) {
        mapSopError(err);
      }
    }),

  upsertEscalationStep: manageProcedure
    .input(
      z
        .object({
          policyId: z.string(),
          stepOrder: z.number().int().min(1).max(50),
          delayMinutes: z.number().int().min(0).max(10_080),
          target: z.string().min(1).max(200),
          channel: NOTIFICATION_CHANNEL,
          maxAttempts: z.number().int().min(1).max(10).default(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const step = await upsertEscalationStep(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantSopEscalationStep',
          targetId: step.id,
          description: `Configured escalation step ${step.stepOrder} on policy ${input.policyId}`,
        });
        return step;
      } catch (err) {
        mapSopError(err);
      }
    }),

  removeEscalationStep: manageProcedure
    .input(z.object({ policyId: z.string(), stepOrder: z.number().int().min(1).max(50) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const removed = await removeEscalationStep(ctx.db, input.policyId, input.stepOrder);
        annotateAudit(ctx, {
          targetType: 'RestaurantSopEscalationStep',
          targetId: removed.id,
          description: `Removed escalation step ${input.stepOrder} from policy ${input.policyId}`,
        });
        return removed;
      } catch (err) {
        mapSopError(err);
      }
    }),

  // ── Performance scoring ─────────────────────────────────────────────────────

  /**
   * Compliance score over a business-date window. The response carries the
   * formula, window, denominator and exclusions that produced every number, so
   * the UI can show how a score was reached rather than asserting it.
   */
  scoreReport: manageProcedure
    .input(
      z
        .object({
          from: DATE_ISO,
          to: DATE_ISO,
          branchId: z.string().nullable().default(null),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      if (input.from > input.to) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The window start must not be after its end.',
        });
      }
      try {
        return await buildScoreReport(ctx.db, {
          fromBusinessDate: businessDateToUtcDate(input.from),
          toBusinessDate: businessDateToUtcDate(input.to),
          branchId: input.branchId,
        });
      } catch (err) {
        mapSopError(err);
      }
    }),

  // ── Audit history ───────────────────────────────────────────────────────────

  listRecentOccurrences: manageProcedure.query(async ({ ctx }) => {
    const authorization = await resolveStaffBranchAuthorization(
      ctx.db,
      ctx.session!.user,
      ctx.entitlements.organizationId
    );
    return ctx.db.restaurantSopOccurrence.findMany({
      where: { branchId: { in: authorization.branchIds } },
      select: {
        id: true,
        businessDate: true,
        status: true,
        branch: { select: { name: true } },
        templateVersion: { select: { template: { select: { name: true } } } },
      },
      orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }),

  /**
   * The immutable trail for one occurrence, folded from the append-only step,
   * evidence, verification and escalation records. Read-only by construction.
   */
  occurrenceAuditTrail: manageProcedure
    .input(z.object({ occurrenceId: z.string() }).strict())
    .query(async ({ ctx, input }) => {
      const authorization = await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      );
      const accessible = await ctx.db.restaurantSopOccurrence.findFirst({
        where: { id: input.occurrenceId, branchId: { in: authorization.branchIds } },
        select: { id: true },
      });
      if (!accessible) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence unavailable.' });
      }
      const trail = await getOccurrenceAuditTrail(ctx.db, input.occurrenceId);
      if (!trail) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence unavailable.' });
      }
      return trail;
    }),
});
