import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { Prisma, type PharmacySopRecordType } from '@/generated/prisma/client';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import {
  PHARMACY_SOP_ROLE_KEYS,
  PHARMACY_SOP_VERIFIER_ROLE_KEYS,
  PharmacySopAccessError,
  pharmacySopRecordTimeBounds,
  assertIndependentPharmacyVerifier,
  assertOccurrenceAtSite,
  enablePharmacySopSite,
  ensurePharmacySopJobRoles,
  ensurePharmacySopStaffProfile,
  linkPharmacySopRecord,
  describePharmacySopRecords,
  listPharmacySopBranches,
  listPharmacySopLinkableRecords,
  pharmacySopRecordDetailKey,
  pharmacySopRolesAt,
  unavailablePharmacySopRecordDetail,
  PHARMACY_SOP_ROLES,
  resolvePharmacySopActor,
  resolvePharmacySopSite,
  setPharmacySopRoleHolding,
  type PharmacySopActor,
  type PharmacySopRoleKey,
  type PharmacySopSiteRef,
  type PharmacySopTemperatureZone,
} from '@/lib/pharmacy/sop-adapter';
import {
  isPharmacySopProof,
  resolvePharmacySopProvenance,
  type PharmacySopProvenance,
} from '@/lib/pharmacy/sop-evidence';
import {
  PHARMACY_SOP_NO_STAFF_PROFILE_MESSAGE,
  PHARMACY_SOP_SCHEDULE_LIMITS,
} from '@/lib/pharmacy/sop-shared';
import {
  PHARMACY_SOP_PACKS,
  PharmacySopLibraryScopeError,
  installPharmacySopLibrary,
  pharmacySopPackForTemplateName,
  type PharmacySopPack,
  type PharmacySopPackStep,
} from '@/lib/pharmacy/sop-library';
import {
  PHARMACY_SOP_SETTING_REASON_MAX_LENGTH,
  pharmacySopAutoSchedule,
  setPharmacySopAutoSchedule,
} from '@/lib/pharmacy/sop-settings';
import { startPharmacySopAutoSchedule } from '@/lib/pharmacy/sop-auto-schedule-job';
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
      // Fixed wording the workspace recognises, to offer `joinSite`.
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: PHARMACY_SOP_NO_STAFF_PROFILE_MESSAGE,
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

/** What the caller was doing when the engine refused: picks the plain wording. */
export type SopCommand =
  'start' | 'completeStep' | 'submit' | 'verify' | 'reject' | 'schedule' | 'other';

/** Fixed wording for state refusals: the engine's own text names internal states. */
export const SOP_STATE_MESSAGES = {
  changed: 'This procedure has changed since you opened it. Refresh to see its current state.',
  alreadyChecked: 'This procedure has already been checked.',
  notInReview: 'This procedure has not been sent for review yet.',
  ownWork: 'Only the person this procedure is assigned to, or who claimed it, can work on it.',
  claimFirst: 'Claim this procedure before working on it.',
  stepDone: 'This step is already done.',
  scheduleReplaced: 'This schedule was replaced by a newer one, so it can’t be resumed.',
  templateChanged:
    'This procedure template has changed since you opened it. Refresh to see its current state.',
  invalid: 'That could not be saved. Refresh and try again.',
} as const;

/**
 * The engine's proof refusals, by the exact engine text, mapped to pharmacy
 * wording. This is a lookup, never a pass-through: an unknown text gets the
 * fixed fallback for the command.
 */
const PROOF_MESSAGES: Readonly<Record<string, string>> = {
  'Photo proof is required before completing this step.':
    'Add the photo this step needs before marking it done.',
  'Signature proof is required before completing this step.':
    'Add the signature this step needs before marking it done.',
  'A completion note is required before completing this step.':
    'Add the note this step needs before marking it done.',
  'Complete every checklist step before submitting for review.':
    'Finish every step before sending it for review.',
  'Every required note and proof item must be present before submitting for review.':
    'Add every note and proof the steps need before sending it for review.',
};

function proofMessage(engineMessage: string, command: SopCommand): string {
  return (
    PROOF_MESSAGES[engineMessage] ??
    (command === 'submit'
      ? 'Add every note and proof the steps need before sending it for review.'
      : 'Add the proof or note this step needs before marking it done.')
  );
}

/** Schedule refusals, by the exact engine text; anything else gets the fixed fallback. */
const RECURRENCE_MESSAGES: Readonly<Record<string, string>> = {
  'INTERVAL end time must be later than its start time.':
    'Choose a last check time later than the first check time.',
  'INTERVAL interval must be at least 15 minutes.': 'Minimum is 15 minutes.',
  'INTERVAL requires at least one selected weekday.': 'Select at least one weekday.',
  'endDate must not precede startDate.': 'The end date must be on or after the start date.',
};

/**
 * Engine refusals, mapped the way the restaurant SOP routers map them, but
 * never forwarding engine text: the engine's messages name internal states
 * ("Cannot reject an occurrence in status VERIFIED. Expected SUBMITTED or
 * LATE.") or embed internal ids ("Branch <id> was not found."), which a
 * pharmacy caller must not see. Each refusal gets fixed, plain wording chosen
 * by its reason and the command that hit it.
 */
export function mapSopError(err: unknown, command: SopCommand = 'other'): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof PharmacySopAccessError) mapAccessError(err);
  if (err instanceof SopExecutionError) {
    switch (err.reason) {
      case 'NOT_FOUND':
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
      case 'STEP_NOT_FOUND':
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Step not found on this occurrence.' });
      case 'NOT_OWNER':
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: /^Claim\b/.test(err.message)
            ? SOP_STATE_MESSAGES.claimFirst
            : SOP_STATE_MESSAGES.ownWork,
        });
      case 'INVALID_STATE':
        throw new TRPCError({ code: 'CONFLICT', message: SOP_STATE_MESSAGES.changed });
      case 'STEP_ALREADY_COMPLETED':
        throw new TRPCError({ code: 'CONFLICT', message: SOP_STATE_MESSAGES.stepDone });
      case 'PROOF_REQUIRED':
        throw new TRPCError({ code: 'BAD_REQUEST', message: proofMessage(err.message, command) });
      default:
        throw new TRPCError({ code: 'BAD_REQUEST', message: SOP_STATE_MESSAGES.invalid });
    }
  }
  if (err instanceof SopVerificationError) {
    switch (err.reason) {
      case 'NOT_FOUND':
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
      case 'INVALID_STATE':
        // Only a review decision moves a procedure out of review, so a review
        // that finds it gone means someone already checked it.
        throw new TRPCError({ code: 'CONFLICT', message: SOP_STATE_MESSAGES.alreadyChecked });
      case 'CO_AUTH_REQUIRED':
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'A second person must approve this before it can go ahead.',
        });
      default:
        throw new TRPCError({ code: 'BAD_REQUEST', message: SOP_STATE_MESSAGES.invalid });
    }
  }
  if (err instanceof SopTemplateError) {
    switch (err.reason) {
      case 'NOT_FOUND':
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'That SOP template, assignment or branch was not found.',
        });
      case 'TEMPLATE_LIMIT_REACHED':
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This workspace has reached its procedure template limit.',
        });
      case 'INVALID_STATE':
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            command === 'schedule'
              ? SOP_STATE_MESSAGES.scheduleReplaced
              : SOP_STATE_MESSAGES.templateChanged,
        });
      case 'DRAFT_EXISTS':
      case 'VERSION_NOT_DRAFT':
        throw new TRPCError({ code: 'CONFLICT', message: SOP_STATE_MESSAGES.templateChanged });
      case 'NO_STEPS':
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'This procedure has no steps yet.' });
      default:
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Check the procedure details and try again.',
        });
    }
  }
  if (err instanceof PharmacySopLibraryScopeError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: err.message });
  }
  if (err instanceof RecurrenceError) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        RECURRENCE_MESSAGES[err.message] ?? 'Check the schedule’s days and times and try again.',
    });
  }
  if (err instanceof AssigneeTargetError) {
    throw new TRPCError(
      err.reason === 'ROLE_INACTIVE'
        ? { code: 'CONFLICT', message: 'That role is no longer active at this branch.' }
        : err.reason === 'ROLE_NOT_FOUND' || err.reason === 'STAFF_NOT_FOUND'
          ? { code: 'BAD_REQUEST', message: 'That assignee was not found at this branch.' }
          : { code: 'BAD_REQUEST', message: 'Choose who this procedure is assigned to.' }
    );
  }
  throw err;
}

/** Run a resolver body and translate every known SOP refusal. */
async function guarded<T>(work: () => Promise<T>, command: SopCommand = 'other'): Promise<T> {
  try {
    return await work();
  } catch (err) {
    mapSopError(err, command);
  }
}

/** `guarded` for one command, so its refusals get that command's wording. */
const guardedAs =
  (command: SopCommand) =>
  <T>(work: () => Promise<T>): Promise<T> =>
    guarded(work, command);

/** One transaction for `work`; a request-level transaction is reused (scoped-db). */
function runInTransaction<T>(db: TRPCContext['db'], work: (tx: TRPCContext['db']) => Promise<T>) {
  const transaction = db.$transaction.bind(db) as unknown as (
    fn: (tx: TRPCContext['db']) => Promise<T>
  ) => Promise<T>;
  return transaction(work);
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
    throw new TRPCError({ code: 'FORBIDDEN', message: SOP_STATE_MESSAGES.ownWork });
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

// ── Proof provenance ──────────────────────────────────────────────────────────

/** The evidence columns provenance needs: the receipt key and the legacy MAC fields. */
const EVIDENCE_PROVENANCE_SELECT = {
  id: true,
  occurrenceStepId: true,
  contentHash: true,
  mimeType: true,
  uploaderStaffProfileId: true,
  storageRef: true,
} as const;

type EvidenceProvenanceRow = {
  id?: string | null;
  occurrenceStepId: string | null;
  contentHash: string;
  mimeType: string;
  uploaderStaffProfileId: string | null;
  storageRef: string | null;
};

/**
 * Where each evidence row on one occurrence came from, in input order: a
 * server-issued capture receipt (RECEIPT), a legacy name that verifies under
 * the current secret (LEGACY_HMAC), a pharmacy-style name that no longer
 * verifies (UNCONFIRMED — proof exists, capture unconfirmed), or anything else
 * (FOREIGN, e.g. attached through a restaurant SOP surface, which accepts a
 * caller-supplied uploader or storage ref). See `src/lib/pharmacy/sop-evidence.ts`.
 */
function provenanceOf(
  ctx: TRPCContext,
  occurrenceId: string,
  rows: readonly EvidenceProvenanceRow[]
): Promise<PharmacySopProvenance[]> {
  return resolvePharmacySopProvenance(
    ctx.db,
    sessionScope(ctx).organizationId,
    rows.map((row) => ({
      id: row.id ?? null,
      occurrenceId,
      occurrenceStepId: row.occurrenceStepId,
      contentHash: row.contentHash,
      mimeType: row.mimeType,
      uploaderStaffProfileId: row.uploaderStaffProfileId,
      storageRef: row.storageRef,
    }))
  );
}

// The engine's own proof classification (sop-execution.ts submitOccurrence).
function isPhotoProof(mimeType: string): boolean {
  return (
    mimeType.includes('evidence=photo') ||
    (mimeType.startsWith('image/') && !mimeType.includes('evidence=signature'))
  );
}

function isSignatureProof(mimeType: string): boolean {
  return (
    mimeType.includes('evidence=signature') ||
    mimeType === 'application/vnd.devfathom.signature+json'
  );
}

const FOREIGN_PROOF_MESSAGE =
  'Proof on this procedure was not captured through the pharmacy workspace. Ask a manager to review it.';

/** Proof that exists but whose pharmacy capture cannot be confirmed (never "missing"). */
const UNCONFIRMED_PROOF_MESSAGE =
  'Proof is attached to this procedure, but its pharmacy capture can’t be confirmed. Ask a manager to run the legacy receipt backfill, or send it back so it can be captured again.';

/** The record types a pack's steps link (a pack's link vocabulary). */
function packRecordTypes(pack: PharmacySopPack | undefined): Set<PharmacySopRecordType> {
  return new Set(
    (pack?.steps ?? []).flatMap((step) =>
      step.requiredRecordType ? [step.requiredRecordType] : []
    )
  );
}

function recordTypeLabel(recordType: PharmacySopRecordType): string {
  return recordType.toLowerCase().replaceAll('_', ' ');
}

/**
 * A record link must be one the procedure asks for: the type must be in the
 * pack's link vocabulary and, when the link targets a step, must be exactly the
 * type that step requires. A step that names no record type takes no link (no
 * pack step reads one — the temperature excursion step is documented by its
 * note). An occurrence-level link (no step) of a pack type stays allowed.
 */
async function assertLinkableRecordType(
  ctx: TRPCContext,
  pack: PharmacySopPack | undefined,
  occurrenceId: string,
  occurrenceStepId: string | null,
  recordType: PharmacySopRecordType
): Promise<PharmacySopPackStep | undefined> {
  if (!packRecordTypes(pack).has(recordType)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `This procedure does not link a ${recordTypeLabel(recordType)}.`,
    });
  }
  if (!occurrenceStepId) return undefined;
  const step = await ctx.db.restaurantSopOccurrenceStep.findFirst({
    where: { id: occurrenceStepId, occurrenceId },
    select: { templateStep: { select: { title: true, stepOrder: true } } },
  });
  if (!step) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Step not found on this occurrence.' });
  }
  const packStep = packStepFor(pack, step.templateStep);
  const required = requiredRecordTypeOf(packStep);
  if (required !== recordType) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: required
        ? `This step links a ${recordTypeLabel(required)}, not a ${recordTypeLabel(recordType)}.`
        : 'This step does not take a linked record.',
    });
  }
  return packStep;
}

/** The storage zone a temperature step reads, or null (any location / not a temperature step). */
function temperatureZoneOf(
  step: PharmacySopPackStep | undefined
): PharmacySopTemperatureZone | null {
  return step?.requiredRecordType === 'TEMPERATURE_LOG' ? (step.temperatureZone ?? null) : null;
}

/** Site + occurrence + session actor: the preamble of every occurrence command. */
async function occurrenceContext(ctx: TRPCContext, pharmacyBranchId: string, occurrenceId: string) {
  const site = await siteFor(ctx, pharmacyBranchId);
  const occurrence = await assertOccurrenceAtSite(ctx.db, { occurrenceId, site });
  const actor = await actorFor(ctx);
  return { site, occurrence, actor };
}

/**
 * A review decision needs the procedure in review. Checked before the engine
 * call so the refusal is plain: already checked (verified, waived or sent
 * back) or not sent for review yet. A concurrent decision that slips past this
 * still gets the engine's INVALID_STATE, mapped to "already been checked".
 */
function assertInReview(occurrence: { status: string }): void {
  if ((REVIEW_STATUSES as readonly string[]).includes(occurrence.status)) return;
  throw new TRPCError({
    code: 'CONFLICT',
    message:
      TERMINAL_STATUSES.has(occurrence.status) || occurrence.status === 'REJECTED'
        ? SOP_STATE_MESSAGES.alreadyChecked
        : SOP_STATE_MESSAGES.notInReview,
  });
}

// ── Rework after a send-back ──────────────────────────────────────────────────

export const REWORK_NOTE_REQUIRED_MESSAGE =
  'Say what you changed after it was sent back before sending it for review again.';
const REWORK_NOTE_MAX_LENGTH = 2_000;

/** Newest first; `id` breaks a same-instant tie (the migration trigger uses the same order). */
const LATEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

type VerificationRow = { id: string; action: string; createdAt: Date };

/** The latest verification row of a list (any action), by createdAt then id. */
function latestOf<T extends VerificationRow>(rows: readonly T[]): T | null {
  let latest: T | null = null;
  for (const row of rows) {
    if (
      !latest ||
      row.createdAt.getTime() > latest.createdAt.getTime() ||
      (row.createdAt.getTime() === latest.createdAt.getTime() && row.id > latest.id)
    ) {
      latest = row;
    }
  }
  return latest;
}

/** The latest REJECT of a list, or null when the procedure was never sent back. */
function latestRejectionOf<T extends VerificationRow>(rows: readonly T[]): T | null {
  return latestOf(rows.filter((row) => row.action === 'REJECT'));
}

/**
 * After a send-back the engine keeps every step completed, so resubmitting
 * unchanged would be a no-op rework. When the occurrence has any REJECT, at
 * least one rework note must answer the latest one. Proof and record links
 * added after the send-back go through the normal routes and stay required
 * exactly as before.
 */
async function assertReworkNoted(
  ctx: TRPCContext,
  site: PharmacySopSiteRef,
  occurrenceId: string
): Promise<void> {
  const rejection = await ctx.db.restaurantSopVerification.findFirst({
    where: { occurrenceId, action: 'REJECT' },
    orderBy: LATEST_FIRST,
    select: { id: true },
  });
  if (!rejection) return;
  const note = await ctx.db.pharmacySopReworkNote.findFirst({
    where: {
      occurrenceId,
      pharmacyBranchId: site.pharmacyBranchId,
      rejectionVerificationId: rejection.id,
    },
    select: { id: true },
  });
  if (!note) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: REWORK_NOTE_REQUIRED_MESSAGE });
  }
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
          templateStep: {
            select: { title: true, stepOrder: true, requiresPhoto: true, requiresSignature: true },
          },
          evidence: { select: EVIDENCE_PROVENANCE_SELECT },
        },
      },
    },
  });
  if (!occ) throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
  const pack = pharmacySopPackForTemplateName(occ.assignment.template.name);

  // The engine accepts any evidence row as photo/signature proof. Count only
  // proof captured in the pharmacy workspace, so a row attached through a
  // restaurant surface can never satisfy a pharmacy step's requirement.
  // Receipt-backed proof always counts; legacy proof counts while its name
  // still verifies. Proof that exists but cannot be confirmed is reported as
  // such, never as missing.
  const stepEvidence = occ.steps.map((step) => step.evidence ?? []);
  const provenance = await provenanceOf(ctx, occurrenceId, stepEvidence.flat());
  let offset = 0;
  for (const [index, step] of occ.steps.entries()) {
    const rows = stepEvidence[index]!.map((row, at) => ({
      row,
      provenance: provenance[offset + at]!,
    }));
    offset += rows.length;
    const proof = rows.filter((entry) => isPharmacySopProof(entry.provenance));
    const isKind = (kind: 'photo' | 'signature', mimeType: string) =>
      kind === 'photo' ? isPhotoProof(mimeType) : isSignatureProof(mimeType);
    const missing =
      step.templateStep.requiresPhoto && !proof.some((entry) => isKind('photo', entry.row.mimeType))
        ? 'photo'
        : step.templateStep.requiresSignature &&
            !proof.some((entry) => isKind('signature', entry.row.mimeType))
          ? 'signature'
          : null;
    if (missing) {
      const unconfirmed = rows.some(
        (entry) => entry.provenance === 'UNCONFIRMED' && isKind(missing, entry.row.mimeType)
      );
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: unconfirmed
          ? `The ${missing} proof for “${step.templateStep.title}” is attached, but its pharmacy capture can’t be confirmed. Ask a manager to run the legacy receipt backfill, or capture it again in the pharmacy workspace.`
          : `Capture the ${missing} proof for “${step.templateStep.title}” in the pharmacy workspace before submitting.`,
      });
    }
  }

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
        message: `Link the ${recordTypeLabel(required)} for “${step.templateStep.title}” before submitting.`,
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

const SCHEDULE_TIME_MESSAGES = {
  dueTime: 'Choose the time this procedure is due.',
  intervalStart: 'Choose the time the first check is due.',
  intervalEnd: 'Choose the time the last check is due.',
} as const;

/** The schema refuses a missing time; this narrows it without ever defaulting one. */
function requiredScheduleTime(value: number | null | undefined, message: string): number {
  if (value == null) throw new TRPCError({ code: 'BAD_REQUEST', message });
  return value;
}

const CreateAssignmentInput = z
  .object({
    ...BRANCH,
    templateId: ID,
    target: ASSIGNMENT_TARGET,
    frequency: z.enum(['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'INTERVAL']),
    interval: z.number().int().min(1).max(1440).default(1),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    monthDay: z.number().int().min(1).max(31).nullable().default(null),
    // No time-of-day default: the manager chooses when each procedure is due.
    // Missing values are refused below with a plain message (never defaulted).
    dueTimeMinutes: MINUTES_OF_DAY.nullable().optional(),
    intervalEndTimeMinutes: MINUTES_OF_DAY.nullable().optional(),
    windowMinutes: z
      .number()
      .int()
      .min(0)
      .max(PHARMACY_SOP_SCHEDULE_LIMITS.windowMinutes)
      .default(PHARMACY_SOP_SCHEDULE_LIMITS.windowMinutes),
    graceMinutes: z.number().int().min(0).max(PHARMACY_SOP_SCHEDULE_LIMITS.graceMinutes).default(0),
    startDate: DATE_ISO,
    endDate: DATE_ISO.nullable().default(null),
  })
  .strict()
  .superRefine((value, refinement) => {
    if (value.dueTimeMinutes == null) {
      refinement.addIssue({
        code: 'custom',
        path: ['dueTimeMinutes'],
        message:
          value.frequency === 'INTERVAL'
            ? SCHEDULE_TIME_MESSAGES.intervalStart
            : SCHEDULE_TIME_MESSAGES.dueTime,
      });
    }
    if (value.frequency !== 'INTERVAL') return;
    if (value.intervalEndTimeMinutes == null) {
      refinement.addIssue({
        code: 'custom',
        path: ['intervalEndTimeMinutes'],
        message: SCHEDULE_TIME_MESSAGES.intervalEnd,
      });
    }
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

/**
 * Occurrences this staff profile neither is assigned nor claimed. Null-safe on
 * purpose: SQL `<>` (Prisma `not` / `NOT`) is never true for a NULL column, so
 * `NOT: [{ assignedStaffProfileId: me }, { claimedByStaffProfileId: me }]`
 * would drop every pool row (no assignee) and every direct row (no claimer) —
 * an always-empty review queue. Each nullable column is therefore matched as
 * "NULL or someone else".
 */
export function notOwnedOrClaimedBy(staffProfileId: string) {
  return {
    AND: [
      {
        OR: [{ assignedStaffProfileId: null }, { assignedStaffProfileId: { not: staffProfileId } }],
      },
      {
        OR: [
          { claimedByStaffProfileId: null },
          { claimedByStaffProfileId: { not: staffProfileId } },
        ],
      },
    ],
  } satisfies Prisma.RestaurantSopOccurrenceWhereInput;
}

/**
 * An `assignments` row that `startOnDemand` created to run one event procedure
 * now, not a schedule a manager set up. `createAssignment` refuses EVENT packs,
 * so every assignment of an EVENT pack is one of these; the ONCE + PERSON shape
 * is checked too so the rule never hides a real schedule if that ever changes.
 */
function isOnDemandRun(row: {
  frequency: string;
  assigneeTargetType: string;
  template: { name: string };
}): boolean {
  return (
    pharmacySopPackForTemplateName(row.template.name)?.pharmacy.trigger === 'EVENT' &&
    row.frequency === 'ONCE' &&
    row.assigneeTargetType === 'PERSON'
  );
}

// ── Router ────────────────────────────────────────────────────────────────────

export const pharmacySopRouter = router({
  access: protectedProcedure.query(async ({ ctx }) => {
    const [canManage, canComplete, canVerify] = await Promise.all([
      allowed(ctx, 'sop:manage'),
      allowed(ctx, 'sop:complete'),
      allowed(ctx, 'sop:verify'),
    ]);
    // Setup prefills the branch timezone from the organization's own zone. The
    // column defaults to UTC, so UTC reads as "not chosen" and the workspace
    // falls back to the browser's zone.
    const organizationTimezone = canManage
      ? await ctx.db.organization
          .findUnique({
            where: { id: sessionScope(ctx).organizationId },
            select: { timezone: true },
          })
          .then((row) => (row?.timezone && row.timezone !== 'UTC' ? row.timezone : null))
      : null;
    return { canManage, canComplete, canVerify, organizationTimezone };
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
        // The manager who turns procedures on can take part straight away
        // (grant roles, review). Best effort: an ambiguous or suspended
        // profile does not undo the enable; the workspace then offers joinSite
        // and shows its refusal.
        const staffProfileReady = await ensurePharmacySopStaffProfile(ctx.db, {
          ...sessionScope(ctx),
          pharmacyBranchId: result.site.pharmacyBranchId,
        }).then(
          () => true,
          (err: unknown) => {
            if (
              err instanceof PharmacySopAccessError &&
              (err.reason === 'NO_STAFF_PROFILE' || err.reason === 'AMBIGUOUS_STAFF_PROFILE')
            ) {
              return false;
            }
            throw err;
          }
        );
        audit(ctx, result.site, {
          action: 'pharmacy.sop.enableSite',
          targetType: 'PharmacySopSite',
          targetId: result.site.pharmacyBranchId,
          description: result.created
            ? 'Enabled SOPs at pharmacy branch'
            : 'SOPs already enabled at pharmacy branch',
          metadata: {
            created: result.created,
            timezone: result.site.timezone,
            staffProfileReady,
          },
        });
        return { ...result, staffProfileReady };
      })
    ),

  installLibrary: manageProcedure.mutation(({ ctx }) =>
    guarded(async () => {
      const results = await installPharmacySopLibrary(ctx.db, {
        organizationId: sessionScope(ctx).organizationId,
      });
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
              temperatureZone: temperatureZoneOf(packStepFor(pack, step)),
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
      // On-demand runs are internal plumbing (created paused by startOnDemand);
      // listing them here would show each event procedure as a paused schedule.
      const pharmacyRows = rows.filter(
        (row) => pharmacySopPackForTemplateName(row.template.name) && !isOnDemandRun(row)
      );
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
    guardedAs('schedule')(async () => {
      const site = await siteFor(ctx, input.pharmacyBranchId);
      const { template, pack } = await pharmacyTemplate(ctx, input.templateId);
      if (pack.pharmacy.trigger === 'EVENT') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This procedure is started when it happens, so it does not take a schedule.',
        });
      }
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
        // A role-owned pack named to one person still needs that person to
        // hold the pack's role here. A pack that is person-assigned by design
        // (training attestation: anyone may be asked to attest) has no such rule.
        if (pack.pharmacy.assigneeTarget !== 'PERSON') {
          const heldRoles = await pharmacySopRolesAt(ctx.db, {
            staffProfileId: person.staffProfileId,
            sopBranchId: site.sopBranchId,
          });
          if (!heldRoles.includes(pack.pharmacy.roleKey)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message:
                'That person does not hold the pharmacy SOP role this procedure needs at this branch.',
            });
          }
        }
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
        dueTimeMinutes: requiredScheduleTime(
          input.dueTimeMinutes,
          input.frequency === 'INTERVAL'
            ? SCHEDULE_TIME_MESSAGES.intervalStart
            : SCHEDULE_TIME_MESSAGES.dueTime
        ),
        // Only a repeating-check schedule has an end time; nothing is assumed.
        intervalEndTimeMinutes:
          input.frequency === 'INTERVAL'
            ? requiredScheduleTime(input.intervalEndTimeMinutes, SCHEDULE_TIME_MESSAGES.intervalEnd)
            : null,
        windowMinutes: input.windowMinutes,
        graceMinutes: input.graceMinutes,
      });
      // A schedule is instructions + proof only: no escalation policy, reminder
      // chain or workflow gate is created alongside it.
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
      guardedAs('schedule')(async () => {
        const site = await siteFor(ctx, input.pharmacyBranchId);
        const existing = await ctx.db.restaurantSopAssignment.findUnique({
          where: { id: input.assignmentId },
          select: {
            id: true,
            branchId: true,
            frequency: true,
            assigneeTargetType: true,
            assigneeJobRoleId: true,
            assigneeStaff: { select: { displayName: true } },
            template: { select: { name: true } },
          },
        });
        if (
          !existing ||
          existing.branchId !== site.sopBranchId ||
          !pharmacySopPackForTemplateName(existing.template.name) ||
          isOnDemandRun(existing)
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
        // What the workspace needs for its notice ("Paused “Pharmacy — opening”
        // for Qualified person (pharmacist)"), in plain words.
        const roleKey =
          existing.assigneeTargetType === 'ROLE' && existing.assigneeJobRoleId
            ? ((await pharmacyJobRoleIds(ctx)).byId.get(existing.assigneeJobRoleId) ?? null)
            : null;
        return {
          ...updated,
          templateName: existing.template.name,
          assigneeType: (existing.assigneeTargetType === 'PERSON' ? 'PERSON' : 'ROLE') as
            'PERSON' | 'ROLE',
          assigneeLabel:
            existing.assigneeTargetType === 'PERSON'
              ? (existing.assigneeStaff?.displayName ?? null)
              : roleKey
                ? PHARMACY_SOP_ROLES[roleKey].name
                : null,
          roleKey,
        };
      })
    ),

  roleHoldings: manageProcedure.input(z.object(BRANCH).strict()).query(({ ctx, input }) =>
    guarded(async () => {
      const site = await siteFor(ctx, input.pharmacyBranchId);
      const viewerUserId = sessionScope(ctx).userId;
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
            // The session user's own row: the adapter refuses a self-grant of
            // a verifier role, so the workspace disables those two boxes here.
            isViewer: row.userId === viewerUserId,
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
        // The grantor is always the session user. A manager assigned to this
        // branch who has no staff profile yet gets one here (the same
        // serialized find-or-create used for targets), instead of a dead end;
        // ambiguous, suspended or archived profiles still fail closed.
        const actor = await ensurePharmacySopStaffProfile(ctx.db, {
          ...sessionScope(ctx),
          pharmacyBranchId: site.pharmacyBranchId,
        });
        const result = await setPharmacySopRoleHolding(ctx.db, {
          organizationId: sessionScope(ctx).organizationId,
          site,
          targetUserId: input.userId,
          roleKey: input.roleKey,
          held: input.held,
          grantedByStaffProfileId: actor.staffProfileId,
        }).catch((err: unknown) => {
          // Here the adapter uses these reasons for grant rules ("you cannot
          // grant yourself a verifier role", "the qualified-person role needs
          // pharmacy:dispense"); its own wording names no other branch or
          // record, and the verifier wording in mapAccessError would misread.
          if (
            err instanceof PharmacySopAccessError &&
            (err.reason === 'NOT_INDEPENDENT' || err.reason === 'ROLE_REQUIRED')
          ) {
            throw new TRPCError({ code: 'FORBIDDEN', message: err.message });
          }
          throw err;
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
   * "Set up my procedures profile": idempotently give the session user their
   * own staff profile at this branch, so a person who was assigned to the
   * branch but never given a profile can open their work or review queue.
   * Branch-scoped through the adapter, open to any SOP capability, grants no
   * role and takes no actor or user id from the input.
   */
  joinSite: auditedProtectedProcedure
    .input(z.object(BRANCH).strict())
    .mutation(async ({ ctx, input }) => {
      await requireAnyCapability(ctx, ['sop:complete', 'sop:verify', 'sop:manage']);
      return guarded(async () => {
        const site = await siteFor(ctx, input.pharmacyBranchId);
        const actor = await ensurePharmacySopStaffProfile(ctx.db, {
          ...sessionScope(ctx),
          pharmacyBranchId: site.pharmacyBranchId,
        });
        audit(ctx, site, {
          action: 'pharmacy.sop.joinSite',
          targetType: 'RestaurantStaffProfile',
          targetId: actor.staffProfileId,
          description: actor.created
            ? 'Created own staff profile for pharmacy procedures'
            : 'Staff profile for pharmacy procedures already set up',
          metadata: { created: actor.created },
        });
        return { staffProfileId: actor.staffProfileId, created: actor.created };
      });
    }),

  /**
   * "Create today's work now": materialise due occurrences for THIS branch
   * only (the engine is restricted to the site's engine branch, so no other
   * site, pharmacy or restaurant, is touched). Idempotent through
   * `unique(assignmentId, dueAt)`. An explicit manager action, so it stays
   * available whether automatic scheduling is on or off, and it keeps the
   * engine's default window (yesterday to tomorrow): the manager is choosing
   * to create that work now, unlike the automatic paths, which never back-date
   * (`PHARMACY_SOP_AUTO_LOOKBACK_DAYS`).
   */
  generate: manageProcedure.input(z.object(BRANCH).strict()).mutation(({ ctx, input }) =>
    guarded(async () => {
      const site = await siteFor(ctx, input.pharmacyBranchId);
      // A schedule created today starts at its next due time: nothing due
      // before it existed is created (it would start overdue).
      const result = await generateDueSopOccurrences(ctx.db, {
        branchIds: [site.sopBranchId],
        skipDueBeforeAssignmentCreated: true,
      });
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

  /** The branch's automatic-scheduling setting. OFF unless a manager turned it on. */
  siteSettings: manageProcedure.input(z.object(BRANCH).strict()).query(({ ctx, input }) =>
    guarded(async () => {
      const site = await siteFor(ctx, input.pharmacyBranchId);
      const setting = await pharmacySopAutoSchedule(ctx.db, {
        pharmacyBranchId: site.pharmacyBranchId,
      });
      return {
        pharmacyBranchId: site.pharmacyBranchId,
        autoScheduleEnabled: setting.autoScheduleEnabled,
        changedAt: setting.changedAt,
        reason: setting.reason,
      };
    })
  ),

  /**
   * Turn automatic scheduling on or off for one branch (append-only, audited).
   * ON: after the setting row, ensure the organization's hourly background job
   * (idempotent per slot) and create this branch's due procedures now (engine
   * restricted to this site's engine branch). OFF: append the setting only; the
   * next hourly run skips the branch and stops once no branch is ON. Changes
   * only whether procedures are created automatically; it never blocks or
   * changes any pharmacy workflow, and creates no escalation.
   */
  setAutoSchedule: manageProcedure
    .input(
      z
        .object({
          ...BRANCH,
          enabled: z.boolean(),
          reason: z.string().trim().max(PHARMACY_SOP_SETTING_REASON_MAX_LENGTH).optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      guarded(async () => {
        const site = await siteFor(ctx, input.pharmacyBranchId);
        const result = await setPharmacySopAutoSchedule(ctx.db, {
          site,
          enabled: input.enabled,
          userId: sessionScope(ctx).userId,
          reason: input.reason,
        });
        // Re-ensured even when already ON: idempotent, and restarts a chain
        // whose last job failed for good.
        const started = result.setting.autoScheduleEnabled
          ? await startPharmacySopAutoSchedule(ctx.db, {
              organizationId: sessionScope(ctx).organizationId,
              sopBranchId: site.sopBranchId,
              now: new Date(),
              enabledAt: result.setting.changedAt,
            })
          : null;
        audit(ctx, site, {
          action: 'pharmacy.sop.setAutoSchedule',
          targetType: 'PharmacySopSite',
          targetId: site.pharmacyBranchId,
          description: input.enabled
            ? 'Turned on automatic SOP scheduling'
            : 'Turned off automatic SOP scheduling',
          metadata: {
            enabled: input.enabled,
            changed: result.changed,
            ...(input.reason ? { reason: input.reason } : {}),
            ...(started
              ? {
                  generated: started.generated.created,
                  nextRunAt: started.job.slot.toISOString(),
                }
              : {}),
          },
        });
        return {
          pharmacyBranchId: site.pharmacyBranchId,
          autoScheduleEnabled: result.setting.autoScheduleEnabled,
          changedAt: result.setting.changedAt,
          reason: result.setting.reason,
          changed: result.changed,
          generated: started ? started.generated.created : null,
          nextRunAt: started ? started.job.slot : null,
        };
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

        // Serialize per (tenant, site, template, actor): two concurrent starts
        // would otherwise both miss the open occurrence and each create a
        // one-off assignment. The lock is transaction-scoped; the second caller
        // waits, then finds the first caller's occurrence and returns it.
        const { organizationId } = sessionScope(ctx);
        const lockKey = `pharmacy-sop-on-demand:${organizationId}:${site.sopBranchId}:${template.id}:${actor.staffProfileId}`;
        return runInTransaction(ctx.db, async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
          );
          const open = await tx.restaurantSopOccurrence.findFirst({
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
          const assignment = await createAssignment(tx, {
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
          // Only this one-off assignment (on this site's engine branch) is
          // materialised: a non-manager starting an event procedure must never
          // generate the branch's other schedules, which run only when a manager
          // creates them or turns automatic scheduling on.
          // Its one due time is this minute, the minute the assignment was
          // created, so the creation floor (minute precision) keeps it.
          await generateDueSopOccurrences(tx, {
            now,
            branchIds: [site.sopBranchId],
            assignmentIds: [assignment.id],
            skipDueBeforeAssignmentCreated: true,
          });
          const occurrence = await tx.restaurantSopOccurrence.findFirst({
            where: { assignmentId: assignment.id },
            select: { id: true },
          });
          // The one-off occurrence now exists on its own; pausing the assignment
          // keeps it out of every later generator pass.
          await setAssignmentActive(tx, assignment.id, false);
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
        });
      })
    ),

  // A reviewer who holds only `sop:verify` still needs their review queue, so
  // the board admits either capability; `mine`/`pool` are simply empty for them.
  board: auditedProtectedProcedure
    .input(z.object(BRANCH).strict())
    .query(async ({ ctx, input }) => {
      await requireAnyCapability(ctx, ['sop:complete', 'sop:verify']);
      return guarded(async () => {
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
          verifierRolesOf(pharmacySopPackForTemplateName(row.assignment.template.name)).some(
            (role) => heldRoles.includes(role)
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
                  ...notOwnedOrClaimedBy(actor.staffProfileId),
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
      });
    }),

  // Same rule for one occurrence: assertOccurrenceVisible still decides whether
  // this person may see it (owner, eligible pool holder, verifier or manager).
  occurrence: auditedProtectedProcedure
    .input(z.object(OCCURRENCE).strict())
    .query(async ({ ctx, input }) => {
      await requireAnyCapability(ctx, ['sop:complete', 'sop:verify']);
      return guarded(async () => {
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
              claimedAt: true,
              submittedAt: true,
              resolvedAt: true,
              assignedStaffProfileId: true,
              claimedByStaffProfileId: true,
              poolJobRoleId: true,
              assignedStaff: { select: { displayName: true } },
              claimedBy: { select: { displayName: true } },
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
                  contentHash: true,
                  uploaderStaffProfileId: true,
                  capturedAt: true,
                  createdAt: true,
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
        const latestRejection = latestRejectionOf(detail.verifications);
        const after = (at: Date | null | undefined) =>
          Boolean(latestRejection && at && at.getTime() > latestRejection.createdAt.getTime());
        const [evidenceProvenance, recordDetails, reworkNotes] = await Promise.all([
          provenanceOf(ctx, detail.id, detail.evidence),
          links.length
            ? describePharmacySopRecords(ctx.db, {
                organizationId: sessionScope(ctx).organizationId,
                pharmacyBranchId: site.pharmacyBranchId,
                timezone: site.timezone,
                records: links,
              })
            : Promise.resolve(new Map()),
          // A note can only exist after a send-back (the insert trigger).
          latestRejection
            ? ctx.db.pharmacySopReworkNote.findMany({
                where: { occurrenceId: detail.id, pharmacyBranchId: site.pharmacyBranchId },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: {
                  id: true,
                  occurrenceStepId: true,
                  rejectionVerificationId: true,
                  note: true,
                  createdAt: true,
                  authorStaffProfileId: true,
                },
              })
            : Promise.resolve([]),
        ]);
        const authorIds = [...new Set(reworkNotes.map((row) => row.authorStaffProfileId))];
        const authors = authorIds.length
          ? await ctx.db.restaurantStaffProfile.findMany({
              where: { id: { in: authorIds } },
              select: { id: true, displayName: true },
            })
          : [];
        const pack = pharmacySopPackForTemplateName(detail.assignment.template.name);
        const isOwner =
          (detail.assignedStaffProfileId ?? detail.claimedByStaffProfileId) ===
          actor.staffProfileId;
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
          claimedAt: detail.claimedAt,
          submittedAt: detail.submittedAt,
          resolvedAt: detail.resolvedAt,
          // Who did the work: the assignee, else the claimer. The engine trail
          // has no start, claim or submit entry, so the History view builds
          // those from these timestamps and names.
          ownerName:
            (detail.assignedStaffProfileId
              ? detail.assignedStaff?.displayName
              : detail.claimedBy?.displayName) ?? null,
          claimedByName: detail.claimedBy?.displayName ?? null,
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
              // Temperature steps: which zone's reading the step takes (null = any).
              temperatureZone: temperatureZoneOf(packStepFor(pack, step.templateStep)),
              completed: step.completed,
              completedAt: step.completedAt,
              completedByName: step.completedBy?.displayName ?? null,
              note: step.note,
            })),
          evidence: detail.evidence.map((row, index) => {
            const provenance = evidenceProvenance[index]!;
            return {
              id: row.id,
              occurrenceStepId: row.occurrenceStepId,
              mimeType: row.mimeType,
              sizeBytes: row.sizeBytes,
              storageRef: row.storageRef,
              capturedAt: row.capturedAt,
              uploaderName: row.uploader?.displayName ?? null,
              provenance,
              // Kept for older readers: true for RECEIPT and LEGACY_HMAC.
              capturedInPharmacy: isPharmacySopProof(provenance),
              // New proof added in response to the latest send-back.
              createdAfterLatestRejection: after(row.createdAt),
            };
          }),
          recordLinks: links.map((link) => ({
            ...link,
            detail:
              recordDetails.get(pharmacySopRecordDetailKey(link.recordType, link.recordId)) ??
              unavailablePharmacySopRecordDetail(link.recordType),
            createdAfterLatestRejection: after(link.createdAt),
          })),
          // The latest send-back and what the worker said they changed.
          rework: {
            latestRejection: latestRejection
              ? {
                  reason: latestRejection.reason,
                  createdAt: latestRejection.createdAt,
                  reviewerName: latestRejection.actor?.displayName ?? null,
                }
              : null,
            notes: reworkNotes.map((row) => ({
              id: row.id,
              occurrenceStepId: row.occurrenceStepId,
              note: row.note,
              createdAt: row.createdAt,
              authorName:
                authors.find((author) => author.id === row.authorStaffProfileId)?.displayName ??
                null,
              afterLatestRejection: row.rejectionVerificationId === latestRejection?.id,
            })),
          },
          verifications: detail.verifications.map((row) => ({
            id: row.id,
            action: row.action,
            reason: row.reason,
            createdAt: row.createdAt,
            actorName: row.actor?.displayName ?? null,
          })),
          auditTrail: trail ?? [],
        };
      });
    }),

  /**
   * On-demand (EVENT) procedures the caller may start at this branch: active
   * pharmacy pack templates whose pack role the caller holds at the site. Staff
   * use this instead of the manager-only `templates` listing.
   */
  onDemandTemplates: completeProcedure.input(z.object(BRANCH).strict()).query(({ ctx, input }) =>
    guarded(async () => {
      const site = await siteFor(ctx, input.pharmacyBranchId);
      const actor = await actorFor(ctx);
      const heldRoles = await pharmacySopRolesAt(ctx.db, {
        staffProfileId: actor.staffProfileId,
        sopBranchId: site.sopBranchId,
      });
      const eventPacks = PHARMACY_SOP_PACKS.filter(
        (pack) => pack.pharmacy.trigger === 'EVENT' && heldRoles.includes(pack.pharmacy.roleKey)
      );
      if (eventPacks.length === 0) return [];
      const templates = await ctx.db.restaurantSopTemplate.findMany({
        where: { isActive: true, name: { in: eventPacks.map((pack) => pack.name) } },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, category: true },
      });
      return templates.map((template) => ({
        id: template.id,
        name: template.name,
        category: template.category,
      }));
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
    guardedAs('start')(async () => {
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
      guardedAs('completeStep')(async () => {
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
        const packStep = await assertLinkableRecordType(
          ctx,
          await packForVersion(ctx, occurrence.templateVersionId),
          occurrence.id,
          input.occurrenceStepId ?? null,
          input.recordType
        );
        // A refrigerator step takes only a cold-chain reading, the ambient step
        // only an ambient one (checked by the adapter against the location).
        const result = await linkPharmacySopRecord(ctx.db, {
          site,
          occurrenceId: occurrence.id,
          occurrenceStepId: input.occurrenceStepId ?? null,
          recordType: input.recordType,
          recordId: input.recordId,
          note: input.note ?? null,
          actor,
          temperatureZone: temperatureZoneOf(packStep),
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

  /**
   * Records the picker may offer: this branch's own records of one type the
   * procedure links, inside the link window. Each carries a plain-language
   * `detail` (no status codes). With `occurrenceStepId`, only records that
   * step accepts are offered: its record type, and for a temperature step only
   * readings from its storage zone (refrigerator = cold-chain locations,
   * ambient = the others) — the same rule `linkRecord` enforces.
   */
  linkableRecords: completeProcedure
    .input(
      z
        .object({
          ...OCCURRENCE,
          recordType: RECORD_TYPE,
          occurrenceStepId: ID.nullable().optional(),
        })
        .strict()
    )
    .query(({ ctx, input }) =>
      guarded(async () => {
        const { site, occurrence, actor } = await occurrenceContext(
          ctx,
          input.pharmacyBranchId,
          input.occurrenceId
        );
        const pack = await packForVersion(ctx, occurrence.templateVersionId);
        await assertOccurrenceVisible(ctx, site, actor, occurrence, pack);
        if (!packRecordTypes(pack).has(input.recordType)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `This procedure does not link a ${recordTypeLabel(input.recordType)}.`,
          });
        }
        const packStep = input.occurrenceStepId
          ? await assertLinkableRecordType(
              ctx,
              pack,
              occurrence.id,
              input.occurrenceStepId,
              input.recordType
            )
          : undefined;
        const window = await ctx.db.restaurantSopOccurrence.findUnique({
          where: { id: occurrence.id },
          select: { dueAt: true, windowEndsAt: true },
        });
        if (!window) throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
        // Offer only records the link will accept (the adapter enforces the
        // same bounds); null means the type is not time-bounded.
        return listPharmacySopLinkableRecords(ctx.db, {
          organizationId: sessionScope(ctx).organizationId,
          pharmacyBranchId: site.pharmacyBranchId,
          timezone: site.timezone,
          recordType: input.recordType,
          bounds: pharmacySopRecordTimeBounds(input.recordType, window),
          temperatureZone: temperatureZoneOf(packStep),
          take: 50,
        });
      })
    ),

  /**
   * After a reviewer sends a procedure back and its owner starts it again, say
   * what changed (optionally against one step). Append-only: a note is never
   * edited or removed; add another instead. The occurrence must be the actor's
   * own work, back IN_PROGRESS, with a send-back as its latest review; the note
   * answers that send-back. The author is the session actor. The database
   * trigger re-checks every one of these rules.
   */
  addReworkNote: completeProcedure
    .input(
      z
        .object({
          ...OCCURRENCE,
          occurrenceStepId: ID.nullable().optional(),
          note: z.string().trim().min(1, 'Say what you changed.').max(REWORK_NOTE_MAX_LENGTH),
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
        await assertStepOnOccurrence(ctx, occurrence.id, input.occurrenceStepId);
        const { organizationId } = sessionScope(ctx);
        const created = await runInTransaction(ctx.db, async (tx) => {
          // Share-lock the occurrence so a concurrent submit waits for this
          // note (or this note sees the submit), then re-read it under the lock.
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 FROM "restaurant_sop_occurrences" WHERE "id" = ${occurrence.id} AND "organizationId" = ${organizationId} AND "branchId" = ${site.sopBranchId} FOR SHARE`
          );
          const current = await tx.restaurantSopOccurrence.findFirst({
            where: { id: occurrence.id, branchId: site.sopBranchId },
            select: {
              status: true,
              assignedStaffProfileId: true,
              claimedByStaffProfileId: true,
              verifications: {
                orderBy: LATEST_FIRST,
                take: 1,
                select: { id: true, action: true },
              },
            },
          });
          if (!current) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
          }
          assertOwnWork(current, actor);
          const latest = current.verifications[0];
          if (!latest || latest.action !== 'REJECT') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'This procedure has not been sent back, so there is nothing to answer.',
            });
          }
          if (current.status !== 'IN_PROGRESS') {
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                current.status === 'REJECTED'
                  ? 'Start this procedure again before saying what you changed.'
                  : SOP_STATE_MESSAGES.changed,
            });
          }
          return tx.pharmacySopReworkNote.create({
            data: {
              organizationId,
              pharmacyBranchId: site.pharmacyBranchId,
              occurrenceId: occurrence.id,
              occurrenceStepId: input.occurrenceStepId ?? null,
              rejectionVerificationId: latest.id,
              note: input.note,
              authorStaffProfileId: actor.staffProfileId,
              authorUserId: actor.userId,
            },
            select: { id: true, occurrenceStepId: true, note: true, createdAt: true },
          });
        });
        audit(ctx, site, {
          action: 'pharmacy.sop.addReworkNote',
          targetType: 'PharmacySopReworkNote',
          targetId: created.id,
          description: 'Noted what changed after a send-back',
          metadata: {
            occurrenceId: occurrence.id,
            ...(created.occurrenceStepId ? { occurrenceStepId: created.occurrenceStepId } : {}),
          },
        });
        return {
          id: created.id,
          occurrenceStepId: created.occurrenceStepId,
          note: created.note,
          createdAt: created.createdAt,
          authorName: actor.displayName,
          afterLatestRejection: true,
        };
      })
    ),

  submit: completeProcedure.input(z.object(OCCURRENCE).strict()).mutation(({ ctx, input }) =>
    guardedAs('submit')(async () => {
      const { site, occurrence, actor } = await occurrenceContext(
        ctx,
        input.pharmacyBranchId,
        input.occurrenceId
      );
      assertOwnWork(occurrence, actor);
      if (occurrence.status !== 'IN_PROGRESS') {
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            occurrence.status === 'SCHEDULED' || occurrence.status === 'REJECTED'
              ? 'Start this procedure before sending it for review.'
              : SOP_STATE_MESSAGES.changed,
        });
      }
      await assertReworkNoted(ctx, site, occurrence.id);
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
      guardedAs('verify')(async () => {
        const { site, occurrence, actor } = await occurrenceContext(
          ctx,
          input.pharmacyBranchId,
          input.occurrenceId
        );
        assertInReview(occurrence);
        await assertIndependentPharmacyVerifier(ctx.db, {
          occurrenceId: occurrence.id,
          site,
          verifierStaffProfileId: actor.staffProfileId,
        });
        // Rejecting stays open (it sends the work back); verifying would
        // endorse proof the pharmacy workspace never captured.
        const evidence = await ctx.db.restaurantSopEvidence.findMany({
          where: { occurrenceId: occurrence.id },
          select: EVIDENCE_PROVENANCE_SELECT,
        });
        const provenance = await provenanceOf(ctx, occurrence.id, evidence);
        if (provenance.includes('FOREIGN')) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: FOREIGN_PROOF_MESSAGE });
        }
        if (provenance.includes('UNCONFIRMED')) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: UNCONFIRMED_PROOF_MESSAGE });
        }
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
      guardedAs('reject')(async () => {
        const { site, occurrence, actor } = await occurrenceContext(
          ctx,
          input.pharmacyBranchId,
          input.occurrenceId
        );
        assertInReview(occurrence);
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

  // ── Reporting (sop:manage or sop:verify) ──────────────────────────────────
  // The report names every person's work at the branch, so it is a manager or
  // reviewer read; completing procedures alone does not grant it.

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
      await requireAnyCapability(ctx, ['sop:manage', 'sop:verify']);
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
