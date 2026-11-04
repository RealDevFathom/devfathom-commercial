import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import type { PharmacySopRecordType } from '@/generated/prisma/client';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import {
  PHARMACY_SOP_ROLE_KEYS,
  PHARMACY_SOP_VERIFIER_ROLE_KEYS,
  PharmacySopAccessError,
  assertIndependentPharmacyVerifier,
  assertOccurrenceAtSite,
  enablePharmacySopSite,
  ensurePharmacySopJobRoles,
  linkPharmacySopRecord,
  listPharmacySopBranches,
  pharmacySopRolesAt,
  resolvePharmacySopActor,
  resolvePharmacySopSite,
  setPharmacySopRoleHolding,
  type PharmacySopActor,
  type PharmacySopRoleKey,
  type PharmacySopSiteRef,
} from '@/lib/pharmacy/sop-adapter';
import {
  PHARMACY_SOP_PACKS,
  installPharmacySopLibrary,
  pharmacySopPackForTemplateName,
  type PharmacySopPack,
  type PharmacySopPackStep,
} from '@/lib/pharmacy/sop-library';
import { businessDateToUtcDate, resolveBusinessDate } from '@/lib/restaurant/business-date';
import {
  AssigneeTargetError,
  claimSopOccurrence,
  listClaimablePoolOccurrences,
  listStaffSopOccurrences,
} from '@/lib/restaurant/sop-assignment';
import { getOccurrenceAuditTrail } from '@/lib/restaurant/sop-audit';
import {
  SopExecutionError,
  completeStep,
  startOccurrence,
  submitOccurrence,
} from '@/lib/restaurant/sop-execution';
import { isMissedAt } from '@/lib/restaurant/sop-late-missed';
import { generateDueSopOccurrences } from '@/lib/restaurant/sop-occurrence-generation';
import { RecurrenceError } from '@/lib/restaurant/sop-recurrence';
import { summarizeSopReport } from '@/lib/restaurant/sop-reporting';
import { buildScoreReport } from '@/lib/restaurant/sop-score';
import {
  SopTemplateError,
  createAssignment,
  listAssignments,
  setAssignmentActive,
} from '@/lib/restaurant/sop-templates';
import {
  SopVerificationError,
  rejectOccurrence,
  verifyOccurrence,
} from '@/lib/restaurant/sop-verification';
import { ianaTimezone } from '@/lib/timezone';
import { annotateAudit, type AuditDetail } from '../audit';
import {
  auditedProtectedProcedure,
  capabilityProcedure,
  protectedProcedure,
  router,
  type TRPCContext,
} from '../trpc';

/**
 * DEV-751 — pharmacy procedures on the shared SOP engine.
 *
 * A thin mapping layer. Every rule about checklists, claims, proof, state
 * transitions, recurrence and scoring lives in the engine
 * (`src/lib/restaurant/sop-*.ts`); every translation from pharmacy scope to the
 * engine's keys lives in the adapter (`src/lib/pharmacy/sop-adapter.ts`). This
 * router only:
 *
 * - gates each procedure on a generic SOP capability (`sop:manage`,
 *   `sop:complete`, `sop:verify`) and — through the `pharmacySop` namespace in
 *   the module catalog — on the `pharmacy-safety` module. It never consults or
 *   requires `restaurant-sop`, so a restaurant licence grants nothing here and a
 *   pharmacy licence grants nothing on the restaurant SOP routers;
 * - resolves the pharmacy branch through the adapter (scope comes from
 *   `pharmacy_branch_assignments`, never from the engine branch), asserts every
 *   occurrence id against that site, and derives the actor from the session —
 *   no input carries an actor, uploader or staff id (every schema is `.strict()`,
 *   so such a key is rejected rather than ignored);
 * - adds the two pharmacy-only submission requirements (a linked record for
 *   each step that names one, and a note when a linked temperature reading is
 *   out of range) before handing the submit to the engine.
 */

const manageProcedure = capabilityProcedure('sop:manage');
const completeProcedure = capabilityProcedure('sop:complete');
const verifyProcedure = capabilityProcedure('sop:verify');

const AUDIT_CATEGORY = 'PHARMACY_SAFETY';
const OPEN_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'REJECTED'] as const;
const REVIEW_STATUSES = ['SUBMITTED', 'LATE'] as const;
const TERMINAL_STATUSES = new Set(['VERIFIED', 'WAIVED']);
const BOARD_LOOKBACK_DAYS = 7;
const MAX_REPORT_DAYS = 366;
const DAY_MS = 86_400_000;

// ── Error mapping ─────────────────────────────────────────────────────────────

/**
 * Adapter refusals. Scope refusals carry fixed wording: the adapter's own
 * message may name a branch or occurrence, and a caller outside that branch
 * must not learn anything about it.
 */
function mapAccessError(err: PharmacySopAccessError): never {
  switch (err.reason) {
    case 'UNAUTHENTICATED':
      throw new TRPCError({ code: 'UNAUTHORIZED' });
    case 'BRANCH_OUT_OF_SCOPE':
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This pharmacy branch is outside your scope.',
      });
    case 'SITE_NOT_ENABLED':
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'SOPs are not enabled at this pharmacy branch yet.',
      });
    case 'NO_STAFF_PROFILE':
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'An active staff profile linked to this account is required for SOP work.',
      });
    case 'AMBIGUOUS_STAFF_PROFILE':
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This account is linked to more than one active staff profile. Ask an admin.',
      });
    case 'OCCURRENCE_OUT_OF_SCOPE':
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
    case 'RECORD_OUT_OF_SCOPE':
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Record not found at this branch.' });
    case 'ROLE_REQUIRED':
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'You do not hold the pharmacy SOP role this action needs at this branch.',
      });
    case 'NOT_INDEPENDENT':
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'A verifier must not have worked on the occurrence they verify.',
      });
    case 'INVALID_INPUT':
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  }
  throw new TRPCError({ code: 'FORBIDDEN' });
}

/** Engine refusals, mapped the way the restaurant SOP routers map them. */
function mapSopError(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof PharmacySopAccessError) mapAccessError(err);
  if (err instanceof SopExecutionError) {
    const code =
      err.reason === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : err.reason === 'NOT_OWNER'
          ? 'FORBIDDEN'
          : err.reason === 'INVALID_STATE' || err.reason === 'STEP_ALREADY_COMPLETED'
            ? 'CONFLICT'
            : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  if (err instanceof SopVerificationError) {
    const code =
      err.reason === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : err.reason === 'INVALID_STATE'
          ? 'CONFLICT'
          : err.reason === 'CO_AUTH_REQUIRED'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  if (err instanceof SopTemplateError) {
    const code =
      err.reason === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : err.reason === 'TEMPLATE_LIMIT_REACHED' ||
            err.reason === 'DRAFT_EXISTS' ||
            err.reason === 'VERSION_NOT_DRAFT' ||
            err.reason === 'INVALID_STATE'
          ? 'CONFLICT'
          : 'BAD_REQUEST';
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
  throw err;
}

/** Run a resolver body and translate every known SOP refusal. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    mapSopError(err);
  }
}

// ── Scope helpers ─────────────────────────────────────────────────────────────

function sessionScope(ctx: TRPCContext) {
  const user = ctx.session?.user;
  const organizationId = ctx.entitlements?.organizationId ?? user?.organizationId;
  if (!user?.id || !organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return { organizationId, userId: user.id };
}

async function siteFor(ctx: TRPCContext, pharmacyBranchId: string): Promise<PharmacySopSiteRef> {
  return resolvePharmacySopSite(ctx.db, { ...sessionScope(ctx), pharmacyBranchId });
}

async function actorFor(ctx: TRPCContext): Promise<PharmacySopActor> {
  return resolvePharmacySopActor(ctx.db, sessionScope(ctx));
}

async function allowed(ctx: TRPCContext, action: Action): Promise<boolean> {
  return can(subjectFromSession(ctx.session!.user), action, undefined, {
    db: ctx.db,
    source: 'TRPC',
    ip: ctx.requestMeta?.ip,
  });
}

/** For reads open to more than one SOP capability. Fails closed. */
async function requireAnyCapability(ctx: TRPCContext, actions: readonly Action[]): Promise<void> {
  for (const action of actions) {
    if (await allowed(ctx, action)) return;
  }
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'You do not have permission for this action.',
  });
}

function audit(
  ctx: TRPCContext,
  site: Pick<PharmacySopSiteRef, 'pharmacyBranchId'> | null,
  detail: AuditDetail
): void {
  annotateAudit(ctx, {
    category: AUDIT_CATEGORY,
    ...detail,
    metadata: {
      ...(site ? { pharmacyBranchId: site.pharmacyBranchId } : {}),
      ...(detail.metadata ?? {}),
    },
  });
}

/** Map pharmacy role keys to their job-role ids (read only; null if not seeded yet). */
async function pharmacyJobRoleIds(ctx: TRPCContext) {
  const rows = await ctx.db.restaurantJobRole.findMany({
    where: { key: { in: [...PHARMACY_SOP_ROLE_KEYS] } },
    select: { id: true, key: true },
  });
  const byKey = new Map<PharmacySopRoleKey, string>();
  const byId = new Map<string, PharmacySopRoleKey>();
  for (const row of rows) {
    byKey.set(row.key as PharmacySopRoleKey, row.id);
    byId.set(row.id, row.key as PharmacySopRoleKey);
  }
  return { byKey, byId };
}

/** The pharmacy pack an engine template belongs to, or a NOT_FOUND refusal. */
async function pharmacyTemplate(ctx: TRPCContext, templateId: string) {
  const template = await ctx.db.restaurantSopTemplate.findUnique({
    where: { id: templateId },
    select: { id: true, name: true, isActive: true },
  });
  const pack = template ? pharmacySopPackForTemplateName(template.name) : undefined;
  if (!template || !pack) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Pharmacy SOP template not found.' });
  }
  if (!template.isActive) {
    throw new TRPCError({ code: 'CONFLICT', message: 'This SOP template is archived.' });
  }
  return { template, pack };
}

/** Pack metadata for an installed step (by title, then by position). */
function packStepFor(
  pack: PharmacySopPack | undefined,
  step: { title: string; stepOrder: number }
): PharmacySopPackStep | undefined {
  if (!pack) return undefined;
  return (
    pack.steps.find((candidate) => candidate.title === step.title) ?? pack.steps[step.stepOrder - 1]
  );
}

function requiredRecordTypeOf(step: PharmacySopPackStep | undefined): PharmacySopRecordType | null {
  return step?.requiredRecordType ?? null;
}

function packSummary(pack: PharmacySopPack) {
  return {
    key: pack.key,
    name: pack.name,
    category: pack.category,
    description: pack.description,
    roleKey: pack.pharmacy.roleKey,
    assigneeTarget: pack.pharmacy.assigneeTarget,
    verifierRoleKeys: [...pack.pharmacy.verifierRoleKeys],
    trigger: pack.pharmacy.trigger,
    suggestedRecurrence: pack.pharmacy.suggestedRecurrence,
  };
}

/** The pharmacy pack an occurrence's pinned template version belongs to. */
async function packForVersion(
  ctx: TRPCContext,
  templateVersionId: string
): Promise<PharmacySopPack | undefined> {
  const version = await ctx.db.restaurantSopTemplateVersion.findFirst({
    where: { id: templateVersionId },
    select: { template: { select: { name: true } } },
  });
  return version ? pharmacySopPackForTemplateName(version.template.name) : undefined;
}

/** Roles that may verify this pack's occurrences (the pack's own list when it has one). */
function verifierRolesOf(pack: PharmacySopPack | undefined): readonly PharmacySopRoleKey[] {
  return pack?.pharmacy.verifierRoleKeys ?? PHARMACY_SOP_VERIFIER_ROLE_KEYS;
}

/** A step whose note documents an excursion or the corrective action taken. */
const EXCURSION_STEP = /excursion|corrective/i;

function isOverdue(
  occ: { status: string; windowEndsAt: Date; submittedAt?: Date | null },
  now: Date
): boolean {
  if (occ.status === 'MISSED') return true;
  if (!(OPEN_STATUSES as readonly string[]).includes(occ.status)) return false;
  return now > occ.windowEndsAt;
}

function localWallClock(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '0';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: ((Number(part('hour')) % 24) * 60 + Number(part('minute'))) % 1440,
  };
}

function addDaysISO(dateISO: string, days: number): string {
  return new Date(businessDateToUtcDate(dateISO).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Who may see one occurrence at a site: its owner, an eligible pool holder, a
 * holder of a verifier role with `sop:verify`, or a manager. Anyone else gets
 * the same NOT_FOUND as an id from another branch.
 */
async function assertOccurrenceVisible(
  ctx: TRPCContext,
  site: PharmacySopSiteRef,
  actor: PharmacySopActor,
  occ: {
    assignedStaffProfileId: string | null;
    claimedByStaffProfileId: string | null;
    poolJobRoleId: string | null;
  },
  pack: PharmacySopPack | undefined
): Promise<{ heldRoles: PharmacySopRoleKey[]; canVerify: boolean }> {
  const heldRoles = await pharmacySopRolesAt(ctx.db, {
    staffProfileId: actor.staffProfileId,
    sopBranchId: site.sopBranchId,
  });
  const verifierRoles = verifierRolesOf(pack);
  const canVerify =
    heldRoles.some((role) => verifierRoles.includes(role)) && (await allowed(ctx, 'sop:verify'));
  if (
    occ.assignedStaffProfileId === actor.staffProfileId ||
    occ.claimedByStaffProfileId === actor.staffProfileId ||
    canVerify
  ) {
    return { heldRoles, canVerify };
  }
  if (occ.poolJobRoleId && !occ.claimedByStaffProfileId) {
    const { byId } = await pharmacyJobRoleIds(ctx);
    const poolRole = byId.get(occ.poolJobRoleId);
    if (poolRole && heldRoles.includes(poolRole)) return { heldRoles, canVerify };
  }
  if (await allowed(ctx, 'sop:manage')) return { heldRoles, canVerify };
  throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
}

/** The occurrence must be the actor's own work (assigned or claimed). */
function assertOwnWork(
  occ: { assignedStaffProfileId: string | null; claimedByStaffProfileId: string | null },
  actor: PharmacySopActor
) {
  const owner = occ.assignedStaffProfileId ?? occ.claimedByStaffProfileId;
  if (owner !== actor.staffProfileId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the assigned or claiming staff member may work on this occurrence.',
    });
  }
}

/** Proof and record links may target a step only of this same occurrence. */
async function assertStepOnOccurrence(
  ctx: TRPCContext,
  occurrenceId: string,
  occurrenceStepId: string | null | undefined
): Promise<void> {
  if (!occurrenceStepId) return;
  const step = await ctx.db.restaurantSopOccurrenceStep.findFirst({
    where: { id: occurrenceStepId, occurrenceId },
    select: { id: true },
  });
  if (!step)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Step not found on this occurrence.' });
}

/** Site + occurrence + session actor: the preamble of every occurrence command. */
async function occurrenceContext(ctx: TRPCContext, pharmacyBranchId: string, occurrenceId: string) {
  const site = await siteFor(ctx, pharmacyBranchId);
  const occurrence = await assertOccurrenceAtSite(ctx.db, { occurrenceId, site });
  const actor = await actorFor(ctx);
  return { site, occurrence, actor };
}

// ── Pharmacy submission requirements ──────────────────────────────────────────

/**
 * Pharmacy-only checks the engine does not know about, run before the engine's
 * own submit (which enforces completion, notes, photo and signature proof).
 */
async function assertPharmacySubmissionRequirements(
  ctx: TRPCContext,
  site: PharmacySopSiteRef,
  occurrenceId: string
): Promise<void> {
  const occ = await ctx.db.restaurantSopOccurrence.findUnique({
    where: { id: occurrenceId },
    select: {
      assignment: { select: { template: { select: { name: true } } } },
      steps: {
        select: {
          id: true,
          note: true,
          templateStep: { select: { title: true, stepOrder: true } },
        },
      },
    },
  });
  if (!occ) throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
  const pack = pharmacySopPackForTemplateName(occ.assignment.template.name);
  const links = await ctx.db.pharmacySopRecordLink.findMany({
    where: { occurrenceId, pharmacyBranchId: site.pharmacyBranchId },
    select: { occurrenceStepId: true, recordType: true, recordId: true, note: true },
  });

  for (const step of occ.steps) {
    const required = requiredRecordTypeOf(packStepFor(pack, step.templateStep));
    if (!required) continue;
    const linked = links.some(
      (link) => link.recordType === required && link.occurrenceStepId === step.id
    );
    if (!linked) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Link the ${required.toLowerCase().replaceAll('_', ' ')} for “${step.templateStep.title}” before submitting.`,
      });
    }
  }

  const temperatureLinks = links.filter((link) => link.recordType === 'TEMPERATURE_LOG');
  if (temperatureLinks.length === 0) return;
  const outOfRange = await ctx.db.pharmacyTemperatureLog.findMany({
    where: {
      id: { in: temperatureLinks.map((link) => link.recordId) },
      branchId: site.pharmacyBranchId,
      outOfRange: true,
    },
    select: { id: true },
  });
  if (outOfRange.length === 0) return;

  const excursionStep = occ.steps.find((step) => EXCURSION_STEP.test(step.templateStep.title));
  const hasText = (value: string | null | undefined) => Boolean(value?.trim());
  const documented = excursionStep
    ? hasText(excursionStep.note)
    : outOfRange.every((reading) => {
        const link = temperatureLinks.find((candidate) => candidate.recordId === reading.id);
        const step = occ.steps.find((candidate) => candidate.id === link?.occurrenceStepId);
        return hasText(link?.note) || hasText(step?.note);
      });
  if (!documented) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: excursionStep
        ? `A linked temperature reading is out of range. Record the excursion and corrective action on “${excursionStep.templateStep.title}” before submitting.`
        : 'A linked temperature reading is out of range. Add a note describing the excursion and corrective action before submitting.',
    });
  }
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const ID = z.string().trim().min(1).max(200);
const BRANCH = { pharmacyBranchId: ID } as const;
const OCCURRENCE = { pharmacyBranchId: ID, occurrenceId: ID } as const;
const DATE_ISO = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date.')
  .refine((value) => {
    try {
      businessDateToUtcDate(value);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid calendar date.');
const MINUTES_OF_DAY = z.number().int().min(0).max(1439);
const ROLE_KEY = z.enum(PHARMACY_SOP_ROLE_KEYS);
const RECORD_TYPE = z.enum([
  'TEMPERATURE_LOG',
  'CONTROLLED_REGISTER_ENTRY',
  'GOODS_RECEIPT',
  'MANUFACTURING_BATCH',
  'RECALL_NOTICE',
]) satisfies z.ZodType<PharmacySopRecordType>;
const NOTE = z.string().max(2_000).nullable().optional();

const ASSIGNMENT_TARGET = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ROLE'), roleKey: ROLE_KEY }).strict(),
  z.object({ type: z.literal('PERSON'), userId: ID }).strict(),
]);

const CreateAssignmentInput = z
  .object({
    ...BRANCH,
    templateId: ID,
    target: ASSIGNMENT_TARGET,
    frequency: z.enum(['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'INTERVAL']),
    interval: z.number().int().min(1).max(1440).default(1),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    monthDay: z.number().int().min(1).max(31).nullable().default(null),
    dueTimeMinutes: MINUTES_OF_DAY.default(0),
    intervalEndTimeMinutes: MINUTES_OF_DAY.nullable().default(null),
    windowMinutes: z.number().int().min(0).max(1440).default(1440),
    graceMinutes: z.number().int().min(0).max(1440).default(0),
    startDate: DATE_ISO,
    endDate: DATE_ISO.nullable().default(null),
  })
  .strict()
  .superRefine((value, refinement) => {
    if (value.frequency !== 'INTERVAL') return;
    if (value.interval < 15) {
      refinement.addIssue({
        code: 'custom',
        path: ['interval'],
        message: 'Minimum is 15 minutes.',
      });
    }
    if (value.daysOfWeek.length === 0) {
      refinement.addIssue({
        code: 'custom',
        path: ['daysOfWeek'],
        message: 'Select at least one weekday.',
      });
    }
  });

// ── Read models ───────────────────────────────────────────────────────────────

const BOARD_SELECT = {
  id: true,
  status: true,
  businessDate: true,
  dueAt: true,
  windowEndsAt: true,
  startedAt: true,
  submittedAt: true,
  assignedStaffProfileId: true,
  poolJobRoleId: true,
  claimedByStaffProfileId: true,
  assignment: {
    select: { graceMinutes: true, template: { select: { id: true, name: true, category: true } } },
  },
  steps: { select: { completed: true } },
} as const;

type BoardRow = {
  id: string;
  status: string;
  businessDate: Date;
  dueAt: Date;
  windowEndsAt: Date;
  startedAt: Date | null;
  submittedAt: Date | null;
  assignedStaffProfileId: string | null;
  poolJobRoleId: string | null;
  claimedByStaffProfileId: string | null;
  assignment: {
    graceMinutes: number;
    template: { id: string; name: string; category: string | null };
  };
  steps: Array<{ completed: boolean }>;
};

function boardItem(row: BoardRow, now: Date, roleById: Map<string, PharmacySopRoleKey>) {
  const pack = pharmacySopPackForTemplateName(row.assignment.template.name);
  return {
    occurrenceId: row.id,
    status: row.status,
    businessDate: row.businessDate,
    dueAt: row.dueAt,
    windowEndsAt: row.windowEndsAt,
    startedAt: row.startedAt,
    submittedAt: row.submittedAt,
    templateId: row.assignment.template.id,
    templateName: row.assignment.template.name,
    category: row.assignment.template.category,
    packKey: pack?.key ?? null,
    roleKey: pack?.pharmacy.roleKey ?? null,
    poolRoleKey: row.poolJobRoleId ? (roleById.get(row.poolJobRoleId) ?? null) : null,
    claimed: Boolean(row.claimedByStaffProfileId),
    stepsTotal: row.steps.length,
    stepsCompleted: row.steps.filter((step) => step.completed).length,
    overdue: isOverdue(row, now),
    missedRisk:
      (OPEN_STATUSES as readonly string[]).includes(row.status) &&
      isMissedAt(now, row.windowEndsAt, row.assignment.graceMinutes),
  };
}

// ── Router ────────────────────────────────────────────────────────────────────

export const pharmacySopRouter = router({
  access: protectedProcedure.query(async ({ ctx }) => {
    const [canManage, canComplete, canVerify] = await Promise.all([
      allowed(ctx, 'sop:manage'),
      allowed(ctx, 'sop:complete'),
      allowed(ctx, 'sop:verify'),
    ]);
    return { canManage, canComplete, canVerify };
  }),

  branches: auditedProtectedProcedure.query(async ({ ctx }) => {
    await requireAnyCapability(ctx, ['sop:complete', 'sop:manage', 'sop:verify']);
    return guarded(() => listPharmacySopBranches(ctx.db, sessionScope(ctx)));
  }),

  // ── Setup (sop:manage) ────────────────────────────────────────────────────

  enableSite: manageProcedure
    .input(
      z
        .object({
          ...BRANCH,
          timezone: ianaTimezone,
          businessDayCutoff: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM.')
            .optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      guarded(async () => {
        // The site does not exist yet, so branch assignment is checked by the
        // adapter itself rather than by `resolvePharmacySopSite`.
        const result = await enablePharmacySopSite(ctx.db, { ...sessionScope(ctx), ...input });
        audit(ctx, result.site, {
          action: 'pharmacy.sop.enableSite',
          targetType: 'PharmacySopSite',
          targetId: result.site.pharmacyBranchId,
          description: result.created
            ? 'Enabled SOPs at pharmacy branch'
            : 'SOPs already enabled at pharmacy branch',
          metadata: { created: result.created, timezone: result.site.timezone },
        });
        return result;
      })
    ),

  installLibrary: manageProcedure.mutation(({ ctx }) =>
    guarded(async () => {
      const results = await installPharmacySopLibrary(ctx.db);
      const created = results.filter((result) => result.created);
      audit(ctx, null, {
        action: 'pharmacy.sop.installLibrary',
        targetType: 'RestaurantSopTemplate',
        targetId: created[0]?.templateId,
        description: `Installed ${created.length} pharmacy SOP pack(s)`,
        metadata: { created: created.map((result) => result.packKey) },
      });
      return results;
    })
  ),

  templates: manageProcedure.query(({ ctx }) =>
    guarded(async () => {
      const templates = await ctx.db.restaurantSopTemplate.findMany({
        where: { name: { in: PHARMACY_SOP_PACKS.map((pack) => pack.name) } },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          category: true,
          isActive: true,
          versions: {
            where: { status: 'PUBLISHED' },
            orderBy: { versionNumber: 'desc' },
            take: 1,
            select: {
              id: true,
              versionNumber: true,
              steps: {
                orderBy: { stepOrder: 'asc' },
                select: {
                  id: true,
                  stepOrder: true,
                  title: true,
                  instructions: true,
                  requiresPhoto: true,
                  requiresNote: true,
                  requiresSignature: true,
                },
              },
            },
          },
        },
      });
      return templates.flatMap((template) => {
        const pack = pharmacySopPackForTemplateName(template.name);
        if (!pack) return [];
        const version = template.versions[0] ?? null;
        return [
          {
            id: template.id,
            name: template.name,
            category: template.category,
            isActive: template.isActive,
            pack: packSummary(pack),
            publishedVersion: version
              ? { id: version.id, versionNumber: version.versionNumber }
              : null,
            steps: (version?.steps ?? []).map((step) => ({
              ...step,
              requiredRecordType: requiredRecordTypeOf(packStepFor(pack, step)),
            })),
          },
        ];
      });
    })
  ),

  assignments: manageProcedure.input(z.object(BRANCH).strict()).query(({ ctx, input }) =>
    guarded(async () => {
      const site = await siteFor(ctx, input.pharmacyBranchId);
      const [rows, roles] = await Promise.all([
        listAssignments(ctx.db, { branchId: site.sopBranchId }),
        pharmacyJobRoleIds(ctx),
      ]);
      const pharmacyRows = rows.filter((row) => pharmacySopPackForTemplateName(row.template.name));
      const staffIds = [
        ...new Set(pharmacyRows.flatMap((row) => row.assigneeStaffProfileId ?? [])),
      ];
      const staff = staffIds.length
        ? await ctx.db.restaurantStaffProfile.findMany({
            where: { id: { in: staffIds } },
            select: { id: true, displayName: true, userId: true },
          })
        : [];
      return pharmacyRows.map((row) => {
        const person = staff.find((candidate) => candidate.id === row.assigneeStaffProfileId);
        return {
          id: row.id,
          templateId: row.template.id,
          templateName: row.template.name,
          packKey: pharmacySopPackForTemplateName(row.template.name)?.key ?? null,
          target:
            row.assigneeTargetType === 'PERSON'
              ? {
                  type: 'PERSON' as const,
                  userId: person?.userId ?? null,
                  displayName: person?.displayName ?? null,
                }
              : {
                  type: 'ROLE' as const,
                  roleKey: row.assigneeJobRoleId
                    ? (roles.byId.get(row.assigneeJobRoleId) ?? null)
                    : null,
                },
          frequency: row.frequency,
          interval: row.interval,
          daysOfWeek: row.daysOfWeek,
          monthDay: row.monthDay,
          dueTimeMinutes: row.dueTimeMinutes,
          intervalEndTimeMinutes: row.intervalEndTimeMinutes,
          windowMinutes: row.windowMinutes,
          graceMinutes: row.graceMinutes,
          startDate: row.startDate,
          endDate: row.endDate,
          active: row.active,
          superseded: Boolean(row.supersededAt),
        };
      });
    })
  ),

  createAssignment: manageProcedure.input(CreateAssignmentInput).mutation(({ ctx, input }) =>
    guarded(async () => {
      const site = await siteFor(ctx, input.pharmacyBranchId);
      const { template } = await pharmacyTemplate(ctx, input.templateId);
      let assigneeTarget:
        { type: 'role'; jobRoleId: string } | { type: 'person'; staffProfileId: string };
      if (input.target.type === 'ROLE') {
        const roleIds = await ensurePharmacySopJobRoles(ctx.db);
        assigneeTarget = { type: 'role', jobRoleId: roleIds[input.target.roleKey] };
      } else {
        const assignment = await ctx.db.pharmacyBranchAssignment.findFirst({
          where: {
            branchId: site.pharmacyBranchId,
            userId: input.target.userId,
            active: true,
            user: { status: 'ACTIVE' },
          },
          select: { userId: true },
        });
        if (!assignment) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'That person is not actively assigned to this pharmacy branch.',
          });
        }
        const person = await resolvePharmacySopActor(ctx.db, {
          organizationId: sessionScope(ctx).organizationId,
          userId: assignment.userId,
        });
        assigneeTarget = { type: 'person', staffProfileId: person.staffProfileId };
      }
      const created = await createAssignment(ctx.db, {
        branchId: site.sopBranchId,
        templateId: template.id,
        assigneeTarget,
        frequency: input.frequency,
        interval: input.interval,
        daysOfWeek: input.daysOfWeek,
        monthDay: input.monthDay,
        startDate: input.startDate,
        endDate: input.endDate,
        dueTimeMinutes: input.dueTimeMinutes,
        intervalEndTimeMinutes: input.intervalEndTimeMinutes,
        windowMinutes: input.windowMinutes,
        graceMinutes: input.graceMinutes,
      });
      audit(ctx, site, {
        action: 'pharmacy.sop.createAssignment',
        targetType: 'RestaurantSopAssignment',
        targetId: created.id,
        description: `Assigned pharmacy SOP “${template.name}”`,
        metadata: {
          templateId: template.id,
          targetType: input.target.type,
          ...(input.target.type === 'ROLE' ? { roleKey: input.target.roleKey } : {}),
        },
      });
      return created;
    })
  ),

  setAssignmentActive: manageProcedure
    .input(z.object({ ...BRANCH, assignmentId: ID, active: z.boolean() }).strict())
    .mutation(({ ctx, input }) =>
      guarded(async () => {
        const site = await siteFor(ctx, input.pharmacyBranchId);
        const existing = await ctx.db.restaurantSopAssignment.findUnique({
          where: { id: input.assignmentId },
          select: { id: true, branchId: true, template: { select: { name: true } } },
        });
        if (
          !existing ||
          existing.branchId !== site.sopBranchId ||
          !pharmacySopPackForTemplateName(existing.template.name)
        ) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Assignment not found.' });
        }
        const updated = await setAssignmentActive(ctx.db, existing.id, input.active);
        audit(ctx, site, {
          action: 'pharmacy.sop.setAssignmentActive',
          targetType: 'RestaurantSopAssignment',
          targetId: existing.id,
          description: input.active
            ? 'Resumed pharmacy SOP assignment'
            : 'Paused pharmacy SOP assignment',
        });
        return updated;
      })
    ),

  roleHoldings: manageProcedure.input(z.object(BRANCH).strict()).query(({ ctx, input }) =>
    guarded(async () => {
      const site = await siteFor(ctx, input.pharmacyBranchId);
      const assignments = await ctx.db.pharmacyBranchAssignment.findMany({
        where: { branchId: site.pharmacyBranchId, active: true, user: { status: 'ACTIVE' } },
        select: { userId: true, user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      });
      const userIds = assignments.map((row) => row.userId);
      const [profiles, roles] = await Promise.all([
        userIds.length
          ? ctx.db.restaurantStaffProfile.findMany({
              where: { userId: { in: userIds }, status: 'ACTIVE' },
              select: {
                id: true,
                userId: true,
                displayName: true,
                jobRoles: {
                  where: { branchId: site.sopBranchId },
                  select: { jobRoleId: true },
                },
              },
            })
          : Promise.resolve([]),
        pharmacyJobRoleIds(ctx),
      ]);
      return assignments
        .map((row) => {
          const mine = profiles.filter((profile) => profile.userId === row.userId);
          const profile = mine.length === 1 ? mine[0]! : null;
          return {
            userId: row.userId,
            name: row.user.name,
            email: row.user.email,
            staffProfile: mine.length === 0 ? 'NONE' : mine.length === 1 ? 'ONE' : 'AMBIGUOUS',
            staffProfileId: profile?.id ?? null,
            displayName: profile?.displayName ?? row.user.name,
            roleKeys: profile
              ? profile.jobRoles.flatMap((holding) => roles.byId.get(holding.jobRoleId) ?? [])
              : [],
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
    })
  ),

  setRoleHolding: manageProcedure
    .input(z.object({ ...BRANCH, userId: ID, roleKey: ROLE_KEY, held: z.boolean() }).strict())
    .mutation(({ ctx, input }) =>
      guarded(async () => {
        const site = await siteFor(ctx, input.pharmacyBranchId);
        const actor = await actorFor(ctx);
        const result = await setPharmacySopRoleHolding(ctx.db, {
          organizationId: sessionScope(ctx).organizationId,
          site,
          targetUserId: input.userId,
          roleKey: input.roleKey,
          held: input.held,
          grantedByStaffProfileId: actor.staffProfileId,
        });
        audit(ctx, site, {
          action: input.held ? 'pharmacy.sop.grantRole' : 'pharmacy.sop.revokeRole',
          targetType: 'User',
          targetId: input.userId,
          description: `${input.held ? 'Granted' : 'Revoked'} pharmacy SOP role ${input.roleKey}`,
          metadata: { roleKey: input.roleKey, changed: result.changed },
        });
        return result;
      })
    ),

  /**
   * Materialise due occurrences. The engine generator is tenant-wide and
   * idempotent (`unique(assignmentId, dueAt)`), so this also catches up any
   * other enabled site in the organization — exactly what the scheduler does.
   */
  generate: manageProcedure.input(z.object(BRANCH).strict()).mutation(({ ctx, input }) =>
    guarded(async () => {
      const site = await siteFor(ctx, input.pharmacyBranchId);
      const result = await generateDueSopOccurrences(ctx.db);
      audit(ctx, site, {
        action: 'pharmacy.sop.generate',
        targetType: 'PharmacySopSite',
        targetId: site.pharmacyBranchId,
        description: `Generated ${result.created} SOP occurrence(s)`,
        metadata: { ...result },
      });
      return result;
    })
  ),

  // ── Doing the work (sop:complete) ─────────────────────────────────────────

  /**
   * Start an event-triggered procedure (receiving, incident/CAPA) now. Creates a
   * one-off PERSON assignment for the session actor and materialises it through
   * the engine generator. A second call while that occurrence is still open
   * returns it instead of creating another.
   */
  startOnDemand: completeProcedure
    .input(z.object({ ...BRANCH, templateId: ID }).strict())
    .mutation(({ ctx, input }) =>
      guarded(async () => {
        const site = await siteFor(ctx, input.pharmacyBranchId);
        const { template, pack } = await pharmacyTemplate(ctx, input.templateId);
        if (pack.pharmacy.trigger !== 'EVENT') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Only event-triggered procedures can be started on demand.',
          });
        }
        const actor = await actorFor(ctx);
        const heldRoles = await pharmacySopRolesAt(ctx.db, {
          staffProfileId: actor.staffProfileId,
          sopBranchId: site.sopBranchId,
        });
        if (!heldRoles.includes(pack.pharmacy.roleKey)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not hold the pharmacy SOP role this procedure needs at this branch.',
          });
        }

        const open = await ctx.db.restaurantSopOccurrence.findFirst({
          where: {
            branchId: site.sopBranchId,
            assignedStaffProfileId: actor.staffProfileId,
            status: { in: [...OPEN_STATUSES] },
            assignment: {
              templateId: template.id,
              frequency: 'ONCE',
              assigneeTargetType: 'PERSON',
            },
          },
          orderBy: { dueAt: 'desc' },
          select: { id: true },
        });
        if (open) return { occurrenceId: open.id, created: false };

        const now = new Date();
        const local = localWallClock(now, site.timezone);
        const assignment = await createAssignment(ctx.db, {
          branchId: site.sopBranchId,
          templateId: template.id,
          assigneeTarget: { type: 'person', staffProfileId: actor.staffProfileId },
          frequency: 'ONCE',
          interval: 1,
          daysOfWeek: [],
          monthDay: null,
          startDate: local.date,
          endDate: local.date,
          dueTimeMinutes: local.minutes,
          intervalEndTimeMinutes: null,
          windowMinutes: pack.pharmacy.suggestedRecurrence.windowMinutes,
          graceMinutes: pack.pharmacy.suggestedRecurrence.graceMinutes,
        });
        await generateDueSopOccurrences(ctx.db, { now });
        const occurrence = await ctx.db.restaurantSopOccurrence.findFirst({
          where: { assignmentId: assignment.id },
          select: { id: true },
        });
        // The one-off occurrence now exists on its own; pausing the assignment
        // keeps it out of every later generator pass.
        await setAssignmentActive(ctx.db, assignment.id, false);
        if (!occurrence) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'This procedure has no published version to start.',
          });
        }
        audit(ctx, site, {
          action: 'pharmacy.sop.startOnDemand',
          targetType: 'RestaurantSopOccurrence',
          targetId: occurrence.id,
          description: `Started event procedure “${template.name}”`,
          metadata: { templateId: template.id, assignmentId: assignment.id },
        });
        return { occurrenceId: occurrence.id, created: true };
      })
    ),

  board: completeProcedure.input(z.object(BRANCH).strict()).query(({ ctx, input }) =>
    guarded(async () => {
      const site = await siteFor(ctx, input.pharmacyBranchId);
      const actor = await actorFor(ctx);
      const now = new Date();
      const today = resolveBusinessDate(now, site.timezone, site.businessDayCutoff);
      const window = {
        branchId: site.sopBranchId,
        businessDateFrom: businessDateToUtcDate(addDaysISO(today, -BOARD_LOOKBACK_DAYS)),
        businessDateTo: businessDateToUtcDate(addDaysISO(today, 1)),
      };
      const [own, pool, heldRoles, roles, canVerifyCap] = await Promise.all([
        listStaffSopOccurrences(ctx.db, actor.staffProfileId, window),
        listClaimablePoolOccurrences(ctx.db, actor.staffProfileId, window),
        pharmacySopRolesAt(ctx.db, {
          staffProfileId: actor.staffProfileId,
          sopBranchId: site.sopBranchId,
        }),
        pharmacyJobRoleIds(ctx),
        allowed(ctx, 'sop:verify'),
      ]);
      const canReview =
        canVerifyCap && heldRoles.some((role) => PHARMACY_SOP_VERIFIER_ROLE_KEYS.includes(role));
      const mayVerify = (row: BoardRow) =>
        verifierRolesOf(pharmacySopPackForTemplateName(row.assignment.template.name)).some((role) =>
          heldRoles.includes(role)
        );

      const mineIds = own
        .filter((row) => row.paths.includes('DIRECT') || row.paths.includes('CLAIMED'))
        .map((row) => row.occurrenceId);
      const poolIds = pool
        .filter((row) => (OPEN_STATUSES as readonly string[]).includes(row.status))
        .map((row) => row.id);
      const [mineRows, poolRows, reviewRows] = await Promise.all([
        mineIds.length
          ? ctx.db.restaurantSopOccurrence.findMany({
              where: { id: { in: mineIds }, branchId: site.sopBranchId },
              orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
              select: BOARD_SELECT,
            })
          : Promise.resolve([]),
        poolIds.length
          ? ctx.db.restaurantSopOccurrence.findMany({
              where: { id: { in: poolIds }, branchId: site.sopBranchId },
              orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
              select: BOARD_SELECT,
            })
          : Promise.resolve([]),
        canReview
          ? ctx.db.restaurantSopOccurrence.findMany({
              where: {
                branchId: site.sopBranchId,
                status: { in: [...REVIEW_STATUSES] },
                NOT: [
                  { assignedStaffProfileId: actor.staffProfileId },
                  { claimedByStaffProfileId: actor.staffProfileId },
                ],
              },
              orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
              take: 100,
              select: BOARD_SELECT,
            })
          : Promise.resolve([]),
      ]);
      const pharmacyOnly = (rows: BoardRow[]) =>
        rows
          .filter((row) => pharmacySopPackForTemplateName(row.assignment.template.name))
          .map((row) => boardItem(row, now, roles.byId));
      const mine = pharmacyOnly(mineRows as BoardRow[]).filter(
        (item) => !TERMINAL_STATUSES.has(item.status)
      );
      const poolItems = pharmacyOnly(poolRows as BoardRow[]);
      const review = pharmacyOnly((reviewRows as BoardRow[]).filter(mayVerify));
      const todayDate = businessDateToUtcDate(today).getTime();
      const actionable = [...mine, ...poolItems];
      return {
        businessDate: today,
        canReview,
        mine,
        pool: poolItems,
        review,
        counts: {
          overdue: actionable.filter((item) => item.overdue).length,
          dueToday: actionable.filter(
            (item) =>
              item.businessDate.getTime() === todayDate &&
              (OPEN_STATUSES as readonly string[]).includes(item.status)
          ).length,
          awaitingReview: review.length,
        },
      };
    })
  ),

  occurrence: completeProcedure.input(z.object(OCCURRENCE).strict()).query(({ ctx, input }) =>
    guarded(async () => {
      const { site, occurrence, actor } = await occurrenceContext(
        ctx,
        input.pharmacyBranchId,
        input.occurrenceId
      );
      const { canVerify } = await assertOccurrenceVisible(
        ctx,
        site,
        actor,
        occurrence,
        await packForVersion(ctx, occurrence.templateVersionId)
      );
      const [detail, links, trail, roles] = await Promise.all([
        ctx.db.restaurantSopOccurrence.findUnique({
          where: { id: occurrence.id },
          select: {
            id: true,
            status: true,
            businessDate: true,
            dueAt: true,
            windowEndsAt: true,
            startedAt: true,
            submittedAt: true,
            resolvedAt: true,
            assignedStaffProfileId: true,
            claimedByStaffProfileId: true,
            poolJobRoleId: true,
            assignment: {
              select: {
                graceMinutes: true,
                template: { select: { id: true, name: true, category: true } },
              },
            },
            steps: {
              select: {
                id: true,
                templateStepId: true,
                completed: true,
                completedAt: true,
                note: true,
                completedBy: { select: { displayName: true } },
                templateStep: {
                  select: {
                    stepOrder: true,
                    title: true,
                    instructions: true,
                    requiresPhoto: true,
                    requiresNote: true,
                    requiresSignature: true,
                  },
                },
              },
            },
            evidence: {
              orderBy: { capturedAt: 'asc' },
              select: {
                id: true,
                occurrenceStepId: true,
                mimeType: true,
                sizeBytes: true,
                storageRef: true,
                capturedAt: true,
                uploader: { select: { displayName: true } },
              },
            },
            verifications: {
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                action: true,
                reason: true,
                createdAt: true,
                actor: { select: { displayName: true } },
              },
            },
          },
        }),
        ctx.db.pharmacySopRecordLink.findMany({
          where: { occurrenceId: occurrence.id, pharmacyBranchId: site.pharmacyBranchId },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            occurrenceStepId: true,
            recordType: true,
            recordId: true,
            note: true,
            createdAt: true,
            linkedByStaffProfileId: true,
          },
        }),
        getOccurrenceAuditTrail(ctx.db, occurrence.id),
        pharmacyJobRoleIds(ctx),
      ]);
      if (!detail) throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
      const pack = pharmacySopPackForTemplateName(detail.assignment.template.name);
      const isOwner =
        (detail.assignedStaffProfileId ?? detail.claimedByStaffProfileId) === actor.staffProfileId;
      audit(ctx, site, {
        operation: 'READ',
        action: 'pharmacy.sop.occurrence.read',
        targetType: 'RestaurantSopOccurrence',
        targetId: detail.id,
      });
      return {
        id: detail.id,
        status: detail.status,
        businessDate: detail.businessDate,
        dueAt: detail.dueAt,
        windowEndsAt: detail.windowEndsAt,
        startedAt: detail.startedAt,
        submittedAt: detail.submittedAt,
        resolvedAt: detail.resolvedAt,
        overdue: isOverdue(detail, new Date()),
        template: detail.assignment.template,
        pack: pack ? packSummary(pack) : null,
        poolRoleKey: detail.poolJobRoleId ? (roles.byId.get(detail.poolJobRoleId) ?? null) : null,
        viewer: {
          isOwner,
          canClaim: Boolean(
            detail.poolJobRoleId &&
            !detail.claimedByStaffProfileId &&
            (OPEN_STATUSES as readonly string[]).includes(detail.status)
          ),
          canVerify: canVerify && !isOwner,
        },
        steps: [...detail.steps]
          .sort((a, b) => a.templateStep.stepOrder - b.templateStep.stepOrder)
          .map((step) => ({
            id: step.id,
            templateStepId: step.templateStepId,
            stepOrder: step.templateStep.stepOrder,
            title: step.templateStep.title,
            instructions: step.templateStep.instructions,
            requiresPhoto: step.templateStep.requiresPhoto,
            requiresNote: step.templateStep.requiresNote,
            requiresSignature: step.templateStep.requiresSignature,
            requiredRecordType: requiredRecordTypeOf(packStepFor(pack, step.templateStep)),
            completed: step.completed,
            completedAt: step.completedAt,
            completedByName: step.completedBy?.displayName ?? null,
            note: step.note,
          })),
        evidence: detail.evidence.map((row) => ({
          id: row.id,
          occurrenceStepId: row.occurrenceStepId,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          storageRef: row.storageRef,
          capturedAt: row.capturedAt,
          uploaderName: row.uploader?.displayName ?? null,
        })),
        recordLinks: links,
        verifications: detail.verifications.map((row) => ({
          id: row.id,
          action: row.action,
          reason: row.reason,
          createdAt: row.createdAt,
          actorName: row.actor?.displayName ?? null,
        })),
        auditTrail: trail ?? [],
      };
    })
  ),

  claim: completeProcedure.input(z.object(OCCURRENCE).strict()).mutation(({ ctx, input }) =>
    guarded(async () => {
      const { site, occurrence, actor } = await occurrenceContext(
        ctx,
        input.pharmacyBranchId,
        input.occurrenceId
      );
      const outcome = await claimSopOccurrence(ctx.db, occurrence.id, actor.staffProfileId);
      if (outcome.status === 'NOT_CLAIMABLE') {
        throw new TRPCError({
          code:
            outcome.reason === 'NOT_FOUND'
              ? 'NOT_FOUND'
              : outcome.reason === 'NOT_ELIGIBLE'
                ? 'FORBIDDEN'
                : 'CONFLICT',
          message:
            outcome.reason === 'NOT_ELIGIBLE'
              ? 'You do not hold the role this procedure is pooled to at this branch.'
              : 'This occurrence is not available to claim.',
        });
      }
      if (outcome.status === 'CLAIMED_BY_OTHER') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Someone else has already claimed this occurrence.',
        });
      }
      if (outcome.status === 'CLAIMED') {
        audit(ctx, site, {
          action: 'pharmacy.sop.claim',
          targetType: 'RestaurantSopOccurrence',
          targetId: occurrence.id,
          description: 'Claimed pharmacy SOP occurrence from role pool',
        });
      }
      return outcome;
    })
  ),

  start: completeProcedure.input(z.object(OCCURRENCE).strict()).mutation(({ ctx, input }) =>
    guarded(async () => {
      const { site, occurrence, actor } = await occurrenceContext(
        ctx,
        input.pharmacyBranchId,
        input.occurrenceId
      );
      const result = await startOccurrence(ctx.db, {
        occurrenceId: occurrence.id,
        actorStaffProfileId: actor.staffProfileId,
      });
      audit(ctx, site, {
        action: 'pharmacy.sop.start',
        targetType: 'RestaurantSopOccurrence',
        targetId: occurrence.id,
        description:
          occurrence.status === 'REJECTED'
            ? 'Restarted rejected pharmacy SOP occurrence'
            : 'Started pharmacy SOP occurrence',
      });
      return result;
    })
  ),

  completeStep: completeProcedure
    .input(z.object({ ...OCCURRENCE, templateStepId: ID, note: NOTE }).strict())
    .mutation(({ ctx, input }) =>
      guarded(async () => {
        const { site, occurrence, actor } = await occurrenceContext(
          ctx,
          input.pharmacyBranchId,
          input.occurrenceId
        );
        const result = await completeStep(ctx.db, {
          occurrenceId: occurrence.id,
          templateStepId: input.templateStepId,
          note: input.note,
          actorStaffProfileId: actor.staffProfileId,
        });
        audit(ctx, site, {
          action: 'pharmacy.sop.completeStep',
          targetType: 'RestaurantSopOccurrenceStep',
          targetId: result.occurrenceStepId,
          metadata: { occurrenceId: occurrence.id },
        });
        return result;
      })
    ),

  linkRecord: completeProcedure
    .input(
      z
        .object({
          ...OCCURRENCE,
          occurrenceStepId: ID.nullable().optional(),
          recordType: RECORD_TYPE,
          recordId: ID,
          note: NOTE,
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      guarded(async () => {
        const { site, occurrence, actor } = await occurrenceContext(
          ctx,
          input.pharmacyBranchId,
          input.occurrenceId
        );
        assertOwnWork(occurrence, actor);
        if (occurrence.status !== 'IN_PROGRESS') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Start the occurrence before linking records to it.',
          });
        }
        const result = await linkPharmacySopRecord(ctx.db, {
          site,
          occurrenceId: occurrence.id,
          occurrenceStepId: input.occurrenceStepId ?? null,
          recordType: input.recordType,
          recordId: input.recordId,
          note: input.note ?? null,
          actor,
        });
        if (result.created) {
          audit(ctx, site, {
            action: 'pharmacy.sop.linkRecord',
            targetType: 'PharmacySopRecordLink',
            targetId: result.linkId,
            metadata: {
              occurrenceId: occurrence.id,
              recordType: input.recordType,
              recordId: input.recordId,
              outOfRange: result.outOfRange ?? false,
            },
          });
        }
        return result;
      })
    ),

  /**
   * Authorize one proof upload before any byte is stored. Used by the
   * multipart evidence route through a server-side caller, so the upload goes
   * through the same session, module and capability gates as every procedure
   * here; the uploader is always the session actor.
   */
  evidenceTarget: completeProcedure
    .input(z.object({ ...OCCURRENCE, occurrenceStepId: ID.nullable().optional() }).strict())
    .query(({ ctx, input }) =>
      guarded(async () => {
        const { site, occurrence, actor } = await occurrenceContext(
          ctx,
          input.pharmacyBranchId,
          input.occurrenceId
        );
        assertOwnWork(occurrence, actor);
        if (occurrence.status !== 'IN_PROGRESS') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Start the occurrence before adding proof to it.',
          });
        }
        await assertStepOnOccurrence(ctx, occurrence.id, input.occurrenceStepId);
        return {
          pharmacyBranchId: site.pharmacyBranchId,
          occurrenceId: occurrence.id,
          occurrenceStepId: input.occurrenceStepId ?? null,
          uploaderStaffProfileId: actor.staffProfileId,
        };
      })
    ),

  linkableRecords: completeProcedure
    .input(z.object({ ...OCCURRENCE, recordType: RECORD_TYPE }).strict())
    .query(({ ctx, input }) =>
      guarded(async () => {
        const { site, occurrence, actor } = await occurrenceContext(
          ctx,
          input.pharmacyBranchId,
          input.occurrenceId
        );
        await assertOccurrenceVisible(
          ctx,
          site,
          actor,
          occurrence,
          await packForVersion(ctx, occurrence.templateVersionId)
        );
        const window = await ctx.db.restaurantSopOccurrence.findUnique({
          where: { id: occurrence.id },
          select: { dueAt: true, windowEndsAt: true },
        });
        if (!window) throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
        const branchId = site.pharmacyBranchId;
        const take = 50;
        switch (input.recordType) {
          case 'TEMPERATURE_LOG': {
            const rows = await ctx.db.pharmacyTemperatureLog.findMany({
              where: {
                branchId,
                recordedAt: {
                  gte: new Date(window.dueAt.getTime() - DAY_MS),
                  lte: window.windowEndsAt,
                },
              },
              orderBy: [{ recordedAt: 'desc' }, { id: 'asc' }],
              take,
              select: {
                id: true,
                recordedAt: true,
                temperatureC: true,
                outOfRange: true,
                location: { select: { name: true } },
              },
            });
            return rows.map((row) => ({
              id: row.id,
              recordType: input.recordType,
              label: `${row.location.name}: ${row.temperatureC.toFixed(1)} °C`,
              occurredAt: row.recordedAt,
              outOfRange: row.outOfRange,
            }));
          }
          case 'CONTROLLED_REGISTER_ENTRY': {
            const rows = await ctx.db.pharmacyControlledRegisterEntry.findMany({
              where: { branchId },
              orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
              take,
              select: {
                id: true,
                serial: true,
                entryKind: true,
                batchNumber: true,
                runningBalance: true,
                createdAt: true,
              },
            });
            return rows.map((row) => ({
              id: row.id,
              recordType: input.recordType,
              label: `#${row.serial} ${row.entryKind} · batch ${row.batchNumber} · balance ${row.runningBalance}`,
              occurredAt: row.createdAt,
              outOfRange: null,
            }));
          }
          case 'GOODS_RECEIPT': {
            const rows = await ctx.db.pharmacyGoodsReceipt.findMany({
              where: { branchId },
              orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
              take,
              select: { id: true, reference: true, status: true, receivedAt: true },
            });
            return rows.map((row) => ({
              id: row.id,
              recordType: input.recordType,
              label: `${row.reference} (${row.status})`,
              occurredAt: row.receivedAt,
              outOfRange: null,
            }));
          }
          case 'MANUFACTURING_BATCH': {
            const rows = await ctx.db.pharmacyManufacturingBatch.findMany({
              where: { lots: { some: { branchId } } },
              orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
              take,
              select: { id: true, batchNumber: true, expiresAt: true, state: true },
            });
            return rows.map((row) => ({
              id: row.id,
              recordType: input.recordType,
              label: `Batch ${row.batchNumber} (${row.state})`,
              occurredAt: row.expiresAt,
              outOfRange: null,
            }));
          }
          case 'RECALL_NOTICE': {
            const rows = await ctx.db.pharmacyRecallNotice.findMany({
              where: { status: 'OPEN' },
              orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
              take,
              select: { id: true, reference: true, reason: true, createdAt: true },
            });
            return rows.map((row) => ({
              id: row.id,
              recordType: input.recordType,
              label: `${row.reference}: ${row.reason}`,
              occurredAt: row.createdAt,
              outOfRange: null,
            }));
          }
        }
      })
    ),

  submit: completeProcedure.input(z.object(OCCURRENCE).strict()).mutation(({ ctx, input }) =>
    guarded(async () => {
      const { site, occurrence, actor } = await occurrenceContext(
        ctx,
        input.pharmacyBranchId,
        input.occurrenceId
      );
      assertOwnWork(occurrence, actor);
      if (occurrence.status !== 'IN_PROGRESS') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Cannot submit an occurrence in status ${occurrence.status}.`,
        });
      }
      await assertPharmacySubmissionRequirements(ctx, site, occurrence.id);
      const result = await submitOccurrence(ctx.db, {
        occurrenceId: occurrence.id,
        actorStaffProfileId: actor.staffProfileId,
      });
      audit(ctx, site, {
        action: 'pharmacy.sop.submit',
        targetType: 'RestaurantSopOccurrence',
        targetId: occurrence.id,
        description: `Submitted pharmacy SOP occurrence (status: ${result.status})`,
      });
      return result;
    })
  ),

  // ── Review (sop:verify) ───────────────────────────────────────────────────

  verify: verifyProcedure
    .input(z.object({ ...OCCURRENCE, reason: NOTE }).strict())
    .mutation(({ ctx, input }) =>
      guarded(async () => {
        const { site, occurrence, actor } = await occurrenceContext(
          ctx,
          input.pharmacyBranchId,
          input.occurrenceId
        );
        await assertIndependentPharmacyVerifier(ctx.db, {
          occurrenceId: occurrence.id,
          site,
          verifierStaffProfileId: actor.staffProfileId,
        });
        const result = await verifyOccurrence(ctx.db, {
          occurrenceId: occurrence.id,
          actorStaffProfileId: actor.staffProfileId,
          reason: input.reason?.trim() || null,
        });
        audit(ctx, site, {
          action: 'pharmacy.sop.verify',
          targetType: 'RestaurantSopOccurrence',
          targetId: occurrence.id,
          description: 'Verified pharmacy SOP occurrence',
        });
        return result;
      })
    ),

  reject: verifyProcedure
    .input(z.object({ ...OCCURRENCE, reason: z.string().trim().min(1).max(2_000) }).strict())
    .mutation(({ ctx, input }) =>
      guarded(async () => {
        const { site, occurrence, actor } = await occurrenceContext(
          ctx,
          input.pharmacyBranchId,
          input.occurrenceId
        );
        await assertIndependentPharmacyVerifier(ctx.db, {
          occurrenceId: occurrence.id,
          site,
          verifierStaffProfileId: actor.staffProfileId,
        });
        const result = await rejectOccurrence(ctx.db, {
          occurrenceId: occurrence.id,
          actorStaffProfileId: actor.staffProfileId,
          reason: input.reason,
        });
        audit(ctx, site, {
          action: 'pharmacy.sop.reject',
          targetType: 'RestaurantSopOccurrence',
          targetId: occurrence.id,
          description: 'Rejected pharmacy SOP occurrence for rework',
        });
        return result;
      })
    ),

  // ── Reporting (sop:complete or sop:verify) ────────────────────────────────

  report: auditedProtectedProcedure
    .input(
      z
        .object({ ...BRANCH, from: DATE_ISO, to: DATE_ISO })
        .strict()
        .refine((value) => value.from <= value.to, {
          message: 'From date must be on or before to date.',
          path: ['from'],
        })
    )
    .query(async ({ ctx, input }) => {
      await requireAnyCapability(ctx, ['sop:complete', 'sop:verify']);
      return guarded(async () => {
        const site = await siteFor(ctx, input.pharmacyBranchId);
        const fromBusinessDate = businessDateToUtcDate(input.from);
        const toBusinessDate = businessDateToUtcDate(input.to);
        if ((toBusinessDate.getTime() - fromBusinessDate.getTime()) / DAY_MS >= MAX_REPORT_DAYS) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Report ranges are limited to ${MAX_REPORT_DAYS} days.`,
          });
        }
        const [score, rows] = await Promise.all([
          buildScoreReport(ctx.db, {
            fromBusinessDate,
            toBusinessDate,
            branchId: site.sopBranchId,
          }),
          ctx.db.restaurantSopOccurrence.findMany({
            where: {
              branchId: site.sopBranchId,
              businessDate: { gte: fromBusinessDate, lte: toBusinessDate },
            },
            orderBy: [{ businessDate: 'asc' }, { dueAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              status: true,
              dueAt: true,
              windowEndsAt: true,
              submittedAt: true,
              resolvedAt: true,
              assignedStaff: {
                select: { id: true, displayName: true, user: { select: { department: true } } },
              },
              claimedBy: {
                select: { id: true, displayName: true, user: { select: { department: true } } },
              },
              steps: {
                select: {
                  completed: true,
                  completedBy: {
                    select: {
                      id: true,
                      displayName: true,
                      user: { select: { department: true } },
                    },
                  },
                },
              },
              evidence: { select: { id: true } },
              verifications: { select: { action: true } },
              escalationEvents: { select: { kind: true } },
            },
          }),
        ]);
        audit(ctx, site, {
          operation: 'READ',
          action: 'pharmacy.sop.report',
          targetType: 'PharmacySopSite',
          targetId: site.pharmacyBranchId,
          metadata: { from: input.from, to: input.to },
        });
        return { score, summary: summarizeSopReport(rows) };
      });
    }),
});
