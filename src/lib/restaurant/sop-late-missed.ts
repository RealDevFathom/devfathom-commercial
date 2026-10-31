import 'server-only';

import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers-core';
import {
  isQuietHour,
  localMinutesOfDay,
  SOP_ESCALATION_JOB,
} from '@/lib/restaurant/sop-escalation';
import { enqueue, SchedulerError } from '@/lib/restaurant/scheduler';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

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
 *   SCHEDULED / IN_PROGRESS / LATE, and never submitted → MISSED
 *     when  windowEndsAt + graceMinutes  has strictly elapsed.
 *
 * The `submittedAt IS NULL` guard — not the status list — is what protects
 * submitted work. That distinction matters: it is why LATE can stay in the swept
 * set without reviving defect 2. A LATE row that carries a submission is a real
 * late submission awaiting a verifier and the guard excludes it; a LATE row with
 * no submission is an occurrence that was never handed in, and MISSED is exactly
 * what it is. The sweep no longer WRITES LATE, so going forward that state can
 * only come from `submitOccurrence` (which always stamps `submittedAt`) — the
 * LATE branch therefore only ever resolves rows left by the previous sweep.
 *
 * LATE otherwise stays where it belongs: stamped by the request path at
 * submission time. An overdue-but-unsubmitted occurrence remains
 * SCHEDULED/IN_PROGRESS until the grace boundary passes, which keeps it workable
 * and keeps the escalation chain (sop-escalation.ts) running against it —
 * escalation stops on VERIFIED / WAIVED / REJECTED, none of which this sweep
 * produces.
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

/** Hard per-tick query and CPU bounds for one tenant's producer work. */
export const MAX_ESCALATION_POLICIES_PER_TICK = 20;
export const MAX_ESCALATION_OCCURRENCES_PER_TICK = 25;
export const MAX_ESCALATION_PAIR_EVALUATIONS_PER_TICK = 500;
/**
 * How far back (by `windowEndsAt`) the producer and worker discovery look for
 * escalation work. Escalation is an operational alert, not a backfill: rows older
 * than this are never paged, so exhausted-but-unverified chains age out of the
 * bounded page rotation instead of slowing it down forever.
 */
export const ESCALATION_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/** Lower `windowEndsAt` bound for escalation work at `now`. */
export function escalationLookbackStart(now: Date): Date {
  return new Date(now.getTime() - ESCALATION_LOOKBACK_MS);
}

const ESCALATION_PAGE_INTERVAL_MS = 60_000;

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

/** Stable queue identity for one policy step acting on one occurrence. */
export function sopEscalationJobKey(
  occurrenceId: string,
  policyId: string,
  stepId: string
): string {
  return `sop-escalation:${occurrenceId}:${policyId}:${stepId}`;
}

/**
 * Discover escalation work from live, tenant-scoped SOP state. The sweep is the
 * production producer for `sop.runEscalation`: it queues only the next unfired
 * step after its delay has elapsed. A step-specific idempotency key makes every
 * later sweep and concurrent sweeper harmless while still allowing the next
 * step in the chain to be scheduled.
 */
export async function enqueueDueSopEscalations(db: ScopedDb, now: Date): Promise<number> {
  const policyWhere = {
    active: true,
    steps: { some: {} },
  } satisfies Prisma.RestaurantSopEscalationPolicyWhereInput;
  const occurrenceWhere = {
    windowEndsAt: { lte: now, gte: escalationLookbackStart(now) },
    status: { in: ['SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'LATE', 'MISSED'] },
    // STOPPED terminates every policy chain, so do not let old terminal rows
    // consume a bounded occurrence page forever.
    escalationEvents: { none: { kind: 'STOPPED' } },
  } satisfies Prisma.RestaurantSopOccurrenceWhereInput;
  const [policyCount, occurrenceCount] = await Promise.all([
    db.restaurantSopEscalationPolicy.count({ where: policyWhere }),
    db.restaurantSopOccurrence.count({ where: occurrenceWhere }),
  ]);
  if (policyCount === 0 || occurrenceCount === 0) return 0;

  // Derive a persistent, deterministic odometer from wall-clock minutes rather
  // than process memory. Occurrence pages advance first; after a complete pass,
  // the policy page advances. Thus every policy/occurrence page combination is
  // visited even across restarts and regardless of which worker runs the tick.
  const tick = Math.floor(now.getTime() / ESCALATION_PAGE_INTERVAL_MS);
  const occurrencePageCount = Math.ceil(occurrenceCount / MAX_ESCALATION_OCCURRENCES_PER_TICK);
  const policyPageCount = Math.ceil(policyCount / MAX_ESCALATION_POLICIES_PER_TICK);
  const occurrencePage = tick % occurrencePageCount;
  const policyPage = Math.floor(tick / occurrencePageCount) % policyPageCount;
  const policies: Array<{
    id: string;
    scope: 'ORG' | 'BRANCH';
    branchId: string | null;
    stopOnAcknowledged: boolean;
    createdAt: Date;
    quietHoursStartMinutes: number | null;
    quietHoursEndMinutes: number | null;
    steps: Array<{ id: string; delayMinutes: number }>;
  }> = await db.restaurantSopEscalationPolicy.findMany({
    where: policyWhere,
    orderBy: { id: 'asc' },
    skip: policyPage * MAX_ESCALATION_POLICIES_PER_TICK,
    take: MAX_ESCALATION_POLICIES_PER_TICK,
    select: {
      id: true,
      scope: true,
      branchId: true,
      stopOnAcknowledged: true,
      createdAt: true,
      quietHoursStartMinutes: true,
      quietHoursEndMinutes: true,
      steps: {
        orderBy: { stepOrder: 'asc' },
        select: { id: true, delayMinutes: true },
      },
    },
  });

  let enqueued = 0;
  let evaluatedPairs = 0;
  const occurrences = await db.restaurantSopOccurrence.findMany({
    where: occurrenceWhere,
    orderBy: [{ windowEndsAt: 'asc' }, { id: 'asc' }],
    skip: occurrencePage * MAX_ESCALATION_OCCURRENCES_PER_TICK,
    take: MAX_ESCALATION_OCCURRENCES_PER_TICK,
    select: {
      id: true,
      branchId: true,
      windowEndsAt: true,
      branch: { select: { timezone: true } },
      escalationEvents: {
        where: { kind: { in: ['FIRED', 'ACKNOWLEDGED', 'STOPPED'] } },
        select: { escalationStepId: true, kind: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  for (const occurrence of occurrences) {
    for (const policy of policies) {
      if (evaluatedPairs >= MAX_ESCALATION_PAIR_EVALUATIONS_PER_TICK) return enqueued;
      evaluatedPairs += 1;
      if (policy.scope === 'BRANCH' && policy.branchId !== occurrence.branchId) continue;
      // A newly activated policy governs work that becomes overdue under it; it
      // must not flood staff with alerts for occurrences that closed before it
      // existed.
      if (policy.createdAt && occurrence.windowEndsAt.getTime() < policy.createdAt.getTime()) {
        continue;
      }
      if (occurrence.escalationEvents.some((event) => event.kind === 'STOPPED')) continue;
      if (
        policy.stopOnAcknowledged &&
        occurrence.escalationEvents.some((event) => event.kind === 'ACKNOWLEDGED')
      ) {
        continue;
      }
      const fired = new Set(
        occurrence.escalationEvents
          .filter((event) => event.kind === 'FIRED')
          .map((event) => event.escalationStepId)
          .filter((id): id is string => id !== null)
      );
      const nextStep = policy.steps.find((step) => !fired.has(step.id));
      if (!nextStep) continue;

      const previous = [...occurrence.escalationEvents]
        .reverse()
        .find(
          (event) =>
            event.kind === 'FIRED' &&
            event.escalationStepId &&
            policy.steps.some((s) => s.id === event.escalationStepId)
        );
      const anchor = previous?.createdAt ?? occurrence.windowEndsAt;
      if (now.getTime() < anchor.getTime() + nextStep.delayMinutes * 60_000) continue;

      if (
        policy.quietHoursStartMinutes !== null &&
        policy.quietHoursEndMinutes !== null &&
        isQuietHour(
          localMinutesOfDay(occurrence.branch?.timezone ?? 'UTC', now),
          policy.quietHoursStartMinutes,
          policy.quietHoursEndMinutes
        )
      ) {
        continue;
      }

      // `enqueue`'s nested `$transaction` reuses this tenant transaction, so a
      // unique-key violation would abort the whole transaction (25P02 on the next
      // statement). Isolate each insert in a savepoint so a lost race is local.
      await db.$executeRaw`SAVEPOINT sop_escalation_enqueue`;
      try {
        const result = await enqueue(db, {
          type: SOP_ESCALATION_JOB,
          payload: { occurrenceId: occurrence.id, policyId: policy.id },
          idempotencyKey: sopEscalationJobKey(occurrence.id, policy.id, nextStep.id),
          scheduledAt: now,
        });
        await db.$executeRaw`RELEASE SAVEPOINT sop_escalation_enqueue`;
        if (!result.deduplicated) enqueued += 1;
      } catch (error) {
        // Two tenant-scoped sweepers may race after the pre-insert lookup. The
        // unique key is the winner; the loser has reached the desired state.
        if (!(error instanceof SchedulerError) || error.reason !== 'DUPLICATE_ENQUEUE') throw error;
        await db.$executeRaw`ROLLBACK TO SAVEPOINT sop_escalation_enqueue`;
      }
    }
  }
  return enqueued;
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
      AND  occ.status IN ('SCHEDULED', 'IN_PROGRESS', 'LATE')
      AND  occ."submittedAt" IS NULL
      AND  (occ."windowEndsAt" + (INTERVAL '1 minute' * asgn."graceMinutes")) < ${now}
  `;

  await enqueueDueSopEscalations(db, now);
}
