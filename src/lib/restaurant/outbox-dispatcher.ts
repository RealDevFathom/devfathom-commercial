import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  DEFAULT_OUTBOX_RETRY_POLICY,
  OUTBOX_STATUS,
  planDispatchFailure,
  planDispatchSuccess,
  type OutboxDispatchPatch,
  type OutboxRecord,
  type OutboxRetryPolicy,
} from '@/lib/restaurant/outbox';

/**
 * M7-L2 / §12.2 — the transactional-outbox dispatcher. This is the worker M4
 * flagged but did not build: `src/lib/restaurant/outbox.ts` shipped the DISPATCH
 * SEAM (the `PENDING/DISPATCHED/DEAD` states, the attempt/backoff fields, and the
 * pure `planDispatchSuccess`/`planDispatchFailure` planners) but recorded — never
 * silently claimed — that "no scheduler/worker exists yet to drive it" (§12.2
 * debt). This module drives it, reusing those M4 planners unchanged so the retry
 * policy stays in one place.
 *
 * Mechanics mirror the scheduler primitive (scheduler.ts): a due `PENDING` row
 * (`nextAttemptAt IS NULL OR <= now`) is claimed with `SELECT … FOR UPDATE SKIP
 * LOCKED` inside ONE tenant-scoped transaction, so concurrent dispatchers over M
 * due rows each take a DISTINCT row. The claimed row is delivered to the consumer
 * registered for its `eventType`; on success it is marked `DISPATCHED`, on failure
 * it is re-queued with exponential backoff or dead-lettered (`DEAD`) once the
 * attempt budget is spent — exactly the M4 planner semantics.
 *
 * In-process consumer registry (the L2 seam, empty here): the outbox is generic
 * (`aggregateType` + `eventType`), so each later lane registers a consumer for the
 * event types it cares about — ONE import + ONE key, mirroring `job-handlers.ts`.
 * A row whose `eventType` has NO registered consumer is left `PENDING` and counted
 * `skipped` (never silently dropped, never dead-lettered): a consumer a later lane
 * registers picks it up on a subsequent pass.
 *
 * Delivery contract: the consumer runs INSIDE the claiming transaction, so M7's
 * in-process consumers (all real external channels are D21-stubbed) hold the row
 * lock only for their own DB work. A future external-delivery consumer that does
 * long network I/O will want a lease-based claim instead (recorded in
 * BUILD-ASSUMPTIONS as the D21/§12.2 follow-up), not an in-transaction call.
 */

/** The durable outbox row a consumer receives: the M4 dispatch fields plus the
 * advertised event (`eventType` + `aggregateType`/`aggregateId` + `payload`). */
export type OutboxDispatchRecord = OutboxRecord & {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Prisma.JsonValue;
};

/**
 * A consumer delivers ONE outbox event. Returning normally marks the row
 * `DISPATCHED`; throwing re-queues it with backoff (or dead-letters it once the
 * attempt budget is spent). Consumers MUST be idempotent — at-least-once delivery
 * means a row can be re-delivered after a crash between the consumer and the
 * status write.
 */
export type OutboxConsumer = (record: OutboxDispatchRecord) => Promise<void>;

/**
 * The in-process consumer registry: `eventType` → consumer. Intentionally empty in
 * L2; later lanes register exactly one key each (the same additive-merge shape as
 * the job-handler registry). Registering the same event type twice is a
 * programming error and throws at registration.
 */
export class OutboxConsumerRegistry {
  private readonly consumers = new Map<string, OutboxConsumer>();

  register(eventType: string, consumer: OutboxConsumer): void {
    const key = eventType.trim();
    if (!key) {
      throw new Error('OutboxConsumerRegistry.register requires a non-empty event type.');
    }
    if (this.consumers.has(key)) {
      throw new Error(`An outbox consumer is already registered for event type "${key}".`);
    }
    this.consumers.set(key, consumer);
  }

  resolve(eventType: string): OutboxConsumer | undefined {
    return this.consumers.get(eventType);
  }

  has(eventType: string): boolean {
    return this.consumers.has(eventType);
  }

  /** The registered event types, for the ops read contracts / diagnostics. */
  eventTypes(): string[] {
    return [...this.consumers.keys()];
  }
}

/** The process-wide restaurant outbox consumer registry. Empty in L2; later lanes
 * register into it (one import + one key), the same seam as `restaurantJobHandlers`. */
export const restaurantOutboxConsumers = new OutboxConsumerRegistry();

/** Safety bound on rows dispatched in one `dispatchOutboxBatch` call. */
export const DEFAULT_OUTBOX_BATCH = 50;
const MAX_OUTBOX_BATCH = 500;

/** The tally of one dispatch batch (per organization). */
export type OutboxDispatchSummary = {
  /** Rows delivered to a consumer that succeeded (now DISPATCHED). */
  dispatched: number;
  /** Rows whose consumer threw and were re-queued with backoff. */
  retried: number;
  /** Rows whose consumer threw and whose attempt budget was spent (now DEAD). */
  dead: number;
  /** Rows with no registered consumer, left PENDING for a later pass. */
  skipped: number;
};

export type DispatchOutboxOptions = {
  /** The consumer registry (defaults to the process-wide restaurant registry). */
  registry?: OutboxConsumerRegistry;
  /** Injectable clock (defaults to the system clock) — the due filter + backoff. */
  now?: Date;
  /** Retry policy (defaults to the M4 conservative policy: 8 attempts, 1s→1h). */
  policy?: OutboxRetryPolicy;
  /** Max rows to dispatch in this call (default {@link DEFAULT_OUTBOX_BATCH}). */
  batchSize?: number;
  /** Aborting stops claiming further rows (a claimed row still finishes). */
  signal?: AbortSignal;
};

/** Open one tenant-scoped transaction (same retype as scheduler.ts). */
function runOutboxTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

type RowOutcome = 'dispatched' | 'retried' | 'dead' | 'skipped' | 'none';

/**
 * Dispatch up to `batchSize` due `PENDING` outbox rows for the organization bound
 * to `db`'s RLS scope. Each row is claimed + delivered + settled in its own
 * transaction (`db` should therefore be a per-op tenant client — e.g.
 * `createTenantDb(orgId)` — so the row lock is held only for that row's work). A
 * row with no registered consumer is left `PENDING` (`skipped`); it is excluded
 * from re-selection within THIS call so the batch always makes forward progress.
 */
export async function dispatchOutboxBatch(
  db: ScopedDb,
  options: DispatchOutboxOptions = {}
): Promise<OutboxDispatchSummary> {
  const now = options.now ?? new Date();
  const policy = options.policy ?? DEFAULT_OUTBOX_RETRY_POLICY;
  const registry = options.registry ?? restaurantOutboxConsumers;
  const batchSize = Math.max(
    1,
    Math.min(MAX_OUTBOX_BATCH, Math.floor(options.batchSize ?? DEFAULT_OUTBOX_BATCH))
  );
  const summary: OutboxDispatchSummary = { dispatched: 0, retried: 0, dead: 0, skipped: 0 };
  // Rows left PENDING (no consumer) this call — excluded so we never busy-loop on
  // the same undeliverable row inside one batch.
  const skippedIds: string[] = [];

  for (let processed = 0; processed < batchSize; processed += 1) {
    if (options.signal?.aborted) break;

    const outcome = await runOutboxTransaction(db, async (tx): Promise<RowOutcome> => {
      const excludeClause =
        skippedIds.length > 0
          ? Prisma.sql`AND "id" NOT IN (${Prisma.join(skippedIds)})`
          : Prisma.empty;
      const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "restaurant_event_outbox"
        WHERE "status" = 'PENDING'
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
          ${excludeClause}
        ORDER BY "nextAttemptAt" ASC NULLS FIRST, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      const id = candidates[0]?.id;
      if (!id) return 'none';

      const row = await tx.restaurantEventOutbox.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          attempts: true,
          nextAttemptAt: true,
          eventType: true,
          aggregateType: true,
          aggregateId: true,
          payload: true,
        },
      });
      // A concurrent settle could have moved it out of PENDING between the claim
      // and the read; treat that as nothing-to-do (idempotent).
      if (!row || row.status !== OUTBOX_STATUS.PENDING) {
        skippedIds.push(id);
        return 'skipped';
      }

      const record: OutboxDispatchRecord = {
        id: row.id,
        status: row.status as OutboxRecord['status'],
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
        eventType: row.eventType,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        payload: row.payload,
      };

      const consumer = registry.resolve(row.eventType);
      if (!consumer) {
        skippedIds.push(id);
        return 'skipped';
      }

      let patch: OutboxDispatchPatch;
      try {
        await consumer(record);
        patch = planDispatchSuccess(record);
      } catch (error) {
        patch = planDispatchFailure(record, now, errorMessage(error), policy);
      }

      await tx.restaurantEventOutbox.update({
        where: { id },
        data: {
          status: patch.status,
          attempts: patch.attempts,
          nextAttemptAt: patch.nextAttemptAt,
          lastError: patch.lastError,
        },
      });

      if (patch.status === OUTBOX_STATUS.DISPATCHED) return 'dispatched';
      if (patch.status === OUTBOX_STATUS.DEAD) return 'dead';
      return 'retried';
    });

    if (outcome === 'none') break;
    if (outcome === 'skipped') summary.skipped += 1;
    else summary[outcome] += 1;
  }

  return summary;
}
