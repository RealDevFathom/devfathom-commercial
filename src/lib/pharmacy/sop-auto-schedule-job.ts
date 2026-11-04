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
import {
  PHARMACY_SOP_AUTO_LOOKBACK_DAYS,
  generateAutoPharmacySopBranchOccurrences,
  pharmacySopAutoScheduledBranchIds,
} from '@/lib/pharmacy/sop-settings';

/**
 * DEV-751 — the background jobs behind per-branch automatic scheduling.
 *
 * Two job types on the existing restaurant job queue (`restaurant_jobs`,
 * drained by `bun run restaurant:jobs`). Neither exists until a manager turns
 * automatic scheduling on for a branch:
 *
 *  - Turning a branch ON appends the setting, ensures the organization's next
 *    hourly slot job, and creates the due procedures for THAT branch now.
 *  - Each hourly slot job (`pharmacy.sop.autoGenerate`, the parent) reads the
 *    settings. When no branch is ON it does nothing, so the chain stops and the
 *    organization carries no recurring job. Otherwise it ensures the next slot
 *    and enqueues one per-branch job (`pharmacy.sop.autoGenerateBranch`, the
 *    child) for each ON branch, then commits. It never generates anything.
 *  - Each child re-reads its branch's site and setting (now OFF or gone → it
 *    does nothing) and creates that branch's due procedures.
 *  - Turning a branch OFF only appends the setting; the next slot sees it.
 *
 * ONE CONNECTION PER HANDLER. The worker runs every handler inside one tenant
 * transaction (`withTenantDb`, 30 s) and passes it as `db`. Both handlers use
 * that `db` and nothing else: no second client, no `createTenantDb`, no other
 * pooled connection while the worker's transaction is open (the platform rule
 * in `scoped-db.ts`: never compete with an owning transaction for a pool
 * connection or its locks). The parent commits quickly (a settings read and a
 * few queue inserts), so the next slot and the children are durable together.
 *
 * FAILURE IS PER BRANCH. A child that throws (a broken assignment, a database
 * error, its own 30 s timeout) rolls back only its own branch's work and is
 * retried by the scheduler with backoff, ending DEAD after `maxAttempts`, for
 * that branch only. The other branches are separate jobs, and the next slot was
 * already committed by the parent, so the chain continues and the next slot
 * enqueues a fresh child for the failed branch.
 *
 * Keys are deterministic and deduplicated per organization by the scheduler's
 * unique (organizationId, idempotencyKey): the parent's is
 * `pharmacy.sop.autoGenerate:<slot ISO>` (floored to the hour), a child's
 * `pharmacy.sop.autoGenerateBranch:<pharmacyBranchId>:<slot ISO>`. Toggling
 * repeatedly, two concurrent enables or a retried parent never create a second
 * job. Generation itself is idempotent (deterministic occurrence ids +
 * unique(assignmentId, dueAt)), so a child that runs twice creates nothing the
 * second time.
 *
 * Hourly is enough: the engine materialises each assignment's configured times
 * over the branch's current business date and the next one, in the branch
 * timezone (no lookback: `PHARMACY_SOP_AUTO_LOOKBACK_DAYS`, so turning a branch
 * ON never back-dates procedures for days it was OFF). Every run therefore
 * already creates tomorrow's procedures, so they exist well before their due
 * time; an hourly run picks up a new schedule, a newly published version or a
 * business-day change within the hour and tolerates many missed runs.
 *
 * These jobs only create procedures. They never escalate, sweep late or missed
 * work, enqueue any other job type, or touch a pharmacy operation table.
 * Procedures never block pharmacy work.
 */

/** The parent (hourly slot) job type, registered in job-handlers.ts. */
export const PHARMACY_SOP_AUTO_GENERATE_JOB = 'pharmacy.sop.autoGenerate';

/** The per-branch child job type, registered in job-handlers.ts. */
export const PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB = 'pharmacy.sop.autoGenerateBranch';

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

/** The organization id shape `scoped-db.ts` accepts. */
const ORGANIZATION_ID = /^[a-zA-Z0-9_-]{3,128}$/;

/** A pharmacy branch id as stored: non-empty, no whitespace, no key separator. */
const PHARMACY_BRANCH_ID = /^[^\s:]{1,191}$/;

/**
 * Deterministic idempotency key for one branch's child job of one slot (per
 * organization, like the slot key). A missing or malformed branch fails closed.
 */
export function pharmacySopAutoGenerateBranchJobKey(pharmacyBranchId: string, slot: Date): string {
  if (typeof pharmacyBranchId !== 'string' || !PHARMACY_BRANCH_ID.test(pharmacyBranchId)) {
    throw new TypeError('A pharmacy branch is required to schedule automatic SOP generation.');
  }
  return `${PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB}:${pharmacyBranchId}:${pharmacySopAutoGenerateSlot(slot).toISOString()}`;
}

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
 * Ensure the organization's job for the next slot after `now` exists, on the
 * caller's `db` only (already org-scoped to `organizationId`). Concurrent
 * ensures of the same slot in the same organization (a manager turning a
 * branch ON while the worker runs the current slot) are serialized on a
 * transaction-scoped advisory lock (`pharmacySopAutoGenerateLockKey`), so the
 * loser waits for the winner to commit and then reads its row instead of
 * hitting the unique index, which would abort the loser's whole transaction.
 * The lock is held until the caller's transaction ends.
 */
export async function ensurePharmacySopAutoScheduleJob(
  db: ScopedDb,
  input: { organizationId: string; now: Date }
): Promise<EnsureAutoScheduleJobResult> {
  const slot = nextPharmacySopAutoGenerateSlot(input.now);
  const lockKey = pharmacySopAutoGenerateLockKey(input.organizationId, slot);
  const job = {
    type: PHARMACY_SOP_AUTO_GENERATE_JOB,
    payload: { slot: slot.toISOString() },
    idempotencyKey: pharmacySopAutoGenerateJobKey(slot),
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
    // A lost unique-index race is retried once to observe the winner, as
    // `enqueueInsightRollup` does. That only helps on a client whose operations
    // commit separately; inside one interactive transaction (a worker handler
    // or a request) the violation has already aborted it, the retry fails too
    // and the owner retries the whole unit. The lock makes the race rare.
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
 * recurring job, then create the due procedures for THIS branch only, from its
 * current business date (never back-dated to days it was OFF). Everything runs
 * on the caller's `db` and nothing else. The tRPC route passes its own request
 * transaction, so the setting, the next slot and today's work commit (or roll
 * back) together; a caller with a per-operation client commits each step on
 * its own, the next slot first.
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

/** An ISO instant aligned to the hourly cadence. */
const SLOT = z
  .string()
  .datetime()
  .refine(
    (value) => Date.parse(value) % PHARMACY_SOP_AUTO_GENERATE_CADENCE_MS === 0,
    'The slot must be aligned to the hourly cadence.'
  );

/** Strict parent payload: the slot this job was enqueued for. */
const AUTO_GENERATE_PAYLOAD = z.object({ slot: SLOT }).strict();

/** Strict child payload: the parent's slot and ONE pharmacy branch. */
const AUTO_GENERATE_BRANCH_PAYLOAD = z
  .object({ slot: SLOT, pharmacyBranchId: z.string().regex(PHARMACY_BRANCH_ID) })
  .strict();

export type PharmacySopAutoGeneratePayload = z.infer<typeof AUTO_GENERATE_PAYLOAD>;
export type PharmacySopAutoGenerateBranchPayload = z.infer<typeof AUTO_GENERATE_BRANCH_PAYLOAD>;

export function parsePharmacySopAutoGeneratePayload(
  payload: unknown
): PharmacySopAutoGeneratePayload {
  return AUTO_GENERATE_PAYLOAD.parse(payload);
}

export function parsePharmacySopAutoGenerateBranchPayload(
  payload: unknown
): PharmacySopAutoGenerateBranchPayload {
  return AUTO_GENERATE_BRANCH_PAYLOAD.parse(payload);
}

/**
 * The parent (hourly slot) handler. Runs in the job's own organization on the
 * worker's handler transaction `db` and nothing else. The instant is the claim
 * instant (`job.startedAt`, the worker tick's clock), so a late worker
 * schedules the slot after the present rather than replaying every missed hour.
 *
 * Settings first (no branch ON → nothing, so the chain stops, e.g. in a
 * restaurant organization with no pharmacy SOP site); then the next slot; then
 * one child per ON branch, due now and keyed by this job's slot. All of it is
 * a handful of queue writes that commit together with the job: a throw rolls
 * all of them back and the scheduler retries the parent.
 */
export const pharmacySopAutoGenerateHandler: RestaurantJobHandler = async ({ db, job }) => {
  const { slot } = parsePharmacySopAutoGeneratePayload(job.payload);
  const now = job.startedAt;
  const pharmacyBranchIds = await pharmacySopAutoScheduledBranchIds(db);
  if (pharmacyBranchIds.length === 0) return;

  // The ensure's slot lock is held until this transaction ends, so a duplicate
  // run of this parent (same next slot) waits here and then deduplicates every
  // child below instead of racing it. A race that still loses the unique index
  // throws DUPLICATE_ENQUEUE, which fails this attempt; its retry deduplicates.
  await ensurePharmacySopAutoScheduleJob(db, { organizationId: job.organizationId, now });
  for (const pharmacyBranchId of pharmacyBranchIds) {
    await enqueue(
      db,
      {
        type: PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB,
        payload: { slot, pharmacyBranchId },
        idempotencyKey: pharmacySopAutoGenerateBranchJobKey(pharmacyBranchId, new Date(slot)),
        scheduledAt: now,
      },
      now
    );
  }
};

/**
 * The per-branch child handler. Runs in the job's own organization on the
 * worker's handler transaction `db` and nothing else, as of the claim instant.
 * Re-reads the branch's site and latest setting: a branch turned OFF since the
 * parent ran, or a site that is gone (or belongs to another organization, which
 * RLS hides), succeeds without doing anything. Otherwise it creates the
 * branch's due procedures; a failure throws, so the scheduler retries this
 * branch alone and records it DEAD after `maxAttempts`.
 */
export const pharmacySopAutoGenerateBranchHandler: RestaurantJobHandler = async ({ db, job }) => {
  const { pharmacyBranchId } = parsePharmacySopAutoGenerateBranchPayload(job.payload);
  await generateAutoPharmacySopBranchOccurrences(db, { pharmacyBranchId, now: job.startedAt });
};
