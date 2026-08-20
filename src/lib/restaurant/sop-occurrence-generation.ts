import 'server-only';

import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { RestaurantJobHandler } from '@/lib/restaurant/job-handlers';
import { businessDateToUtcDate, resolveBusinessDate } from '@/lib/restaurant/business-date';
import {
  type RecurrenceRule,
  enumerateOccurrences,
} from '@/lib/restaurant/sop-recurrence';
import { resolveLatestPublishedVersion } from '@/lib/restaurant/sop-templates';

/**
 * M7-L3 / §SOP — SOP occurrence generation (a scheduler handler, M7-L1/D13).
 *
 * For every active assignment this materialises the concrete occurrences due in a
 * small window around the branch's CURRENT business date, in the branch timezone.
 * Two properties matter:
 *
 *  - WINDOW-IDEMPOTENT. Re-running over the same window creates ZERO duplicates.
 *    The occurrence table's `unique(assignmentId, businessDate)` is the guarantee;
 *    this handler additionally pre-filters already-materialised business dates so
 *    the steady state does no write work, and swallows the unique-violation a
 *    concurrent generator would otherwise race into (at-least-once execution, D13).
 *
 *  - VERSION-PINNED. Each occurrence pins `templateVersionId` to the template's
 *    LATEST PUBLISHED version resolved AT GENERATION TIME. A later publish never
 *    rewrites an already-generated occurrence; a template with no published
 *    version schedules nothing.
 *
 * The occurrence's per-step checklist is seeded from the pinned version's steps so
 * the execution surface (M7-L4) has an immutable snapshot to complete against.
 */

/** The `RestaurantJob.type` this handler is registered under (job-handlers.ts). */
export const SOP_GENERATE_OCCURRENCES_JOB = 'sop.generateOccurrences';

/**
 * §4 conservative defaults. Backfill one just-past business date so a briefly
 * missed generation run can still be swept LATE/MISSED, and materialise one day
 * ahead so the admin console can preview the immediate schedule. Both are bounded
 * and overridable via the job payload.
 */
export const GENERATION_LOOKBACK_DAYS = 1;
export const GENERATION_HORIZON_DAYS = 1;

export type GenerateOptions = {
  /** The generation "as-of" instant (defaults to now); injected for determinism. */
  now?: Date;
  lookbackDays?: number;
  horizonDays?: number;
};

export type GenerateResult = {
  assignmentsProcessed: number;
  created: number;
  skipped: number;
};

const DAY_MS = 86_400_000;

/** Format a `@db.Date` column value (UTC midnight) as a `YYYY-MM-DD` string. */
function dateColumnToISO(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Build a recurrence rule from an assignment row (its `@db.Date` fields → ISO). */
function ruleFromAssignment(assignment: {
  frequency: RecurrenceRule['frequency'];
  interval: number;
  daysOfWeek: number[];
  monthDay: number | null;
  startDate: Date;
  endDate: Date | null;
  dueTimeMinutes: number;
  windowMinutes: number;
}): RecurrenceRule {
  return {
    frequency: assignment.frequency,
    interval: assignment.interval,
    daysOfWeek: assignment.daysOfWeek,
    monthDay: assignment.monthDay,
    startDate: dateColumnToISO(assignment.startDate),
    endDate: assignment.endDate ? dateColumnToISO(assignment.endDate) : null,
    dueTimeMinutes: assignment.dueTimeMinutes,
    windowMinutes: assignment.windowMinutes,
  };
}

/**
 * Generate the due occurrences for every active assignment in the current tenant
 * (the `db` is already org-scoped). Idempotent; safe to re-run.
 */
export async function generateDueSopOccurrences(
  db: ScopedDb,
  opts: GenerateOptions = {}
): Promise<GenerateResult> {
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? GENERATION_LOOKBACK_DAYS;
  const horizonDays = opts.horizonDays ?? GENERATION_HORIZON_DAYS;
  if (!Number.isInteger(lookbackDays) || lookbackDays < 0) {
    throw new TypeError('lookbackDays must be a non-negative integer.');
  }
  if (!Number.isInteger(horizonDays) || horizonDays < 0) {
    throw new TypeError('horizonDays must be a non-negative integer.');
  }

  const assignments = await db.restaurantSopAssignment.findMany({
    where: { active: true },
    include: {
      branch: { select: { id: true, timezone: true, businessDayCutoff: true } },
    },
  });

  const result: GenerateResult = { assignmentsProcessed: 0, created: 0, skipped: 0 };

  for (const assignment of assignments) {
    result.assignmentsProcessed += 1;

    // Pin the template version ONCE per assignment — the latest PUBLISHED at this
    // generation instant. No published version → nothing to schedule.
    const version = await resolveLatestPublishedVersion(db, assignment.templateId);
    if (!version) continue;

    const { timezone, businessDayCutoff } = assignment.branch;
    const currentBusinessDate = resolveBusinessDate(now, timezone, businessDayCutoff);
    const base = businessDateToUtcDate(currentBusinessDate);
    const windowStartISO = dateColumnToISO(addUtcDays(base, -lookbackDays));
    const windowEndISO = dateColumnToISO(addUtcDays(base, horizonDays));

    const occurrences = enumerateOccurrences(
      ruleFromAssignment(assignment),
      timezone,
      windowStartISO,
      windowEndISO
    );
    if (occurrences.length === 0) continue;

    // Pre-filter already-materialised business dates for this assignment.
    const existing = await db.restaurantSopOccurrence.findMany({
      where: {
        assignmentId: assignment.id,
        businessDate: {
          gte: businessDateToUtcDate(windowStartISO),
          lte: businessDateToUtcDate(windowEndISO),
        },
      },
      select: { businessDate: true },
    });
    const existingDates = new Set(existing.map((row) => dateColumnToISO(row.businessDate)));

    const missing = occurrences.filter((occ) => !existingDates.has(occ.businessDate));
    if (missing.length === 0) continue;

    // Seed each occurrence's checklist from the pinned version's steps.
    const versionSteps = await db.restaurantSopTemplateStep.findMany({
      where: { templateVersionId: version.id },
      orderBy: { stepOrder: 'asc' },
      select: { id: true },
    });

    for (const occ of missing) {
      try {
        await runOccurrenceTransaction(db, (tx) =>
          tx.restaurantSopOccurrence.create({
            data: {
              assignmentId: assignment.id,
              templateVersionId: version.id,
              branchId: assignment.branchId,
              businessDate: businessDateToUtcDate(occ.businessDate),
              status: 'SCHEDULED',
              dueAt: occ.dueAt,
              windowEndsAt: occ.windowEndsAt,
              steps: {
                create: versionSteps.map((step) => ({ templateStepId: step.id })),
              },
            },
          })
        );
        result.created += 1;
      } catch (error) {
        // A concurrent generator won the unique(assignmentId, businessDate) race:
        // the occurrence already exists, which is exactly the idempotent outcome.
        if (isUniqueViolation(error)) {
          result.skipped += 1;
          continue;
        }
        throw error;
      }
    }
  }

  return result;
}

function runOccurrenceTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

/** Strict payload for the scheduler job — unknown keys rejected (D13 boundary). */
const GENERATE_PAYLOAD = z
  .object({
    now: z.string().datetime().optional(),
    lookbackDays: z.number().int().min(0).max(31).optional(),
    horizonDays: z.number().int().min(0).max(31).optional(),
  })
  .strict();

/**
 * The registered scheduler handler. Validates its opaque payload with strict zod,
 * then generates due occurrences in the job's (already org-scoped) tenant context.
 * Idempotent: a retry re-runs harmlessly.
 */
export const generateSopOccurrencesHandler: RestaurantJobHandler = async ({ db, job }) => {
  const payload = GENERATE_PAYLOAD.parse(job.payload ?? {});
  await generateDueSopOccurrences(db, {
    now: payload.now ? new Date(payload.now) : undefined,
    lookbackDays: payload.lookbackDays,
    horizonDays: payload.horizonDays,
  });
};
