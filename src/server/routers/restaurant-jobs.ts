import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { Prisma } from '@/generated/prisma/client';
import { SchedulerError, enqueue } from '@/lib/restaurant/scheduler';
import { annotateAudit } from '../audit';
import { capabilityProcedure, router } from '../trpc';

/**
 * M7-L2 — the background-operations read/command console (ops contracts).
 *
 * A single operational surface over the M7 runtime this lane ships: the scheduler
 * queue (`restaurant_jobs`) + its append-only execution history
 * (`restaurant_job_executions`), the transactional outbox
 * (`restaurant_event_outbox`), and the inbound webhook inbox
 * (`restaurant_webhook_inbox`). Every procedure is org-role-driven through the ABAC
 * engine's `customDecision` path behind ONE capability gate, `reports:operational`
 * (already carried by the general-manager / financial-controller /
 * sop-compliance-auditor role templates in vertical-catalog).
 *
 * All reads run on the request's tenant-scoped `ctx.db` (forced RLS), so a caller
 * only ever sees its own organization's queue. Inputs are `.strict()` (house style
 * / M7 global constraint — unknown keys are rejected). List reads are cursor
 * paginated (newest first). Timestamps cross the tRPC boundary as `Date`
 * (superjson transformer). The webhook-inbox browse deliberately omits the raw
 * provider `payload` (arbitrary size / possibly sensitive) — it exposes only the
 * envelope metadata and processing state.
 */

const opsProcedure = capabilityProcedure('reports:operational');

const ID = z.string().min(1);
const DEFAULT_LIMIT = 50;
const LIMIT = z.number().int().min(1).max(200).optional();
const CURSOR = ID.optional();

const JOB_STATUS = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD']);
const OUTBOX_STATUS = z.enum(['PENDING', 'DISPATCHED', 'DEAD']);
const INBOX_STATUS = z.enum(['PENDING', 'PROCESSED', 'FAILED', 'DISCARDED']);
const VERIFICATION_STATUS = z.enum(['PENDING', 'VERIFIED', 'FAILED']);

const JOB_SELECT = {
  id: true,
  type: true,
  status: true,
  attempts: true,
  maxAttempts: true,
  scheduledAt: true,
  nextAttemptAt: true,
  claimedAt: true,
  claimedBy: true,
  lastError: true,
  idempotencyKey: true,
  payload: true,
  createdAt: true,
  updatedAt: true,
} as const;

const EXECUTION_SELECT = {
  id: true,
  jobId: true,
  workerId: true,
  attempt: true,
  startedAt: true,
  finishedAt: true,
  outcome: true,
  error: true,
  createdAt: true,
} as const;

const OUTBOX_SELECT = {
  id: true,
  eventType: true,
  aggregateType: true,
  aggregateId: true,
  status: true,
  attempts: true,
  nextAttemptAt: true,
  lastError: true,
  payload: true,
  createdAt: true,
  updatedAt: true,
} as const;

const INBOX_SELECT = {
  id: true,
  source: true,
  externalEventId: true,
  eventType: true,
  verificationStatus: true,
  status: true,
  attempts: true,
  lastError: true,
  receivedAt: true,
  processedAt: true,
  createdAt: true,
} as const;

/** Resolve the effective page size from an optional input limit. */
function pageSize(limit?: number): number {
  return limit ?? DEFAULT_LIMIT;
}

/** Cursor-pagination args: newest first, `take limit+1` to detect a next page. */
function pageArgs(limit: number, cursor?: string) {
  return {
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  };
}

/** Split an over-fetched page into `{ items, nextCursor }`. */
function paginate<T extends { id: string }>(
  rows: T[],
  limit: number
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: items[items.length - 1]!.id };
}

export const restaurantJobsRouter = router({
  // ── Scheduler queue browse ────────────────────────────────────────────────────

  listJobs: opsProcedure
    .input(
      z
        .object({
          status: JOB_STATUS.optional(),
          type: z.string().min(1).max(200).optional(),
          cursor: CURSOR,
          limit: LIMIT,
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const limit = pageSize(input.limit);
      const rows = await ctx.db.restaurantJob.findMany({
        where: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.type ? { type: input.type } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: JOB_SELECT,
        ...pageArgs(limit, input.cursor),
      });
      return paginate(rows, limit);
    }),

  // ── Append-only execution history ───────────────────────────────────────────────

  listExecutions: opsProcedure
    .input(
      z
        .object({
          jobId: ID.optional(),
          outcome: z.enum(['SUCCEEDED', 'FAILED']).optional(),
          cursor: CURSOR,
          limit: LIMIT,
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const limit = pageSize(input.limit);
      const rows = await ctx.db.restaurantJobExecution.findMany({
        where: {
          ...(input.jobId ? { jobId: input.jobId } : {}),
          ...(input.outcome ? { outcome: input.outcome } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: EXECUTION_SELECT,
        ...pageArgs(limit, input.cursor),
      });
      return paginate(rows, limit);
    }),

  // ── Dead-letter list (jobs that exhausted their retry budget) ───────────────────

  listDeadLetters: opsProcedure
    .input(
      z
        .object({
          type: z.string().min(1).max(200).optional(),
          cursor: CURSOR,
          limit: LIMIT,
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const limit = pageSize(input.limit);
      const rows = await ctx.db.restaurantJob.findMany({
        where: { status: 'DEAD', ...(input.type ? { type: input.type } : {}) },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: JOB_SELECT,
        ...pageArgs(limit, input.cursor),
      });
      return paginate(rows, limit);
    }),

  // ── Requeue a dead job → a NEW job (the original DEAD row is retained) ───────────

  requeueDeadJob: opsProcedure
    .input(z.object({ jobId: ID }).strict())
    .mutation(async ({ ctx, input }) => {
      const dead = await ctx.db.restaurantJob.findUnique({
        where: { id: input.jobId },
        select: { id: true, type: true, payload: true, maxAttempts: true, status: true },
      });
      if (!dead) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Job not found.' });
      }
      if (dead.status !== 'DEAD') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Only DEAD jobs can be requeued; job ${dead.id} is ${dead.status}.`,
        });
      }
      try {
        // The stable key makes response loss/browser replay safe and durably links
        // the successor to the retained dead row without resurrecting that row.
        const { job, deduplicated } = await enqueue(ctx.db, {
          type: dead.type,
          payload: (dead.payload ?? {}) as Prisma.InputJsonValue,
          maxAttempts: dead.maxAttempts,
          idempotencyKey: `dead-job-requeue:${dead.id}`,
        });
        annotateAudit(ctx, {
          category: 'SYSTEM',
          operation: 'EXECUTE',
          action: 'restaurant.job.requeue',
          description: deduplicated
            ? 'Returned the existing retry for a dead restaurant job.'
            : 'Queued a retry for a dead restaurant job.',
          targetType: 'RestaurantJob',
          targetId: dead.id,
          metadata: { requeuedFrom: dead.id, successorJobId: job.id, deduplicated },
        });
        return { requeuedFrom: dead.id, jobId: job.id, status: job.status, deduplicated };
      } catch (error) {
        if (error instanceof SchedulerError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        }
        throw error;
      }
    }),

  // ── Transactional outbox status ─────────────────────────────────────────────────

  listOutbox: opsProcedure
    .input(
      z
        .object({
          status: OUTBOX_STATUS.optional(),
          aggregateType: z.string().min(1).max(200).optional(),
          aggregateId: ID.optional(),
          cursor: CURSOR,
          limit: LIMIT,
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const limit = pageSize(input.limit);
      const rows = await ctx.db.restaurantEventOutbox.findMany({
        where: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.aggregateType ? { aggregateType: input.aggregateType } : {}),
          ...(input.aggregateId ? { aggregateId: input.aggregateId } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: OUTBOX_SELECT,
        ...pageArgs(limit, input.cursor),
      });
      return paginate(rows, limit);
    }),

  // ── Inbound webhook inbox browse (metadata only — no raw payload) ────────────────

  listWebhookInbox: opsProcedure
    .input(
      z
        .object({
          source: z.string().min(1).max(200).optional(),
          status: INBOX_STATUS.optional(),
          verificationStatus: VERIFICATION_STATUS.optional(),
          cursor: CURSOR,
          limit: LIMIT,
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const limit = pageSize(input.limit);
      const rows = await ctx.db.restaurantWebhookInbox.findMany({
        where: {
          ...(input.source ? { source: input.source } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.verificationStatus ? { verificationStatus: input.verificationStatus } : {}),
        },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        select: INBOX_SELECT,
        ...pageArgs(limit, input.cursor),
      });
      return paginate(rows, limit);
    }),
});
