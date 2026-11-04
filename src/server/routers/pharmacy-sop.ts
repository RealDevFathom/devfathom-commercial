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
  listPharmacySopBranches,
  pharmacySopRolesAt,
  resolvePharmacySopActor,
  resolvePharmacySopSite,
  setPharmacySopRoleHolding,
  type PharmacySopActor,
  type PharmacySopRoleKey,
  type PharmacySopSiteRef,
} from '@/lib/pharmacy/sop-adapter';
import { isPharmacySopCapturedEvidence } from '@/lib/pharmacy/sop-evidence';
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

/**
 * Engine refusals, mapped the way the restaurant SOP routers map them. A
 * not-found refusal gets fixed wording: the engine's own message can embed an
 * internal id ("Branch <id> was not found.") that a pharmacy caller must not see.
 */
function mapSopError(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof PharmacySopAccessError) mapAccessError(err);
  if (err instanceof SopExecutionError) {
    if (err.reason === 'NOT_FOUND') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
    }
    if (err.reason === 'STEP_NOT_FOUND') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Step not found on this occurrence.' });
    }
    const code =
      err.reason === 'NOT_OWNER'
        ? 'FORBIDDEN'
        : err.reason === 'INVALID_STATE' || err.reason === 'STEP_ALREADY_COMPLETED'
          ? 'CONFLICT'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  if (err instanceof SopVerificationError) {
    if (err.reason === 'NOT_FOUND') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
    }
    const code =
      err.reason === 'INVALID_STATE'
        ? 'CONFLICT'
        : err.reason === 'CO_AUTH_REQUIRED'
          ? 'FORBIDDEN'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  if (err instanceof SopTemplateError) {
    if (err.reason === 'NOT_FOUND') {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'That SOP template, assignment or branch was not found.',
      });
    }
    const code =
      err.reason === 'TEMPLATE_LIMIT_REACHED' ||
      err.reason === 'DRAFT_EXISTS' ||
      err.reason === 'VERSION_NOT_DRAFT' ||
      err.reason === 'INVALID_STATE'
        ? 'CONFLICT'
        : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  if (err instanceof PharmacySopLibraryScopeError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: err.message });
  }
  if (err instanceof RecurrenceError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  }
  if (err instanceof AssigneeTargetError) {
    if (err.reason === 'ROLE_NOT_FOUND' || err.reason === 'STAFF_NOT_FOUND') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'That assignee was not found at this branch.',
      });
    }
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

// ── Proof provenance ──────────────────────────────────────────────────────────

/** The evidence columns the pharmacy provenance MAC covers. */
const EVIDENCE_PROVENANCE_SELECT = {
  occurrenceStepId: true,
  contentHash: true,
  mimeType: true,
  uploaderStaffProfileId: true,
  storageRef: true,
} as const;

type EvidenceProvenanceRow = {
  occurrenceStepId: string | null;
  contentHash: string;
  mimeType: string;
  uploaderStaffProfileId: string | null;
  storageRef: string | null;
};

/**
 * Whether one evidence row was captured through the pharmacy evidence route.
 * Rows attached through the restaurant SOP surfaces (which accept a
 * caller-supplied uploader or storage ref) never qualify; see
 * `src/lib/pharmacy/sop-evidence.ts`.
 */
function capturedInPharmacy(
  ctx: TRPCContext,
  occurrenceId: string,
  row: EvidenceProvenanceRow
): boolean {
  return isPharmacySopCapturedEvidence(
    {
      occurrenceId,
      occurrenceStepId: row.occurrenceStepId,
      contentHash: row.contentHash,
      mimeType: row.mimeType,
      uploaderStaffProfileId: row.uploaderStaffProfileId,
      storageRef: row.storageRef,
    },
    sessionScope(ctx).organizationId
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
): Promise<void> {
  if (!packRecordTypes(pack).has(recordType)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `This procedure does not link a ${recordTypeLabel(recordType)}.`,
    });
  }
  if (!occurrenceStepId) return;
  const step = await ctx.db.restaurantSopOccurrenceStep.findFirst({
    where: { id: occurrenceStepId, occurrenceId },
    select: { templateStep: { select: { title: true, stepOrder: true } } },
  });
  if (!step) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Step not found on this occurrence.' });
  }
  const required = requiredRecordTypeOf(packStepFor(pack, step.templateStep));
  if (required !== recordType) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: required
        ? `This step links a ${recordTypeLabel(required)}, not a ${recordTypeLabel(recordType)}.`
        : 'This step does not take a linked record.',
    });
  }
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
  for (const step of occ.steps) {
    const proof = (step.evidence ?? []).filter((row) => capturedInPharmacy(ctx, occurrenceId, row));
    const missing =
      step.templateStep.requiresPhoto && !proof.some((row) => isPhotoProof(row.mimeType))
        ? 'photo'
        : step.templateStep.requiresSignature &&
            !proof.some((row) => isSignatureProof(row.mimeType))
          ? 'signature'
          : null;
    if (missing) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Capture the ${missing} proof for “${step.templateStep.title}” in the pharmacy workspace before submitting.`,
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
    guarded(async () => {
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
          select: {
            id: true,
            branchId: true,
            frequency: true,
            assigneeTargetType: true,
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
        return updated;
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
          await generateDueSopOccurrences(tx, { now });
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
            capturedInPharmacy: capturedInPharmacy(ctx, detail.id, row),
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
        await assertLinkableRecordType(
          ctx,
          await packForVersion(ctx, occurrence.templateVersionId),
          occurrence.id,
          input.occurrenceStepId ?? null,
          input.recordType
        );
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
        const pack = await packForVersion(ctx, occurrence.templateVersionId);
        await assertOccurrenceVisible(ctx, site, actor, occurrence, pack);
        if (!packRecordTypes(pack).has(input.recordType)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `This procedure does not link a ${recordTypeLabel(input.recordType)}.`,
          });
        }
        const window = await ctx.db.restaurantSopOccurrence.findUnique({
          where: { id: occurrence.id },
          select: { dueAt: true, windowEndsAt: true },
        });
        if (!window) throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
        const branchId = site.pharmacyBranchId;
        const take = 50;
        // Offer only records the link will accept (the adapter enforces the
        // same bounds); null means the type is not time-bounded.
        const bounds = pharmacySopRecordTimeBounds(input.recordType, window);
        switch (input.recordType) {
          case 'TEMPERATURE_LOG': {
            const rows = await ctx.db.pharmacyTemperatureLog.findMany({
              where: { branchId, ...(bounds ? { recordedAt: bounds } : {}) },
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
              where: { branchId, ...(bounds ? { receivedAt: bounds } : {}) },
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
        // Rejecting stays open (it sends the work back); verifying would
        // endorse proof the pharmacy workspace never captured.
        const evidence = await ctx.db.restaurantSopEvidence.findMany({
          where: { occurrenceId: occurrence.id },
          select: EVIDENCE_PROVENANCE_SELECT,
        });
        if (evidence.some((row) => !capturedInPharmacy(ctx, occurrence.id, row))) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: FOREIGN_PROOF_MESSAGE });
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
