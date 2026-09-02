/**
 * The RETAIL TERMINAL seam (PRD §11): the pure outbox dispatch/retry state
 * machine shared by the Restaurant order outbox and the Pharmacy counter's
 * offline command outbox.
 *
 * This module is an EXTRACTION of the pure half of
 * `src/lib/restaurant/outbox.ts`, which now re-exports it. Only the retry policy
 * and the two state-transition planners are here: they never touch a table, so
 * they are identical for any outbox and testable without a database.
 *
 * NOT `server-only`. The Restaurant outbox is drained by a server worker, but a
 * Pharmacy counter drains its own outbox from the browser after an outage, and
 * both must plan backoff by the same rule.
 */

export type OutboxStatus = 'PENDING' | 'DISPATCHED' | 'DEAD';

export const OUTBOX_STATUS = {
  PENDING: 'PENDING',
  DISPATCHED: 'DISPATCHED',
  DEAD: 'DEAD',
} as const satisfies Record<OutboxStatus, OutboxStatus>;

/** The durable outbox fields a dispatcher reasons about. */
export type OutboxRecord = {
  id: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date | null;
};

/** The field patch a dispatcher persists after an attempt. */
export type OutboxDispatchPatch = {
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
};

/** Retry policy. Exponential backoff from `baseDelayMs`, capped at `maxDelayMs`;
 * after `maxAttempts` failures the row is dead-lettered. */
export type OutboxRetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_OUTBOX_RETRY_POLICY: OutboxRetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 60 * 60 * 1_000, // one hour
};

/** Exponential backoff delay (ms) before the Nth attempt (1-indexed), capped. */
export function backoffDelayMs(attempt: number, policy: OutboxRetryPolicy): number {
  const raw = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, policy.maxDelayMs);
}

/** The patch to persist when a dispatch succeeds: the row is DISPATCHED and no
 * longer scheduled. */
export function planDispatchSuccess(record: OutboxRecord): OutboxDispatchPatch {
  return {
    status: OUTBOX_STATUS.DISPATCHED,
    attempts: record.attempts + 1,
    nextAttemptAt: null,
    lastError: null,
  };
}

/**
 * The patch to persist when a dispatch fails at server time `at`. Increments the
 * attempt count; schedules the next retry with backoff while attempts remain,
 * otherwise dead-letters the row (DEAD, unscheduled). `error` is recorded for
 * observability (never a secret — callers pass a sanitized message).
 */
export function planDispatchFailure(
  record: OutboxRecord,
  at: Date,
  error: string,
  policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY
): OutboxDispatchPatch {
  const attempts = record.attempts + 1;
  if (attempts >= policy.maxAttempts) {
    return { status: OUTBOX_STATUS.DEAD, attempts, nextAttemptAt: null, lastError: error };
  }
  return {
    status: OUTBOX_STATUS.PENDING,
    attempts,
    nextAttemptAt: new Date(at.getTime() + backoffDelayMs(attempts, policy)),
    lastError: error,
  };
}
