import 'server-only';

import { z } from 'zod';

import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers';

/**
 * M7-L4 / §11.5 — SOP late/missed sweep: scheduler handler.
 *
 * ## What LATE means (and why the sweep no longer writes it)
 *
 * Across the rest of the SOP engine, LATE means "SUBMITTED past the due window":
 * `submitOccurrence` stamps it (sop-execution.ts) and `sop-verification.ts` treats
 * it as a verifiable state alongside SUBMITTED. The schema enum agrees — "LATE
 * (submitted past the due window); MISSED (window elapsed with no submission)".
 *
 * The original M7 sweep also drove SCHEDULED/IN_PROGRESS → LATE for work that was
 * merely overdue. That overloaded one status with two meanings and produced four
 * defects:
 *
 *   1. Dead-end occurrences. Once swept to LATE, an operator can no longer act:
 *      `startOccurrence` requires SCHEDULED/REJECTED, and `completeStep` /
 *      `submitOccurrence` require IN_PROGRESS. With `graceMinutes` defaulting to
 *      0 this fired the instant the window closed, so late submission — which the
 *      engine documents as allowed — was in practice impossible.
 *   2. Lost submissions. The MISSED statement matched `status IN ('SCHEDULED',
 *      'LATE')` without checking `submittedAt`, so a genuinely submitted-late
 *      occurrence awaiting verification was rewritten to MISSED once grace
 *      elapsed, silently dropping it from the verifier's queue.
 *   3. Verifiable phantom work. A swept LATE occurrence carries no submission, yet
 *      `verifyOccurrence` accepts LATE — letting a manager VERIFY work nobody did.
 *   4. Non-deterministic boundaries. The sweep used `<=` while `submitOccurrence`
 *      uses `>`, so at exactly `windowEndsAt` the two paths disagreed; and with
 *      the default `graceMinutes = 0` both statements fired in the same pass, so
 *      LATE was never observable.
 *
 * The sweep therefore owns exactly ONE transition:
 *
 *   SCHEDULED / IN_PROGRESS (never submitted) → MISSED
 *     when  windowEndsAt + graceMinutes  has strictly elapsed.
 *
 * LATE stays where it belongs: stamped by the request path at submission time.
 * An overdue-but-unsubmitted occurrence remains SCHEDULED/IN_PROGRESS until the
 * grace boundary passes, which keeps it workable and keeps the escalation chain
 * (sop-escalation.ts) running against it — escalation stops on VERIFIED / WAIVED /
 * REJECTED, none of which this sweep produces.
 *
 * ## Determinism
 *
 * The boundary is STRICT (`<`) and shared with `submitOccurrence`'s `now >
 * windowEndsAt`: at the exact boundary instant an occurrence is neither late nor
 * missed. `missedAt()` below is the single definition of that instant; the SQL
 * predicate is its literal translation and `isMissedAt()` is exercised directly by
 * the unit tests.
 *
 * ## Idempotency
 *
 * At-least-once execution is safe: the WHERE clause only matches occurrences still
 * in a pre-submission state, so re-running the sweep over already-MISSED (or
 * since-submitted) rows is a no-op. The statement is a single set-based UPDATE, so
 * a partially applied sweep is not observable.
 *
 * Registration: one key added to restaurantJobHandlers in job-handlers.ts.
 */

export const SOP_LATE_MISSED_JOB = 'sop.sweepLateMissed';

const PayloadSchema = z
  .object({
    /** Override the "now" instant for deterministic tests. */
    now: z.string().datetime().optional(),
  })
  .strict();

/**
 * The instant at which an unsubmitted occurrence becomes MISSED: the end of its
 * due window plus the assignment's grace period.
 */
export function missedAt(windowEndsAt: Date, graceMinutes: number): Date {
  return new Date(windowEndsAt.getTime() + graceMinutes * 60_000);
}

/**
 * True when `now` has STRICTLY passed the missed boundary. At the boundary instant
 * itself the occurrence is not yet missed — matching `submitOccurrence`'s strict
 * `now > windowEndsAt`, so no instant is claimed by both paths.
 */
export function isMissedAt(now: Date, windowEndsAt: Date, graceMinutes: number): boolean {
  return now.getTime() > missedAt(windowEndsAt, graceMinutes).getTime();
}

export async function sopLateMissedHandler({ db, job }: RestaurantJobContext): Promise<void> {
  const payload = PayloadSchema.parse(job.payload);
  const now = payload.now ? new Date(payload.now) : new Date();

  // `db` is bound to the job's organization under forced RLS, so the raw statement
  // is tenant-scoped by policy; `graceMinutes` lives on the assignment row, hence
  // the join. The `submittedAt IS NULL` guard is what protects a submitted-late
  // occurrence from being rewritten to MISSED.
  await db.$executeRaw`
    UPDATE restaurant_sop_occurrences occ
    SET    status = 'MISSED', "updatedAt" = ${now}
    FROM   restaurant_sop_assignments asgn
    WHERE  occ."assignmentId" = asgn.id
      AND  occ.status IN ('SCHEDULED', 'IN_PROGRESS')
      AND  occ."submittedAt" IS NULL
      AND  (occ."windowEndsAt" + (INTERVAL '1 minute' * asgn."graceMinutes")) < ${now}
  `;
}
