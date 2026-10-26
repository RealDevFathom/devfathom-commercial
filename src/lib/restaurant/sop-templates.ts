import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { businessDateToUtcDate } from '@/lib/restaurant/business-date';
import {
  RecurrenceError,
  type RecurrenceFrequency,
  type RecurrenceRule,
  assertValidRule,
} from '@/lib/restaurant/sop-recurrence';
import {
  type AssigneeTarget,
  assertAssigneeTarget,
  assigneeTargetColumns,
} from '@/lib/restaurant/sop-assignment';

/**
 * M7-L3 / §SOP — SOP template authoring: the template family → version → step
 * lifecycle that the SOP admin console drives.
 *
 * Shape (schema, M7-L1):
 *   - A `RestaurantSopTemplate` is a named FAMILY. It has metadata (name,
 *     description, category, isActive) and one or more versions.
 *   - A `RestaurantSopTemplateVersion` is DRAFT → PUBLISHED → RETIRED. Only a
 *     DRAFT is editable; publishing FREEZES the version and its steps. Editing a
 *     published SOP means opening a NEW draft version (its steps cloned forward),
 *     never mutating the frozen one.
 *   - A `RestaurantSopTemplateStep` is an ordered checklist item on a version.
 *
 * Two invariants are enforced HERE in the server (not by RLS — the SOP tables use
 * ordinary tenant-isolation policies, so the app role can technically UPDATE a
 * published row; these guards are what actually make publish immutable):
 *   1. Publish immutability — every step mutation and every publish/retire
 *      transition asserts the target version's status first.
 *   2. `sop.templates.max` — the entitlement caps the number of ACTIVE template
 *      families (not immutable historical versions; see vertical-catalog
 *      `countedUnit`). Enforced on create and on reactivation.
 *
 * Tenant scoping is the RLS-forced `organizationId` default on every row (never
 * set by this module), mirroring the catalog/recipes libs.
 */

export type SopTemplateStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

export type SopTemplateErrorReason =
  | 'NOT_FOUND'
  | 'TEMPLATE_LIMIT_REACHED'
  | 'VERSION_NOT_DRAFT'
  | 'INVALID_STATE'
  | 'DRAFT_EXISTS'
  | 'NO_STEPS'
  | 'INVALID';

export class SopTemplateError extends Error {
  constructor(
    message: string,
    readonly reason: SopTemplateErrorReason
  ) {
    super(message);
    this.name = 'SopTemplateError';
  }
}

/** Open one tenant-scoped transaction (mirrors scheduler/inventory-ledger). */
function runSopTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

const NAME_MAX = 200;

function requireName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new SopTemplateError('A template name is required.', 'INVALID');
  if (trimmed.length > NAME_MAX) {
    throw new SopTemplateError(`A template name may be at most ${NAME_MAX} characters.`, 'INVALID');
  }
  return trimmed;
}

// ── Template families ─────────────────────────────────────────────────────────

export type CreateTemplateInput = {
  name: string;
  description?: string | null;
  category?: string | null;
};

/**
 * Create a template family and its initial empty DRAFT version (v1), enforcing
 * `sop.templates.max` against the count of ACTIVE families. The fresh draft is
 * where the author adds steps before publishing.
 */
export async function createTemplate(
  db: ScopedDb,
  input: CreateTemplateInput,
  templatesMax: number
) {
  const name = requireName(input.name);
  return runSopTransaction(db, async (tx) => {
    const activeCount = await tx.restaurantSopTemplate.count({ where: { isActive: true } });
    if (activeCount >= templatesMax) {
      throw new SopTemplateError(
        `At most ${templatesMax} SOP templates may be active.`,
        'TEMPLATE_LIMIT_REACHED'
      );
    }
    return tx.restaurantSopTemplate.create({
      data: {
        name,
        description: input.description ?? null,
        category: input.category ?? null,
        versions: { create: { versionNumber: 1, status: 'DRAFT' } },
      },
      include: { versions: true },
    });
  });
}

export type UpdateTemplateInput = {
  name?: string;
  description?: string | null;
  category?: string | null;
};

/** Update family METADATA (name/description/category). Family metadata is not
 * versioned, so this is allowed regardless of any version's publish state. */
export async function updateTemplate(db: ScopedDb, id: string, patch: UpdateTemplateInput) {
  await requireTemplate(db, id);
  const data: Prisma.RestaurantSopTemplateUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name);
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.category !== undefined) data.category = patch.category;
  return db.restaurantSopTemplate.update({ where: { id }, data });
}

/**
 * Archive (isActive=false) or reactivate (isActive=true) a family. Reactivation
 * re-checks `sop.templates.max` so archiving cannot be used to sidestep the cap.
 */
export async function setTemplateActive(
  db: ScopedDb,
  id: string,
  isActive: boolean,
  templatesMax: number
) {
  return runSopTransaction(db, async (tx) => {
    const template = await tx.restaurantSopTemplate.findUnique({ where: { id } });
    if (!template) throw new SopTemplateError(`Template ${id} was not found.`, 'NOT_FOUND');
    if (isActive && !template.isActive) {
      const activeCount = await tx.restaurantSopTemplate.count({ where: { isActive: true } });
      if (activeCount >= templatesMax) {
        throw new SopTemplateError(
          `At most ${templatesMax} SOP templates may be active.`,
          'TEMPLATE_LIMIT_REACHED'
        );
      }
    }
    return tx.restaurantSopTemplate.update({ where: { id }, data: { isActive } });
  });
}

async function requireTemplate(db: ScopedDb, id: string) {
  const template = await db.restaurantSopTemplate.findUnique({ where: { id } });
  if (!template) throw new SopTemplateError(`Template ${id} was not found.`, 'NOT_FOUND');
  return template;
}

// ── Versions ──────────────────────────────────────────────────────────────────

type VersionRow = {
  id: string;
  templateId: string;
  versionNumber: number;
  status: SopTemplateStatus;
};

async function requireVersion(db: ScopedDb, versionId: string): Promise<VersionRow> {
  const version = await db.restaurantSopTemplateVersion.findUnique({
    where: { id: versionId },
    select: { id: true, templateId: true, versionNumber: true, status: true },
  });
  if (!version) {
    throw new SopTemplateError(`Template version ${versionId} was not found.`, 'NOT_FOUND');
  }
  return version as VersionRow;
}

/** Publish-immutability guard: a version's steps may only change while DRAFT. */
function assertDraft(version: VersionRow): void {
  if (version.status !== 'DRAFT') {
    throw new SopTemplateError(
      `Template version ${version.id} is ${version.status}; published versions are immutable. Open a new draft to edit.`,
      'VERSION_NOT_DRAFT'
    );
  }
}

/**
 * Open a NEW draft version for a template. At most one DRAFT may be open at a
 * time. Steps are cloned forward from `cloneFromVersionId` (validated to belong
 * to the template) or, by default, from the latest existing version — so editing
 * a published SOP starts from its current content rather than a blank slate.
 */
export async function createDraftVersion(
  db: ScopedDb,
  templateId: string,
  opts: { cloneFromVersionId?: string } = {}
) {
  return runSopTransaction(db, async (tx) => {
    const template = await tx.restaurantSopTemplate.findUnique({ where: { id: templateId } });
    if (!template) throw new SopTemplateError(`Template ${templateId} was not found.`, 'NOT_FOUND');

    const versions = await tx.restaurantSopTemplateVersion.findMany({
      where: { templateId },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, versionNumber: true, status: true },
    });
    if (versions.some((v) => v.status === 'DRAFT')) {
      throw new SopTemplateError(
        'A draft version already exists for this template; publish or discard it first.',
        'DRAFT_EXISTS'
      );
    }

    const cloneFromId = opts.cloneFromVersionId ?? versions[0]?.id ?? null;
    if (opts.cloneFromVersionId && !versions.some((v) => v.id === opts.cloneFromVersionId)) {
      throw new SopTemplateError(
        `Version ${opts.cloneFromVersionId} does not belong to template ${templateId}.`,
        'INVALID'
      );
    }
    const nextNumber = (versions[0]?.versionNumber ?? 0) + 1;

    const clonedSteps = cloneFromId
      ? (
          await tx.restaurantSopTemplateStep.findMany({
            where: { templateVersionId: cloneFromId },
            orderBy: { stepOrder: 'asc' },
          })
        ).map((step) => ({
          stepOrder: step.stepOrder,
          title: step.title,
          instructions: step.instructions,
          requiresPhoto: step.requiresPhoto,
          requiresSignature: step.requiresSignature,
          requiresNote: step.requiresNote,
        }))
      : [];

    return tx.restaurantSopTemplateVersion.create({
      data: {
        templateId,
        versionNumber: nextNumber,
        status: 'DRAFT',
        ...(clonedSteps.length > 0 ? { steps: { create: clonedSteps } } : {}),
      },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
  });
}

/**
 * Publish a DRAFT version. Requires at least one step. Atomically retires the
 * family's currently-published version (a family has at most one PUBLISHED
 * version at a time, so "latest published" is unambiguous) and marks this one
 * PUBLISHED at `now`.
 */
export async function publishVersion(db: ScopedDb, versionId: string, now: Date = new Date()) {
  return runSopTransaction(db, async (tx) => {
    const version = await requireVersion(tx, versionId);
    if (version.status !== 'DRAFT') {
      throw new SopTemplateError(
        `Only a DRAFT version can be published; version ${versionId} is ${version.status}.`,
        'INVALID_STATE'
      );
    }
    const stepCount = await tx.restaurantSopTemplateStep.count({
      where: { templateVersionId: versionId },
    });
    if (stepCount < 1) {
      throw new SopTemplateError(
        'A template version must have at least one step before it can be published.',
        'NO_STEPS'
      );
    }
    await tx.restaurantSopTemplateVersion.updateMany({
      where: { templateId: version.templateId, status: 'PUBLISHED' },
      data: { status: 'RETIRED', retiredAt: now },
    });
    return tx.restaurantSopTemplateVersion.update({
      where: { id: versionId },
      data: { status: 'PUBLISHED', publishedAt: now },
    });
  });
}

/** Retire a PUBLISHED version (a family with no published version schedules
 * nothing new until another is published). */
export async function retireVersion(db: ScopedDb, versionId: string, now: Date = new Date()) {
  const version = await requireVersion(db, versionId);
  if (version.status !== 'PUBLISHED') {
    throw new SopTemplateError(
      `Only a PUBLISHED version can be retired; version ${versionId} is ${version.status}.`,
      'INVALID_STATE'
    );
  }
  return db.restaurantSopTemplateVersion.update({
    where: { id: versionId },
    data: { status: 'RETIRED', retiredAt: now },
  });
}

/**
 * The version an occurrence should pin at generation time: the highest-numbered
 * PUBLISHED version of the template, or null when none is published.
 */
export async function resolveLatestPublishedVersion(db: ScopedDb, templateId: string) {
  return db.restaurantSopTemplateVersion.findFirst({
    where: { templateId, status: 'PUBLISHED' },
    orderBy: { versionNumber: 'desc' },
  });
}

// ── Steps (DRAFT-only mutations) ──────────────────────────────────────────────

export type AddStepInput = {
  templateVersionId: string;
  title: string;
  instructions?: string | null;
  requiresPhoto?: boolean;
  requiresSignature?: boolean;
  requiresNote?: boolean;
};

/** Append a step to a DRAFT version (stepOrder auto-assigned to the next slot). */
export async function addStep(db: ScopedDb, input: AddStepInput) {
  const title = input.title.trim();
  if (!title) throw new SopTemplateError('A step title is required.', 'INVALID');
  return runSopTransaction(db, async (tx) => {
    const version = await requireVersion(tx, input.templateVersionId);
    assertDraft(version);
    const last = await tx.restaurantSopTemplateStep.findFirst({
      where: { templateVersionId: input.templateVersionId },
      orderBy: { stepOrder: 'desc' },
      select: { stepOrder: true },
    });
    return tx.restaurantSopTemplateStep.create({
      data: {
        templateVersionId: input.templateVersionId,
        stepOrder: (last?.stepOrder ?? 0) + 1,
        title,
        instructions: input.instructions ?? null,
        requiresPhoto: input.requiresPhoto ?? false,
        requiresSignature: input.requiresSignature ?? false,
        requiresNote: input.requiresNote ?? false,
      },
    });
  });
}

export type UpdateStepInput = {
  title?: string;
  instructions?: string | null;
  requiresPhoto?: boolean;
  requiresSignature?: boolean;
  requiresNote?: boolean;
};

async function requireStepWithVersion(db: ScopedDb, stepId: string) {
  const step = await db.restaurantSopTemplateStep.findUnique({
    where: { id: stepId },
    select: { id: true, templateVersionId: true },
  });
  if (!step) throw new SopTemplateError(`Step ${stepId} was not found.`, 'NOT_FOUND');
  const version = await requireVersion(db, step.templateVersionId);
  return { step, version };
}

/** Edit a step on a DRAFT version. */
export async function updateStep(db: ScopedDb, stepId: string, patch: UpdateStepInput) {
  return runSopTransaction(db, async (tx) => {
    const { version } = await requireStepWithVersion(tx, stepId);
    assertDraft(version);
    const data: Prisma.RestaurantSopTemplateStepUpdateInput = {};
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new SopTemplateError('A step title is required.', 'INVALID');
      data.title = title;
    }
    if (patch.instructions !== undefined) data.instructions = patch.instructions;
    if (patch.requiresPhoto !== undefined) data.requiresPhoto = patch.requiresPhoto;
    if (patch.requiresSignature !== undefined) data.requiresSignature = patch.requiresSignature;
    if (patch.requiresNote !== undefined) data.requiresNote = patch.requiresNote;
    return tx.restaurantSopTemplateStep.update({ where: { id: stepId }, data });
  });
}

/** Remove a step from a DRAFT version. */
export async function removeStep(db: ScopedDb, stepId: string) {
  return runSopTransaction(db, async (tx) => {
    const { version } = await requireStepWithVersion(tx, stepId);
    assertDraft(version);
    await tx.restaurantSopTemplateStep.delete({ where: { id: stepId } });
    return { id: stepId };
  });
}

/**
 * Reorder a DRAFT version's steps to exactly `orderedStepIds`. The set must match
 * the version's steps 1:1. Reassignment is two-phase (offset the orders out of the
 * 1..N range first) so the `unique(templateVersionId, stepOrder)` constraint is
 * never transiently violated mid-update.
 */
export async function reorderSteps(db: ScopedDb, versionId: string, orderedStepIds: string[]) {
  return runSopTransaction(db, async (tx) => {
    const version = await requireVersion(tx, versionId);
    assertDraft(version);
    const steps = await tx.restaurantSopTemplateStep.findMany({
      where: { templateVersionId: versionId },
      select: { id: true },
    });
    const existing = new Set(steps.map((s) => s.id));
    if (
      orderedStepIds.length !== existing.size ||
      new Set(orderedStepIds).size !== orderedStepIds.length
    ) {
      throw new SopTemplateError('reorderSteps requires each step exactly once.', 'INVALID');
    }
    for (const id of orderedStepIds) {
      if (!existing.has(id)) {
        throw new SopTemplateError(
          `Step ${id} does not belong to version ${versionId}.`,
          'INVALID'
        );
      }
    }
    // Phase 1: move every step to a temporary, collision-free negative order.
    for (let i = 0; i < orderedStepIds.length; i += 1) {
      await tx.restaurantSopTemplateStep.update({
        where: { id: orderedStepIds[i]! },
        data: { stepOrder: -(i + 1) },
      });
    }
    // Phase 2: assign the final 1..N ordering.
    for (let i = 0; i < orderedStepIds.length; i += 1) {
      await tx.restaurantSopTemplateStep.update({
        where: { id: orderedStepIds[i]! },
        data: { stepOrder: i + 1 },
      });
    }
    return tx.restaurantSopTemplateStep.findMany({
      where: { templateVersionId: versionId },
      orderBy: { stepOrder: 'asc' },
    });
  });
}

// ── Read models ───────────────────────────────────────────────────────────────

/** List template families (newest first). `includeInactive` adds archived ones. */
export async function listTemplates(db: ScopedDb, opts: { includeInactive?: boolean } = {}) {
  return db.restaurantSopTemplate.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: { createdAt: 'desc' },
    include: {
      versions: {
        orderBy: { versionNumber: 'desc' },
        select: { id: true, versionNumber: true, status: true, publishedAt: true, retiredAt: true },
      },
    },
  });
}

/** A single template family with all versions and their steps. */
export async function getTemplate(db: ScopedDb, id: string) {
  const template = await db.restaurantSopTemplate.findUnique({
    where: { id },
    include: {
      versions: {
        orderBy: { versionNumber: 'desc' },
        include: { steps: { orderBy: { stepOrder: 'asc' } } },
      },
    },
  });
  if (!template) throw new SopTemplateError(`Template ${id} was not found.`, 'NOT_FOUND');
  return template;
}

/** Versions of a template (newest first) with a step count. */
export async function listVersions(db: ScopedDb, templateId: string) {
  await requireTemplate(db, templateId);
  return db.restaurantSopTemplateVersion.findMany({
    where: { templateId },
    orderBy: { versionNumber: 'desc' },
    include: { _count: { select: { steps: true } } },
  });
}

/** A single version with its ordered steps. */
export async function getVersion(db: ScopedDb, versionId: string) {
  const version = await db.restaurantSopTemplateVersion.findUnique({
    where: { id: versionId },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });
  if (!version)
    throw new SopTemplateError(`Template version ${versionId} was not found.`, 'NOT_FOUND');
  return version;
}

// ── Assignments (a template scheduled to a branch with a recurrence) ───────────
//
// An assignment binds a template family to a branch with a structured recurrence
// (the fields the occurrence generator reads). The recurrence is validated HERE
// through the pure engine (`assertValidRule`) so a malformed schedule is rejected
// at authoring time, not discovered when generation runs.

/** Format a `@db.Date` column value (UTC midnight) as `YYYY-MM-DD`. */
function dateColumnToISO(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export type AssignmentRuleFields = {
  frequency: RecurrenceFrequency;
  interval: number;
  daysOfWeek: number[];
  monthDay: number | null;
  startDate: string; // YYYY-MM-DD (branch-local)
  endDate: string | null;
  dueTimeMinutes: number;
  intervalEndTimeMinutes?: number | null;
  windowMinutes: number;
};

export type CreateAssignmentInput = AssignmentRuleFields & {
  branchId: string;
  templateId: string;
  graceMinutes: number;
  /**
   * SOP-1: who owes the work — a named person, or a job role whose branch holders
   * may claim it. Required: an assignment with no assignee is work nobody owns,
   * and the DB CHECK would reject the row anyway.
   */
  assigneeTarget: AssigneeTarget;
};

function ruleOf(fields: AssignmentRuleFields): RecurrenceRule {
  return {
    frequency: fields.frequency,
    interval: fields.interval,
    daysOfWeek: fields.daysOfWeek,
    monthDay: fields.monthDay,
    startDate: fields.startDate,
    endDate: fields.endDate,
    dueTimeMinutes: fields.dueTimeMinutes,
    intervalEndTimeMinutes: fields.intervalEndTimeMinutes,
    windowMinutes: fields.windowMinutes,
  };
}

/** The stored shape of an assignment's recurrence fields (`@db.Date` columns). */
export type StoredAssignmentRule = {
  frequency: RecurrenceFrequency;
  interval: number;
  daysOfWeek: number[];
  monthDay: number | null;
  startDate: Date;
  endDate: Date | null;
  dueTimeMinutes: number;
  intervalEndTimeMinutes: number | null;
  windowMinutes: number;
};

/** Project a persisted assignment onto a {@link RecurrenceRule} (dates → ISO). */
export function assignmentRecurrenceRule(assignment: StoredAssignmentRule): RecurrenceRule {
  return {
    frequency: assignment.frequency,
    interval: assignment.interval,
    daysOfWeek: assignment.daysOfWeek,
    monthDay: assignment.monthDay,
    startDate: dateColumnToISO(assignment.startDate),
    endDate: assignment.endDate ? dateColumnToISO(assignment.endDate) : null,
    dueTimeMinutes: assignment.dueTimeMinutes,
    intervalEndTimeMinutes: assignment.intervalEndTimeMinutes,
    windowMinutes: assignment.windowMinutes,
  };
}

/**
 * Create a branch assignment for a template. Validates that the branch and
 * template exist and that the recurrence is well-formed before persisting; dates
 * are stored as `@db.Date` (UTC midnight). Throws `RecurrenceError` on a malformed
 * rule — the router maps it to a 400.
 */
export async function createAssignment(db: ScopedDb, input: CreateAssignmentInput) {
  assertValidRule(ruleOf(input));
  const [branch, template] = await Promise.all([
    db.restaurantBranch.findUnique({ where: { id: input.branchId }, select: { id: true } }),
    db.restaurantSopTemplate.findUnique({ where: { id: input.templateId }, select: { id: true } }),
  ]);
  if (!branch) throw new SopTemplateError(`Branch ${input.branchId} was not found.`, 'NOT_FOUND');
  if (!template)
    throw new SopTemplateError(`Template ${input.templateId} was not found.`, 'NOT_FOUND');
  await assertAssigneeTarget(db, input.assigneeTarget);
  return db.restaurantSopAssignment.create({
    data: {
      branchId: input.branchId,
      templateId: input.templateId,
      ...assigneeTargetColumns(input.assigneeTarget),
      frequency: input.frequency,
      interval: input.interval,
      daysOfWeek: input.daysOfWeek,
      monthDay: input.monthDay,
      startDate: businessDateToUtcDate(input.startDate),
      endDate: input.endDate ? businessDateToUtcDate(input.endDate) : null,
      dueTimeMinutes: input.dueTimeMinutes,
      intervalEndTimeMinutes: input.intervalEndTimeMinutes ?? null,
      windowMinutes: input.windowMinutes,
      graceMinutes: input.graceMinutes,
    },
  });
}

export type UpdateAssignmentInput = Partial<AssignmentRuleFields & { graceMinutes: number }> & {
  /** Branch-local date on which the successor configuration starts. */
  effectiveDate: string;
  /**
   * SOP-1: re-target the assignment. Applies to occurrences generated FROM NOW ON
   * — already-materialised occurrences keep the owner they were stamped with, the
   * same way they keep their pinned template version.
   */
  assigneeTarget?: AssigneeTarget;
};

/**
 * Update an assignment's recurrence/config. The full effective rule (existing
 * merged with the patch) is re-validated so an update can never leave a schedule
 * malformed. The template↔branch binding is immutable (rebind = new assignment).
 */
export async function updateAssignment(db: ScopedDb, id: string, patch: UpdateAssignmentInput) {
  const existing = await db.restaurantSopAssignment.findUnique({ where: { id } });
  if (!existing) throw new SopTemplateError(`Assignment ${id} was not found.`, 'NOT_FOUND');

  const merged: AssignmentRuleFields = {
    frequency: patch.frequency ?? (existing.frequency as RecurrenceFrequency),
    interval: patch.interval ?? existing.interval,
    daysOfWeek: patch.daysOfWeek ?? existing.daysOfWeek,
    monthDay: patch.monthDay !== undefined ? patch.monthDay : existing.monthDay,
    startDate: patch.effectiveDate,
    endDate:
      patch.endDate !== undefined
        ? patch.endDate
        : existing.endDate
          ? dateColumnToISO(existing.endDate)
          : null,
    dueTimeMinutes: patch.dueTimeMinutes ?? existing.dueTimeMinutes,
    intervalEndTimeMinutes:
      patch.intervalEndTimeMinutes !== undefined
        ? patch.intervalEndTimeMinutes
        : existing.intervalEndTimeMinutes,
    windowMinutes: patch.windowMinutes ?? existing.windowMinutes,
  };
  assertValidRule(ruleOf(merged));
  if (merged.startDate < dateColumnToISO(existing.startDate)) {
    throw new RecurrenceError('A successor effectiveDate cannot precede its assignment.');
  }
  if (patch.assigneeTarget) await assertAssigneeTarget(db, patch.assigneeTarget);

  return runSopTransaction(db, async (tx) => {
    const predecessorEndDate = new Date(businessDateToUtcDate(merged.startDate));
    predecessorEndDate.setUTCDate(predecessorEndDate.getUTCDate() - 1);
    const predecessorHasEffectivePeriod = predecessorEndDate >= existing.startDate;
    const successor = await tx.restaurantSopAssignment.create({
      data: {
        branchId: existing.branchId,
        templateId: existing.templateId,
        ...(patch.assigneeTarget
          ? assigneeTargetColumns(patch.assigneeTarget)
          : {
              assigneeTargetType: existing.assigneeTargetType,
              assigneeStaffProfileId: existing.assigneeStaffProfileId,
              assigneeJobRoleId: existing.assigneeJobRoleId,
            }),
        frequency: merged.frequency,
        interval: merged.interval,
        daysOfWeek: merged.daysOfWeek,
        monthDay: merged.monthDay,
        startDate: businessDateToUtcDate(merged.startDate),
        endDate: merged.endDate ? businessDateToUtcDate(merged.endDate) : null,
        dueTimeMinutes: merged.dueTimeMinutes,
        intervalEndTimeMinutes: merged.intervalEndTimeMinutes,
        windowMinutes: merged.windowMinutes,
        graceMinutes: patch.graceMinutes ?? existing.graceMinutes,
        active: existing.active,
        supersedesAssignmentId: existing.id,
      },
    });
    await tx.restaurantSopAssignment.update({
      where: { id: existing.id },
      data: {
        // Keep a live predecessor visible to the scheduler until the successor's
        // effective date; its bounded date range performs the boundary switch.
        active: existing.active && predecessorHasEffectivePeriod,
        // A same-day revision has no representable predecessor date range. Keep
        // its valid historical bounds while deactivating it instead of writing
        // an end date before its start date.
        endDate: predecessorHasEffectivePeriod
          ? existing.endDate && existing.endDate < predecessorEndDate
            ? existing.endDate
            : predecessorEndDate
          : existing.endDate,
        supersededAt: new Date(),
      },
    });
    return successor;
  });
}

/** Activate/pause an assignment (paused assignments generate no new occurrences). */
export async function setAssignmentActive(db: ScopedDb, id: string, active: boolean) {
  const existing = await db.restaurantSopAssignment.findUnique({
    where: { id },
    select: { id: true, supersededAt: true },
  });
  if (!existing) throw new SopTemplateError(`Assignment ${id} was not found.`, 'NOT_FOUND');
  if (active && existing.supersededAt) {
    throw new SopTemplateError('A superseded assignment cannot be reactivated.', 'INVALID_STATE');
  }
  return db.restaurantSopAssignment.update({ where: { id }, data: { active } });
}

/** List assignments, optionally filtered by branch and/or template. */
export async function listAssignments(
  db: ScopedDb,
  filter: { branchId?: string; templateId?: string } = {}
) {
  return db.restaurantSopAssignment.findMany({
    where: {
      ...(filter.branchId ? { branchId: filter.branchId } : {}),
      ...(filter.templateId ? { templateId: filter.templateId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    include: {
      template: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true, timezone: true } },
    },
  });
}

/** A single assignment with its template and branch. */
export async function getAssignment(db: ScopedDb, id: string) {
  const assignment = await db.restaurantSopAssignment.findUnique({
    where: { id },
    include: {
      template: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true, timezone: true } },
    },
  });
  if (!assignment) throw new SopTemplateError(`Assignment ${id} was not found.`, 'NOT_FOUND');
  return assignment;
}
