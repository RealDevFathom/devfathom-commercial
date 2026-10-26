import 'server-only';

import { randomUUID } from 'node:crypto';

import { Prisma, type RestaurantJob } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M7-L1 / §11.5 / D13 — the restaurant scheduler primitive. The single durable
 * work-queue path over `restaurant_jobs` (org-scoped, forced RLS) with an
 * APPEND-ONLY execution history (`restaurant_job_executions`, DB-enforced
 * SELECT+INSERT only). Every M7 background flow (SOP occurrence generation,
 * late/missed sweeps, escalation firing, notification fan-out, webhook
 * processing) enqueues a job and registers a handler in job-handlers.ts; a
 * worker drains due jobs through `claimNextDue` → handler → `complete`/`fail`.
 *
 * D13 conservative defaults this module enforces (recorded in BUILD-ASSUMPTIONS):
 *   - At-least-once, exactly-one-in-flight. A due QUEUED job is claimed with
 *     `SELECT … FOR UPDATE SKIP LOCKED` inside ONE tenant-scoped transaction, so
 *     N parallel claimers over M due jobs each take a DISTINCT job — never the
 *     same one twice, never a lost job. Handlers must be idempotent (a job may
 *     run more than once across retries / worker crashes).
 *   - Org-scoped claim inside the target org's RLS context. There is NO
 *     cross-org queue scan in the app role: a claimer runs inside `withTenantDb`
 *     so RLS restricts visible jobs to the current organization; a privileged
 *     multi-org worker still executes each job inside its target org's RLS
 *     context (never a bypass-RLS mutation of tenant rows).
 *   - Bounded retries with exponential backoff → DEAD. A failed attempt appends
 *     one immutable execution row and either re-queues with backoff (while
 *     `attempts < maxAttempts`) or moves the job to DEAD. A handler may declare a
 *     failure permanent (non-retryable) → FAILED, skipping the remaining budget.
 *   - Injectable clock. Every time decision (due filter, backoff schedule,
 *     lease expiry) flows from an explicit `now`/`clock`, never a hidden
 *     `Date.now()`, so the concurrency battery and unit tests are deterministic.
 *
 * Plumbing mirrors inventory-ledger.ts / drawer-sessions.ts: functions take the
 * request-scoped `db` and open one tenant-scoped interactive transaction whose
 * forced RLS binds the tenant; the worker loop opens a FRESH transaction per
 * claim/settle (separate pooled connections = true concurrency).
 */

/** Terminal + transient job states (mirrors the Prisma enum). */
export type RestaurantJobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD';

/** The result of settling one failed attempt. */
export type FailOutcome = 'retried' | 'dead' | 'failed';

/** A server clock; injectable so tests and the battery are deterministic. */
export type Clock = () => Date;

export const DEMO_RESET_JOB_TYPE = 'demo-reset';

export const DEFAULT_MAX_ATTEMPTS = 5;
/** First-retry delay; doubles per prior attempt, capped by RETRY_CAP_MS. */
export const RETRY_BASE_MS = 30_000;
export const RETRY_CAP_MS = 30 * 60_000;
/** A RUNNING job older than this lease is considered abandoned (worker crash). */
export const DEFAULT_LEASE_MS = 15 * 60_000;

export type SchedulerErrorReason =
  | 'INVALID'
  | 'JOB_NOT_FOUND'
  | 'INVALID_STATE'
  | 'DUPLICATE_ENQUEUE';

export class SchedulerError extends Error {
  constructor(
    message: string,
    readonly reason: SchedulerErrorReason
  ) {
    super(message);
    this.name = 'SchedulerError';
  }
}

/** Exponential backoff (ms) for the Nth attempt just failed: base·2^(attempts-1),
 * capped. `attempts` is the post-increment count on the job (>= 1). */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_CAP_MS);
}

/** The next-attempt instant for a job whose current attempt just failed. */
export function nextRetryAt(attempts: number, now: Date): Date {
  return new Date(now.getTime() + backoffMs(attempts));
}

export type EnqueueInput = {
  type: string;
  payload?: Prisma.InputJsonValue;
  /** Deduplicates within the organization; a null/omitted key is never deduped. */
  idempotencyKey?: string | null;
  /** When the job first becomes due (defaults to `now`). */
  scheduledAt?: Date;
  maxAttempts?: number;
};

export type EnqueueResult = {
  job: RestaurantJob;
  /** True iff an existing job with the same (organization, idempotencyKey) was
   * returned and nothing new was created. */
  deduplicated: boolean;
};

/**
 * Enqueue a durable job. With an `idempotencyKey`, a prior job for the same
 * (organization, key) is returned unchanged (`deduplicated: true`) and nothing
 * is created; a concurrent duplicate that loses the unique-index race fails
 * closed with `DUPLICATE_ENQUEUE` (the caller retries and observes the winner).
 */
export async function enqueue(
  db: ScopedDb,
  input: EnqueueInput,
  now: Date = new Date()
): Promise<EnqueueResult> {
  const type = input.type?.trim();
  if (!type) {
    throw new SchedulerError('enqueue requires a non-empty job type.', 'INVALID');
  }
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new SchedulerError('maxAttempts must be an integer >= 1.', 'INVALID');
  }
  const scheduledAt = input.scheduledAt ?? now;
  const key = input.idempotencyKey ?? null;

  return runSchedulerTransaction(db, async (tx) => {
    if (key) {
      const existing = await tx.restaurantJob.findFirst({ where: { idempotencyKey: key } });
      if (existing) return { job: existing, deduplicated: true };
    }
    try {
      const job = await tx.restaurantJob.create({
        data: {
          type,
          payload: input.payload ?? {},
          status: 'QUEUED',
          attempts: 0,
          maxAttempts,
          scheduledAt,
          nextAttemptAt: scheduledAt,
          idempotencyKey: key,
        },
      });
      return { job, deduplicated: false };
    } catch (error) {
      if (key && isUniqueViolation(error)) {
        throw new SchedulerError(
          `A job with idempotency key "${key}" already exists.`,
          'DUPLICATE_ENQUEUE'
        );
      }
      throw error;
    }
  });
}

export type ClaimOptions = {
  /** Identifies the claimer; recorded on the job and its execution rows. */
  workerId: string;
  now?: Date;
  /** Restricts claims to one registered job type when supplied. */
  jobType?: string;
  /** Excludes one job type when supplied. Mutually exclusive with jobType. */
  excludeJobType?: string;
};

/** A job claimed for execution (already moved to RUNNING; `attempts` incremented). */
export type ClaimedJob = {
  id: string;
  organizationId: string;
  type: string;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
  claimedBy: string;
  /** Unique, non-reusable identity for this specific claim generation. */
  claimToken: string;
  /** The claim instant; also the execution's `startedAt`. */
  startedAt: Date;
};

/**
 * Atomically claim the single most-due QUEUED job with FOR UPDATE SKIP LOCKED
 * and move it to RUNNING (incrementing `attempts`, stamping `claimedAt`/
 * `claimedBy`). Returns null when nothing is due. RLS scopes the candidate set
 * to the transaction's organization, so concurrent claimers in one org each take
 * a distinct job and never collide across organizations.
 */
export async function claimNextDue(db: ScopedDb, opts: ClaimOptions): Promise<ClaimedJob | null> {
  const workerId = opts.workerId?.trim();
  if (!workerId) {
    throw new SchedulerError('claimNextDue requires a non-empty workerId.', 'INVALID');
  }
  const jobType = opts.jobType?.trim();
  const excludeJobType = opts.excludeJobType?.trim();
  if (opts.jobType !== undefined && !jobType) {
    throw new SchedulerError('claimNextDue requires a non-empty jobType when supplied.', 'INVALID');
  }
  if (opts.excludeJobType !== undefined && !excludeJobType) {
    throw new SchedulerError(
      'claimNextDue requires a non-empty excludeJobType when supplied.',
      'INVALID'
    );
  }
  if (jobType && excludeJobType) {
    throw new SchedulerError(
      'claimNextDue accepts either jobType or excludeJobType, not both.',
      'INVALID'
    );
  }
  const now = opts.now ?? new Date();
  const claimToken = randomUUID();
  const typeFilter = jobType
    ? Prisma.sql`AND "type" = ${jobType}`
    : excludeJobType
      ? Prisma.sql`AND "type" <> ${excludeJobType}`
      : Prisma.empty;

  return runSchedulerTransaction(db, async (tx) => {
    const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "restaurant_jobs"
      WHERE "status" = 'QUEUED'
        AND "nextAttemptAt" <= ${now}
        ${typeFilter}
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    const id = candidates[0]?.id;
    if (!id) return null;

    const job = await tx.restaurantJob.update({
      where: { id },
      data: {
        status: 'RUNNING',
        attempts: { increment: 1 },
        claimedAt: now,
        claimedBy: workerId,
        claimToken,
        lastError: null,
      },
      select: {
        id: true,
        organizationId: true,
        type: true,
        payload: true,
        attempts: true,
        maxAttempts: true,
        claimedBy: true,
        claimToken: true,
      },
    });
    return {
      id: job.id,
      organizationId: job.organizationId,
      type: job.type,
      payload: job.payload,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      claimedBy: job.claimedBy ?? workerId,
      claimToken: job.claimToken ?? claimToken,
      startedAt: now,
    };
  });
}

export type SettleOptions = {
  /** Must match the worker that owns the current RUNNING claim. */
  workerId: string;
  /** Attempt number returned as `ClaimedJob.attempts`. */
  attempt: number;
  /** Non-reusable token returned by the exact `claimNextDue` call. */
  claimToken: string;
  now?: Date;
};

export type FailSettleOptions = SettleOptions & {
  /** A permanent (non-retryable) failure moves the job straight to FAILED. */
  permanent?: boolean;
};

/**
 * Mark a RUNNING job SUCCEEDED and append its immutable execution row. Throws if
 * the job is missing or is not RUNNING (guards against double-settle).
 */
export async function complete(db: ScopedDb, jobId: string, opts: SettleOptions): Promise<void> {
  const now = opts.now ?? new Date();
  await runSchedulerTransaction(db, async (tx) => {
    const job = await requireRunningClaim(tx, jobId, opts);
    const settled = await tx.restaurantJob.updateMany({
      where: runningClaimWhere(jobId, opts),
      data: { status: 'SUCCEEDED', lastError: null },
    });
    requireClaimUpdate(settled.count, jobId);
    await appendExecution(tx, {
      jobId,
      workerId: opts.workerId,
      attempt: job.attempts,
      startedAt: job.claimedAt ?? now,
      finishedAt: now,
      outcome: 'SUCCEEDED',
      error: null,
    });
  });
}

/**
 * Settle a failed attempt: append the immutable execution row (outcome FAILED),
 * then either re-queue with exponential backoff (`attempts < maxAttempts` and not
 * permanent) → 'retried', move the job to DEAD (bounded retries exhausted) →
 * 'dead', or to FAILED (permanent) → 'failed'. Throws if the job is not RUNNING.
 */
export async function fail(
  db: ScopedDb,
  jobId: string,
  error: unknown,
  opts: FailSettleOptions
): Promise<FailOutcome> {
  const now = opts.now ?? new Date();
  const message = errorMessage(error);
  return runSchedulerTransaction(db, async (tx) => {
    const job = await requireRunningClaim(tx, jobId, opts);

    const permanent = opts.permanent === true;
    let outcome: FailOutcome;
    let data: Prisma.RestaurantJobUpdateManyMutationInput;
    if (!permanent && job.attempts < job.maxAttempts) {
      outcome = 'retried';
      data = {
        status: 'QUEUED',
        nextAttemptAt: nextRetryAt(job.attempts, now),
        claimedAt: null,
        claimedBy: null,
        claimToken: null,
        lastError: message,
      };
    } else {
      outcome = permanent ? 'failed' : 'dead';
      data = { status: permanent ? 'FAILED' : 'DEAD', lastError: message };
    }

    const settled = await tx.restaurantJob.updateMany({
      where: runningClaimWhere(jobId, opts),
      data,
    });
    requireClaimUpdate(settled.count, jobId);
    await appendExecution(tx, {
      jobId,
      workerId: opts.workerId,
      attempt: job.attempts,
      startedAt: job.claimedAt ?? now,
      finishedAt: now,
      outcome: 'FAILED',
      error: message,
    });
    return outcome;
  });
}

/**
 * Requeue jobs stuck RUNNING past the lease (a worker claimed then crashed). The
 * abandoned attempt is NOT recorded as an execution (it never finished); the
 * job's spent attempt still counts against its retry budget, so a crash-looping
 * job eventually reaches DEAD. Returns the number recovered.
 */
export async function recoverStaleJobs(
  db: ScopedDb,
  opts: { now?: Date; leaseMs?: number; jobType?: string; excludeJobType?: string } = {}
): Promise<number> {
  const now = opts.now ?? new Date();
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const jobType = opts.jobType?.trim();
  const excludeJobType = opts.excludeJobType?.trim();
  if (opts.jobType !== undefined && !jobType) {
    throw new SchedulerError(
      'recoverStaleJobs requires a non-empty jobType when supplied.',
      'INVALID'
    );
  }
  if (opts.excludeJobType !== undefined && !excludeJobType) {
    throw new SchedulerError(
      'recoverStaleJobs requires a non-empty excludeJobType when supplied.',
      'INVALID'
    );
  }
  if (jobType && excludeJobType) {
    throw new SchedulerError(
      'recoverStaleJobs accepts either jobType or excludeJobType, not both.',
      'INVALID'
    );
  }
  const cutoff = new Date(now.getTime() - leaseMs);
  const result = await db.restaurantJob.updateMany({
    where: {
      status: 'RUNNING',
      claimedAt: { lt: cutoff },
      ...(jobType && { type: jobType }),
      ...(excludeJobType && { type: { not: excludeJobType } }),
    },
    data: {
      status: 'QUEUED',
      nextAttemptAt: now,
      claimedAt: null,
      claimedBy: null,
      claimToken: null,
      lastError: 'Recovered after the worker lease expired.',
    },
  });
  return result.count;
}

/**
 * Release an in-flight claim back to QUEUED WITHOUT recording a failed attempt
 * (graceful shutdown: the handler never ran). The claim's `attempts` increment is
 * rolled back so the job is fully restored. No-op if the job is not RUNNING.
 */
export async function releaseClaim(
  db: ScopedDb,
  jobId: string,
  opts: { now?: Date } = {}
): Promise<void> {
  const now = opts.now ?? new Date();
  await db.restaurantJob.updateMany({
    where: { id: jobId, status: 'RUNNING' },
    data: {
      status: 'QUEUED',
      nextAttemptAt: now,
      claimedAt: null,
      claimedBy: null,
      claimToken: null,
      attempts: { decrement: 1 },
    },
  });
}

export type DrainOptions = {
  /**
   * Opens a FRESH tenant-scoped transaction per step (typically
   * `(work) => withTenantDb(orgId, work)`), so each claim/settle runs on its own
   * pooled connection — the source of true concurrency between workers.
   */
  runScoped: <T>(work: (db: ScopedDb) => Promise<T>) => Promise<T>;
  workerId: string;
  /** Restricts claims to one registered job type when supplied. */
  jobType?: string;
  /** Excludes one job type when supplied. Mutually exclusive with jobType. */
  excludeJobType?: string;
  /** Runs one claimed job; a throw settles the job through `fail`. */
  handler: (job: ClaimedJob) => Promise<void>;
  /** Aborting stops claiming and releases any just-claimed job (drain + release). */
  signal?: AbortSignal;
  /** Injectable clock (defaults to the system clock). */
  clock?: Clock;
  /** Safety bound on total jobs processed in one drain (defaults to unbounded). */
  maxJobs?: number;
};

export type DrainResult = {
  claimed: number;
  succeeded: number;
  retried: number;
  dead: number;
  failed: number;
  released: number;
};

/**
 * Drain due jobs until none remain, a `maxJobs` bound is hit, or `signal` aborts.
 * Graceful shutdown: on abort the loop stops claiming and releases a
 * just-claimed-but-not-yet-run job back to the queue, so no work is silently
 * dropped mid-flight.
 */
export async function drainDueJobs(options: DrainOptions): Promise<DrainResult> {
  const clock = options.clock ?? (() => new Date());
  const maxJobs = options.maxJobs ?? Number.POSITIVE_INFINITY;
  const result: DrainResult = {
    claimed: 0,
    succeeded: 0,
    retried: 0,
    dead: 0,
    failed: 0,
    released: 0,
  };

  while (result.claimed < maxJobs) {
    if (options.signal?.aborted) break;
    const job = await options.runScoped((db) =>
      claimNextDue(db, {
        workerId: options.workerId,
        now: clock(),
        jobType: options.jobType,
        excludeJobType: options.excludeJobType,
      })
    );
    if (!job) break;
    result.claimed += 1;

    if (options.signal?.aborted) {
      await options.runScoped((db) => releaseClaim(db, job.id, { now: clock() }));
      result.released += 1;
      break;
    }

    try {
      await options.handler(job);
      await options.runScoped((db) =>
        complete(db, job.id, {
          workerId: options.workerId,
          attempt: job.attempts,
          claimToken: job.claimToken,
          now: clock(),
        })
      );
      result.succeeded += 1;
    } catch (error) {
      const outcome = await options.runScoped((db) =>
        fail(db, job.id, error, {
          workerId: options.workerId,
          attempt: job.attempts,
          claimToken: job.claimToken,
          now: clock(),
        })
      );
      result[outcome] += 1;
    }
  }

  return result;
}

/**
 * Open one tenant-scoped interactive transaction. `db` is the request's
 * tenant-scoped proxy whose `$transaction` sets the RLS tenant GUC and hands the
 * callback a nested `ScopedDb`; Prisma types the callback param as the
 * interactive-transaction client, so we retype it to the `ScopedDb` the proxy
 * passes at runtime (same shape as inventory-ledger's `runStockTransaction`).
 */
export function runSchedulerTransaction<T>(
  db: ScopedDb,
  work: (tx: ScopedDb) => Promise<T>
): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

type RunningJob = {
  id: string;
  status: RestaurantJobStatus;
  attempts: number;
  maxAttempts: number;
  claimedAt: Date | null;
  claimedBy: string | null;
  claimToken: string | null;
};

async function requireRunningClaim(
  tx: ScopedDb,
  jobId: string,
  claim: Pick<SettleOptions, 'workerId' | 'attempt' | 'claimToken'>
): Promise<RunningJob> {
  if (
    !claim.workerId.trim() ||
    (typeof claim.claimToken !== 'string' || !claim.claimToken.trim()) ||
    !Number.isInteger(claim.attempt) ||
    claim.attempt < 1
  ) {
    throw new SchedulerError(
      'Settlement requires a valid workerId, claim attempt, and claim token.',
      'INVALID'
    );
  }
  const job = await tx.restaurantJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      claimedAt: true,
      claimedBy: true,
      claimToken: true,
    },
  });
  if (!job) {
    throw new SchedulerError(`Job ${jobId} was not found.`, 'JOB_NOT_FOUND');
  }
  if (job.status !== 'RUNNING') {
    throw new SchedulerError(
      `Job ${jobId} is ${job.status}, not RUNNING; refusing to settle it.`,
      'INVALID_STATE'
    );
  }
  if (
    job.claimedBy !== claim.workerId ||
    job.attempts !== claim.attempt ||
    job.claimToken !== claim.claimToken
  ) {
    throw new SchedulerError(
      `Job ${jobId} is owned by a different claim; refusing to settle it.`,
      'INVALID_STATE'
    );
  }
  return job as RunningJob;
}

function runningClaimWhere(
  jobId: string,
  claim: Pick<SettleOptions, 'workerId' | 'attempt' | 'claimToken'>
): Prisma.RestaurantJobWhereInput {
  return {
    id: jobId,
    status: 'RUNNING',
    attempts: claim.attempt,
    claimedBy: claim.workerId,
    claimToken: claim.claimToken,
  };
}

function requireClaimUpdate(count: number, jobId: string): void {
  if (count !== 1) {
    throw new SchedulerError(
      `Job ${jobId} claim changed while it was being settled; refusing to settle it.`,
      'INVALID_STATE'
    );
  }
}

async function appendExecution(
  tx: ScopedDb,
  data: {
    jobId: string;
    workerId: string;
    attempt: number;
    startedAt: Date;
    finishedAt: Date;
    outcome: 'SUCCEEDED' | 'FAILED';
    error: string | null;
  }
): Promise<void> {
  await tx.restaurantJobExecution.create({ data });
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
