import 'server-only';

import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import type { RestaurantJobHandler } from '@/lib/restaurant/job-handlers-core';
import {
  generateDueSopOccurrences,
  type GenerateResult,
} from '@/lib/restaurant/sop-occurrence-generation';
import {
  SchedulerError,
  enqueue,
  runSchedulerTransaction,
  type EnqueueResult,
} from '@/lib/restaurant/scheduler';
import { createTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  PHARMACY_SOP_AUTO_LOOKBACK_DAYS,
  generateAutoPharmacySopOccurrences,
  type AutoGenerationFailure,
} from '@/lib/pharmacy/sop-settings';

/**
 * DEV-751 — the recurring trigger behind per-branch automatic scheduling.
 *
 * One job type on the existing restaurant job queue (`restaurant_jobs`, drained
 * by `bun run restaurant:jobs`). It never exists until a manager turns
 * automatic scheduling on for a branch:
 *
 *  - Turning a branch ON appends the setting, ensures the organization's next
 *    hourly slot job, and creates the due procedures for THAT branch now.
 *  - Each slot job reads the settings first. While at least one branch is ON it
 *    ensures the next slot BEFORE generating, in its own committed transaction,
 *    then creates due procedures for each ON branch separately
 *    (`generateAutoPharmacySopOccurrences`). A failing branch fails the job
 *    (visible, retried) without stopping the other branches or the chain. When
 *    none is ON it enqueues nothing, so the chain stops and the organization
 *    carries no recurring job.
 *  - Turning a branch OFF only appends the setting; the next slot sees it.
 *
 * Slots are deterministic (`pharmacy.sop.autoGenerate:<slot ISO>`, floored to
 * the hour) and deduplicated per organization by the scheduler's idempotency
 * key, so toggling repeatedly, two concurrent enables or a retried job never
 * create a second job for the same slot. Generation itself is idempotent
 * (deterministic occurrence ids + unique(assignmentId, dueAt)), so a slot that
 * runs twice creates nothing the second time.
 *
 * Hourly is enough: the engine materialises each assignment's configured times
 * over the branch's current business date and the next one, in the branch
 * timezone (no lookback: `PHARMACY_SOP_AUTO_LOOKBACK_DAYS`, so turning a branch
 * ON never back-dates procedures for days it was OFF). Every run therefore
 * already creates tomorrow's procedures, so they exist well before their due
 * time; an hourly run picks up a new schedule, a newly published version or a
 * business-day change within the hour and tolerates many missed runs.
 *
 * This job only creates procedures. It never escalates, sweeps late or missed
 * work, enqueues any other job type, or touches a pharmacy operation table.
 * Procedures never block pharmacy work.
 */

/** The `RestaurantJob.type` this handler is registered under (job-handlers.ts). */
export const PHARMACY_SOP_AUTO_GENERATE_JOB = 'pharmacy.sop.autoGenerate';

/** One run per organization per hour while any branch is ON. */
export const PHARMACY_SOP_AUTO_GENERATE_CADENCE_MS = 60 * 60_000;

/** The slot `now` falls in (floored to the cadence, UTC). */
export function pharmacySopAutoGenerateSlot(now: Date): Date {
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new RangeError('A valid instant is required.');
  return new Date(
    Math.floor(time / PHARMACY_SOP_AUTO_GENERATE_CADENCE_MS) * PHARMACY_SOP_AUTO_GENERATE_CADENCE_MS
  );
}

/** The first slot strictly after the one `now` falls in. */
export function nextPharmacySopAutoGenerateSlot(now: Date): Date {
  return new Date(
    pharmacySopAutoGenerateSlot(now).getTime() + PHARMACY_SOP_AUTO_GENERATE_CADENCE_MS
  );
}

/**
 * Deterministic idempotency key for one slot. It carries no organization: the
 * scheduler's unique index is per organization (`organizationId,
 * idempotencyKey`), so it already deduplicates per tenant.
 */
export function pharmacySopAutoGenerateJobKey(slot: Date): string {
  return `${PHARMACY_SOP_AUTO_GENERATE_JOB}:${pharmacySopAutoGenerateSlot(slot).toISOString()}`;
}

const ORGANIZATION_ID = /^[a-zA-Z0-9_-]{3,128}$/;

/**
 * The advisory lock serializing ensures of one slot in ONE organization. Unlike
 * the idempotency key it must name the organization: advisory locks are
 * database-wide, so a key without it would make every tenant's ensure of the
 * same hour wait on one lock. The organization is passed explicitly (never
 * read back from the session GUC); a missing or malformed one fails closed.
 */
export function pharmacySopAutoGenerateLockKey(organizationId: string, slot: Date): string {
  if (typeof organizationId !== 'string' || !ORGANIZATION_ID.test(organizationId)) {
    throw new TypeError('An organization is required to schedule automatic SOP generation.');
  }
  return `${PHARMACY_SOP_AUTO_GENERATE_JOB}:${organizationId}:${pharmacySopAutoGenerateSlot(slot).toISOString()}`;
}

export type EnsureAutoScheduleJobResult = EnqueueResult & { slot: Date };

/**
 * Ensure the organization's job for the next slot after `now` exists (the `db`
 * is already org-scoped to `organizationId`). Concurrent ensures of the same
 * slot in the same organization are serialized on a transaction-scoped
 * advisory lock (`pharmacySopAutoGenerateLockKey`), so the loser reads the winner's row
 * instead of hitting the unique index inside a request or job transaction; a
 * DUPLICATE_ENQUEUE that still slips through is retried once, as
 * `enqueueInsightRollup` does.
 */
export async function ensurePharmacySopAutoScheduleJob(
  db: ScopedDb,
  input: { organizationId: string; now: Date }
): Promise<EnsureAutoScheduleJobResult> {
  const slot = nextPharmacySopAutoGenerateSlot(input.now);
  const key = pharmacySopAutoGenerateJobKey(slot);
  const lockKey = pharmacySopAutoGenerateLockKey(input.organizationId, slot);
  const job = {
    type: PHARMACY_SOP_AUTO_GENERATE_JOB,
    payload: { slot: slot.toISOString() },
    idempotencyKey: key,
    scheduledAt: slot,
  } as const;
  const attempt = () =>
    runSchedulerTransaction(db, async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      return enqueue(tx, job, input.now);
    });
  try {
    return { ...(await attempt()), slot };
  } catch (error) {
    if (error instanceof SchedulerError && error.reason === 'DUPLICATE_ENQUEUE') {
      return { ...(await attempt()), slot };
    }
    throw error;
  }
}

export type StartAutoScheduleResult = {
  job: EnsureAutoScheduleJobResult;
  generated: GenerateResult;
};

/**
 * What turning a branch ON does once its setting row is appended: ensure the
 * recurring job first (so a failure creating today's work still leaves the
 * hourly run to retry it), then create the due procedures for THIS branch only,
 * from its current business date (never back-dated to days it was OFF).
 */
export async function startPharmacySopAutoSchedule(
  db: ScopedDb,
  input: { organizationId: string; sopBranchId: string; now: Date }
): Promise<StartAutoScheduleResult> {
  const job = await ensurePharmacySopAutoScheduleJob(db, {
    organizationId: input.organizationId,
    now: input.now,
  });
  const generated = await generateDueSopOccurrences(db, {
    now: input.now,
    branchIds: [input.sopBranchId],
    lookbackDays: PHARMACY_SOP_AUTO_LOOKBACK_DAYS,
  });
  return { job, generated };
}

/** Strict payload: the slot this job was enqueued for, aligned to the cadence. */
const AUTO_GENERATE_PAYLOAD = z
  .object({
    slot: z
      .string()
      .datetime()
      .refine(
        (value) => Date.parse(value) % PHARMACY_SOP_AUTO_GENERATE_CADENCE_MS === 0,
        'The slot must be aligned to the hourly cadence.'
      ),
  })
  .strict();

export type PharmacySopAutoGeneratePayload = z.infer<typeof AUTO_GENERATE_PAYLOAD>;

export function parsePharmacySopAutoGeneratePayload(
  payload: unknown
): PharmacySopAutoGeneratePayload {
  return AUTO_GENERATE_PAYLOAD.parse(payload);
}

/** A slot run in which at least one ON branch failed; the next slot already exists. */
export class PharmacySopAutoGenerateError extends Error {
  readonly failures: readonly AutoGenerationFailure[];

  constructor(failures: readonly AutoGenerationFailure[]) {
    const detail = failures
      .map(({ pharmacyBranchId, error }) => {
        const reason =
          error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'error';
        return `${pharmacyBranchId} (${reason})`;
      })
      .join(', ');
    super(`Automatic SOP scheduling failed for ${failures.length} branch(es): ${detail}.`, {
      cause: failures[0]?.error,
    });
    this.name = 'PharmacySopAutoGenerateError';
    this.failures = failures;
  }
}

export type PharmacySopAutoGenerateHandlerDeps = {
  /**
   * An org-scoped client whose every operation commits in its own tenant
   * transaction (`createTenantDb`), independent of the worker's handler
   * transaction.
   */
  independentTenantDb: (organizationId: string) => ScopedDb;
};

/**
 * The handler, with its independent-client seam. Runs in the job's own
 * organization (the worker opens the tenant RLS context and passes `db`, one
 * interactive transaction bounded by `withTenantDb`'s 30 s timeout). The
 * generation instant is the claim instant (`job.startedAt`, the worker tick's
 * clock), so a late worker generates for the present and schedules the next
 * slot after it rather than replaying every missed hour.
 *
 * Order matters: settings first (on `db`; no branch ON → no job and no
 * generation, so the chain stops, e.g. in a restaurant organization with no
 * pharmacy SOP site); then the next slot; then generation per ON branch. The
 * next slot and the generation run on an INDEPENDENT tenant client, so:
 *
 *  - the next slot is committed before any generation starts: a throw, a
 *    retry that ends DEAD, or the handler transaction timing out can no longer
 *    roll it back and silently stop the chain while the setting says ON;
 *  - every engine write commits on its own, so a large run is not capped or
 *    rolled back by the handler transaction's 30 s timeout (a run that outlives
 *    it fails the job only after its work is committed; the retry finds
 *    nothing left to create), and one branch's database error cannot abort the
 *    others' work as it would inside one Postgres transaction.
 *
 * When any branch failed the job still throws (after the other branches ran),
 * so the failure is recorded on the job and retried; retries are idempotent
 * (deduplicated slot, deterministic occurrence ids).
 */
export function createPharmacySopAutoGenerateHandler(
  deps: PharmacySopAutoGenerateHandlerDeps
): RestaurantJobHandler {
  return async ({ db, job }) => {
    parsePharmacySopAutoGeneratePayload(job.payload);
    const { organizationId } = job;
    const now = job.startedAt;
    // A lazy proxy: no connection is used unless a branch is ON.
    const independent = deps.independentTenantDb(organizationId);
    const result = await generateAutoPharmacySopOccurrences(db, {
      now,
      generationDb: independent,
      beforeGenerate: () => ensurePharmacySopAutoScheduleJob(independent, { organizationId, now }),
    });
    if (result.failures.length > 0) throw new PharmacySopAutoGenerateError(result.failures);
  };
}

/** The registered handler (job-handlers.ts). */
export const pharmacySopAutoGenerateHandler = createPharmacySopAutoGenerateHandler({
  independentTenantDb: (organizationId) => createTenantDb(organizationId),
});
