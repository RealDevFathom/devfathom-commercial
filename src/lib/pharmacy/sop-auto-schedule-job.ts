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
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { generateAutoPharmacySopOccurrences } from '@/lib/pharmacy/sop-settings';

/**
 * DEV-751 — the recurring trigger behind per-branch automatic scheduling.
 *
 * One job type on the existing restaurant job queue (`restaurant_jobs`, drained
 * by `bun run restaurant:jobs`). It never exists until a manager turns
 * automatic scheduling on for a branch:
 *
 *  - Turning a branch ON appends the setting, ensures the organization's next
 *    hourly slot job, and creates the due procedures for THAT branch now.
 *  - Each slot job creates due procedures for every branch whose latest setting
 *    is ON (`generateAutoPharmacySopOccurrences`). While at least one branch is
 *    ON it ensures the next slot; when none is ON it enqueues nothing, so the
 *    chain stops and the organization carries no recurring job.
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
 * over a window of the branch's current business date minus one day to plus
 * one day, in the branch timezone. Every run therefore already creates
 * tomorrow's procedures, so they exist well before their due time; an hourly
 * run picks up a new schedule, a newly published version or a business-day
 * change within the hour and tolerates many missed runs.
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

/** Deterministic per-organization idempotency key for one slot. */
export function pharmacySopAutoGenerateJobKey(slot: Date): string {
  return `${PHARMACY_SOP_AUTO_GENERATE_JOB}:${pharmacySopAutoGenerateSlot(slot).toISOString()}`;
}

export type EnsureAutoScheduleJobResult = EnqueueResult & { slot: Date };

/**
 * Ensure the organization's job for the next slot after `now` exists (the `db`
 * is already org-scoped). Concurrent ensures of the same slot are serialized
 * on a transaction-scoped advisory lock, so the loser reads the winner's row
 * instead of hitting the unique index inside a request or job transaction; a
 * DUPLICATE_ENQUEUE that still slips through is retried once, as
 * `enqueueInsightRollup` does.
 */
export async function ensurePharmacySopAutoScheduleJob(
  db: ScopedDb,
  input: { now: Date }
): Promise<EnsureAutoScheduleJobResult> {
  const slot = nextPharmacySopAutoGenerateSlot(input.now);
  const key = pharmacySopAutoGenerateJobKey(slot);
  const job = {
    type: PHARMACY_SOP_AUTO_GENERATE_JOB,
    payload: { slot: slot.toISOString() },
    idempotencyKey: key,
    scheduledAt: slot,
  } as const;
  const attempt = () =>
    runSchedulerTransaction(db, async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
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
 * hourly run to retry it), then create the due procedures for THIS branch only.
 */
export async function startPharmacySopAutoSchedule(
  db: ScopedDb,
  input: { sopBranchId: string; now: Date }
): Promise<StartAutoScheduleResult> {
  const job = await ensurePharmacySopAutoScheduleJob(db, { now: input.now });
  const generated = await generateDueSopOccurrences(db, {
    now: input.now,
    branchIds: [input.sopBranchId],
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

/**
 * The registered handler. Runs in the job's own organization (the worker opens
 * the tenant RLS context). The generation instant is the claim instant
 * (`job.startedAt`, the worker tick's clock), so a late worker generates for
 * the present and schedules the next slot after it rather than replaying every
 * missed hour. In an organization with no pharmacy SOP site (a restaurant) no
 * branch is ON, so it creates nothing and does not re-enqueue.
 */
export const pharmacySopAutoGenerateHandler: RestaurantJobHandler = async ({ db, job }) => {
  parsePharmacySopAutoGeneratePayload(job.payload);
  const now = job.startedAt;
  const result = await generateAutoPharmacySopOccurrences(db, { now });
  if (result.pharmacyBranchIds.length > 0) {
    await ensurePharmacySopAutoScheduleJob(db, { now });
  }
};
