import 'server-only';

import { z } from 'zod';

import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers-core';
import { appendNotificationRequest } from '@/lib/restaurant/notification-fanout';
import {
  notificationRequestId,
  type RestaurantNotificationChannel,
} from '@/lib/restaurant/notifications';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M7-L4 / §11.5 — SOP escalation chain execution: scheduler handler.
 *
 * An escalation policy is a sequence of ordered steps (delay + target + channel)
 * that fire when a compliance occurrence is overdue and unresolved. The handler
 * folds the escalation-event ledger (APPEND-ONLY: FIRED/ACKNOWLEDGED/STOPPED) to
 * determine current position, applies STOP conditions, respects quiet hours, and
 * appends a notification request to the transactional outbox. Fan-out later
 * records IN_APP delivery; EMAIL/SMS/PUSH/WHATSAPP remain STUBBED in M7.
 *
 * STOP conditions (policy flags):
 *   stopOnVerified     — occurrence is VERIFIED or WAIVED
 *   stopOnAcknowledged — an ACKNOWLEDGED escalation event exists for this occurrence
 *   chain exhausted    — all steps have fired and no more remain
 *
 * Quiet hours (branch-local):
 *   policy.quietHoursStartMinutes / quietHoursEndMinutes — minutes-of-day in the
 *   branch timezone. When the current wall-clock minute falls inside the quiet
 *   window, delivery is DEFERRED (a FIRED event is NOT written). The completed
 *   job releases its idempotency key so the next overdue sweep can enqueue the
 *   step again after quiet hours.
 *
 * Idempotency: each step fires AT MOST ONCE per policy × occurrence combination.
 * The FIRED event for a step is the logical guard, but a guard that is only read
 * inside a READ COMMITTED transaction does not stop two workers claiming the same
 * step concurrently — both would read an empty ledger and both would append a
 * FIRED event, corrupting an audit ledger that is supposed to be immutable and
 * exact. The handler therefore takes a row lock on the occurrence before folding
 * the ledger, which serialises concurrent runs for that occurrence without a
 * schema change. (The notification itself was already idempotent: the outbox row
 * carries a deterministic id and is inserted with `skipDuplicates`.)
 *
 * Delay anchoring: a step's `delayMinutes` is measured from the previous FIRED
 * event, or — for the FIRST step, which has no predecessor — from the occurrence's
 * `windowEndsAt`. Anchoring the head of the chain is what makes step 1's delay
 * mean anything; without it the first step fired immediately no matter how it was
 * configured, and the whole chain's timing shifted with the scheduler's cadence
 * rather than with the SOP's due window.
 *
 * Registration: one key in restaurantJobHandlers (job-handlers.ts).
 */

export const SOP_ESCALATION_JOB = 'sop.runEscalation';

const PayloadSchema = z
  .object({
    occurrenceId: z.string().min(1),
    policyId: z.string().min(1),
    /** Override "now" for deterministic tests. */
    now: z.string().datetime().optional(),
  })
  .strict();

type EscalationStep = {
  id: string;
  stepOrder: number;
  delayMinutes: number;
  target: string;
  channel: RestaurantNotificationChannel;
  maxAttempts: number;
};

type EscalationEvent = {
  id: string;
  escalationStepId: string | null;
  kind: 'FIRED' | 'ACKNOWLEDGED' | 'STOPPED';
  createdAt: Date;
};

/** Minutes-of-day in the branch's local timezone, derived from an Intl formatter. */
export function localMinutesOfDay(branchTimezone: string, now: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: branchTimezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return h * 60 + m;
  } catch {
    // Fallback: UTC minutes-of-day
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/** Returns true if `minuteOfDay` falls within the quiet window (wraps midnight). */
export function isQuietHour(
  minuteOfDay: number,
  startMinutes: number,
  endMinutes: number
): boolean {
  if (startMinutes <= endMinutes) {
    return minuteOfDay >= startMinutes && minuteOfDay < endMinutes;
  }
  // Cross-midnight: e.g. 22:00 → 06:00
  return minuteOfDay >= startMinutes || minuteOfDay < endMinutes;
}

export async function sopEscalationHandler({ db, job }: RestaurantJobContext): Promise<void> {
  const payload = PayloadSchema.parse(job.payload);
  const now = payload.now ? new Date(payload.now) : new Date();

  await (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<void>) => Promise<void>)(
    async (tx) => {
      // ── Serialise concurrent runs for this occurrence ──────────────────────
      // Held for the rest of the transaction, so the ledger fold below and the
      // FIRED insert that follows it are atomic with respect to another worker.
      await tx.$queryRaw`
        SELECT id FROM restaurant_sop_occurrences
        WHERE id = ${payload.occurrenceId}
        FOR UPDATE
      `;

      // ── Load occurrence + policy + branch ──────────────────────────────────
      const occ = await tx.restaurantSopOccurrence.findUnique({
        where: { id: payload.occurrenceId },
        select: {
          id: true,
          status: true,
          branchId: true,
          windowEndsAt: true,
          branch: { select: { timezone: true } },
          assignment: {
            select: {
              template: { select: { name: true } },
            },
          },
        },
      });
      if (!occ) return; // occurrence deleted — nothing to do

      // ── STOP: occurrence already resolved ─────────────────────────────────
      if (
        occ.status === 'VERIFIED' ||
        occ.status === 'WAIVED' ||
        occ.status === 'REJECTED' // rework — do not escalate mid-rework
      ) {
        await tx.restaurantSopEscalationEvent.create({
          data: {
            occurrenceId: occ.id,
            escalationStepId: null,
            kind: 'STOPPED',
            detail: `Occurrence status is ${occ.status}; escalation halted.`,
            createdAt: now,
          },
        });
        return;
      }

      const policy = await tx.restaurantSopEscalationPolicy.findUnique({
        where: { id: payload.policyId },
        select: {
          id: true,
          active: true,
          stopOnAcknowledged: true,
          stopOnVerified: true,
          quietHoursStartMinutes: true,
          quietHoursEndMinutes: true,
          steps: {
            orderBy: { stepOrder: 'asc' },
            select: {
              id: true,
              stepOrder: true,
              delayMinutes: true,
              target: true,
              channel: true,
              maxAttempts: true,
            },
          },
        },
      });
      if (!policy || !policy.active) return; // policy removed or deactivated

      // ── Fold event ledger ─────────────────────────────────────────────────
      const events: EscalationEvent[] = await tx.restaurantSopEscalationEvent.findMany({
        where: { occurrenceId: occ.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, escalationStepId: true, kind: true, createdAt: true },
      });

      // STOP: policy.stopOnVerified re-checked against live state (occ.status)
      // already done above; also check acknowledged
      if (policy.stopOnAcknowledged) {
        const acked = events.some((e) => e.kind === 'ACKNOWLEDGED');
        if (acked) {
          await tx.restaurantSopEscalationEvent.create({
            data: {
              occurrenceId: occ.id,
              escalationStepId: null,
              kind: 'STOPPED',
              detail: 'Acknowledged; escalation halted.',
              createdAt: now,
            },
          });
          return;
        }
      }

      const firedStepIds = new Set(
        events
          .filter((e) => e.kind === 'FIRED' && e.escalationStepId)
          .map((e) => e.escalationStepId!)
      );

      // ── Find the next unfired step ─────────────────────────────────────────
      const steps: EscalationStep[] = policy.steps;
      const nextStep = steps.find((s) => !firedStepIds.has(s.id));
      if (!nextStep) {
        // Chain exhausted — all steps fired
        await tx.restaurantSopEscalationEvent.create({
          data: {
            occurrenceId: occ.id,
            escalationStepId: null,
            kind: 'STOPPED',
            detail: 'Escalation chain exhausted.',
            createdAt: now,
          },
        });
        return;
      }

      // ── Delay check ────────────────────────────────────────────────────────
      // The delay is measured from the previous FIRED event; the first step has no
      // predecessor, so it anchors to the occurrence's window close instead. The
      // comparison is strict-less-than, so a step whose delay has exactly elapsed
      // fires on this pass rather than waiting for the next one.
      const policyStepIds = new Set(steps.map((step) => step.id));
      const lastFiredEvent = [...events]
        .reverse()
        .find(
          (e) =>
            e.kind === 'FIRED' &&
            e.escalationStepId !== null &&
            policyStepIds.has(e.escalationStepId)
        );
      const anchor = lastFiredEvent ? lastFiredEvent.createdAt : occ.windowEndsAt;
      if (now.getTime() - anchor.getTime() < nextStep.delayMinutes * 60_000) {
        // Delay not yet elapsed — defer silently
        return;
      }

      // ── Quiet-hour check ──────────────────────────────────────────────────
      if (policy.quietHoursStartMinutes !== null && policy.quietHoursEndMinutes !== null) {
        const branchTz = occ.branch?.timezone ?? 'UTC';
        const localMin = localMinutesOfDay(branchTz, now);
        if (isQuietHour(localMin, policy.quietHoursStartMinutes, policy.quietHoursEndMinutes)) {
          // The worker will complete this job normally, so release the stable
          // occurrence/policy/step key. Otherwise enqueue() would forever
          // deduplicate later sweeps against this event-free SUCCEEDED job.
          await tx.restaurantJob.update({
            where: { id: job.id },
            data: { idempotencyKey: null },
          });
          return;
        }
      }

      // ── Fire the step ─────────────────────────────────────────────────────
      const templateName = occ.assignment?.template?.name ?? 'SOP';
      const title = `SOP Escalation: ${templateName}`;
      const body = `Occurrence is overdue. Target: ${nextStep.target}. Step ${nextStep.stepOrder}.`;

      await appendNotificationRequest(tx, {
        requestId: notificationRequestId('sop.escalation', occ.id, nextStep.id),
        recipientStaffProfileIds: [nextStep.target],
        branchId: occ.branchId,
        category: 'sop.escalation',
        title,
        body,
        entityType: 'RestaurantSopOccurrence',
        entityId: occ.id,
        channels: [nextStep.channel],
      });

      await tx.restaurantSopEscalationEvent.create({
        data: {
          occurrenceId: occ.id,
          escalationStepId: nextStep.id,
          kind: 'FIRED',
          detail: `Step ${nextStep.stepOrder} fired to ${nextStep.target} via ${nextStep.channel}.`,
          createdAt: now,
        },
      });
    }
  );
}

// ── Policy configuration ──────────────────────────────────────────────────────

/**
 * WHA-226 — read/write access to the EXISTING escalation policy model.
 *
 * The policy shape (scope, stop conditions, quiet hours, ordered steps) was laid
 * down in M7 but had no surface: an operator could neither see which chain
 * governed a branch nor change a delay without a database session. These
 * functions add that surface and nothing else — no column, no new concept, no
 * second policy engine. `sopEscalationHandler` above remains the sole
 * interpreter of what a policy means; it reads exactly the fields configured
 * here.
 *
 * A policy is only ever configured, never rewritten in place while it is
 * running: the FIRED-event ledger references `escalationStepId`, so a step that
 * has already fired keeps its identity and the audit trail stays resolvable.
 * Removing a step therefore does not remove its history — the event rows survive
 * with a null step reference (`onDelete: SetNull`).
 */

export class SopEscalationConfigError extends Error {
  constructor(
    message: string,
    readonly reason: 'NOT_FOUND' | 'INVALID'
  ) {
    super(message);
    this.name = 'SopEscalationConfigError';
  }
}

export type EscalationPolicyScope = 'ORG' | 'BRANCH';

/**
 * Quiet hours are either fully configured or fully absent — a start with no end
 * (or the reverse) would leave `sopEscalationHandler` with a half-open window it
 * cannot evaluate, so it is rejected here rather than silently ignored there.
 */
function assertQuietHours(start: number | null, end: number | null): void {
  if ((start === null) !== (end === null)) {
    throw new SopEscalationConfigError(
      'Quiet hours require both a start and an end minute, or neither.',
      'INVALID'
    );
  }
}

/** A BRANCH-scoped policy must name a branch; an ORG-scoped one must not. */
function assertScope(scope: EscalationPolicyScope, branchId: string | null): void {
  if (scope === 'BRANCH' && !branchId) {
    throw new SopEscalationConfigError('A BRANCH-scoped policy requires a branchId.', 'INVALID');
  }
  if (scope === 'ORG' && branchId) {
    throw new SopEscalationConfigError('An ORG-scoped policy cannot name a branch.', 'INVALID');
  }
}

const POLICY_SELECT = {
  id: true,
  name: true,
  scope: true,
  branchId: true,
  stopOnAcknowledged: true,
  stopOnVerified: true,
  quietHoursStartMinutes: true,
  quietHoursEndMinutes: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  steps: {
    orderBy: { stepOrder: 'asc' },
    select: {
      id: true,
      stepOrder: true,
      delayMinutes: true,
      target: true,
      channel: true,
      maxAttempts: true,
    },
  },
} as const;

export type ListEscalationPoliciesInput = { branchId?: string; activeOnly?: boolean };

/**
 * List policies visible to the tenant. A branch filter returns that branch's own
 * policies AND the ORG-scoped ones, because both actually govern it — filtering
 * to branch-scoped rows alone would hide the chain most branches run under.
 */
export async function listEscalationPolicies(
  db: ScopedDb,
  input: ListEscalationPoliciesInput = {}
) {
  return db.restaurantSopEscalationPolicy.findMany({
    where: {
      ...(input.activeOnly ? { active: true } : {}),
      ...(input.branchId ? { OR: [{ branchId: input.branchId }, { scope: 'ORG' }] } : {}),
    },
    orderBy: [{ scope: 'asc' }, { name: 'asc' }],
    select: POLICY_SELECT,
  });
}

export async function getEscalationPolicy(db: ScopedDb, id: string) {
  const policy = await db.restaurantSopEscalationPolicy.findUnique({
    where: { id },
    select: POLICY_SELECT,
  });
  if (!policy) throw new SopEscalationConfigError('Escalation policy not found.', 'NOT_FOUND');
  return policy;
}

export type CreateEscalationPolicyInput = {
  name: string;
  scope: EscalationPolicyScope;
  branchId?: string | null;
  stopOnAcknowledged?: boolean;
  stopOnVerified?: boolean;
  quietHoursStartMinutes?: number | null;
  quietHoursEndMinutes?: number | null;
};

export async function createEscalationPolicy(db: ScopedDb, input: CreateEscalationPolicyInput) {
  const branchId = input.branchId ?? null;
  const start = input.quietHoursStartMinutes ?? null;
  const end = input.quietHoursEndMinutes ?? null;
  assertScope(input.scope, branchId);
  assertQuietHours(start, end);

  return db.restaurantSopEscalationPolicy.create({
    data: {
      name: input.name,
      scope: input.scope,
      branchId,
      stopOnAcknowledged: input.stopOnAcknowledged ?? true,
      stopOnVerified: input.stopOnVerified ?? true,
      quietHoursStartMinutes: start,
      quietHoursEndMinutes: end,
    },
    select: POLICY_SELECT,
  });
}

export type UpdateEscalationPolicyInput = {
  id: string;
  name?: string;
  stopOnAcknowledged?: boolean;
  stopOnVerified?: boolean;
  quietHoursStartMinutes?: number | null;
  quietHoursEndMinutes?: number | null;
};

/**
 * Update a policy's own fields. Scope and branch are deliberately NOT editable:
 * moving a live policy between branches would silently re-target every chain
 * already running under it. Create a new policy and deactivate the old one.
 */
export async function updateEscalationPolicy(db: ScopedDb, input: UpdateEscalationPolicyInput) {
  const existing = await getEscalationPolicy(db, input.id);
  const start =
    input.quietHoursStartMinutes === undefined
      ? existing.quietHoursStartMinutes
      : input.quietHoursStartMinutes;
  const end =
    input.quietHoursEndMinutes === undefined
      ? existing.quietHoursEndMinutes
      : input.quietHoursEndMinutes;
  assertQuietHours(start, end);

  return db.restaurantSopEscalationPolicy.update({
    where: { id: input.id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.stopOnAcknowledged === undefined
        ? {}
        : { stopOnAcknowledged: input.stopOnAcknowledged }),
      ...(input.stopOnVerified === undefined ? {} : { stopOnVerified: input.stopOnVerified }),
      quietHoursStartMinutes: start,
      quietHoursEndMinutes: end,
    },
    select: POLICY_SELECT,
  });
}

export async function setEscalationPolicyActive(db: ScopedDb, id: string, active: boolean) {
  await getEscalationPolicy(db, id);
  return db.restaurantSopEscalationPolicy.update({
    where: { id },
    data: { active },
    select: POLICY_SELECT,
  });
}

export type UpsertEscalationStepInput = {
  policyId: string;
  stepOrder: number;
  delayMinutes: number;
  target: string;
  channel: RestaurantNotificationChannel;
  maxAttempts?: number;
};

/**
 * Add or replace the step at `stepOrder` in a policy's chain.
 *
 * `(policyId, stepOrder)` is unique, so this is an upsert on that pair: editing
 * step 2 keeps its row identity, which keeps every FIRED event that already
 * references it resolvable.
 */
export async function upsertEscalationStep(db: ScopedDb, input: UpsertEscalationStepInput) {
  await getEscalationPolicy(db, input.policyId);
  const data = {
    delayMinutes: input.delayMinutes,
    target: input.target,
    channel: input.channel,
    maxAttempts: input.maxAttempts ?? 1,
  };
  return db.restaurantSopEscalationStep.upsert({
    where: { policyId_stepOrder: { policyId: input.policyId, stepOrder: input.stepOrder } },
    create: { policyId: input.policyId, stepOrder: input.stepOrder, ...data },
    update: data,
    select: {
      id: true,
      stepOrder: true,
      delayMinutes: true,
      target: true,
      channel: true,
      maxAttempts: true,
    },
  });
}

/**
 * Remove one step from a chain. Its already-fired events survive with a null
 * step reference — history is not rewritten by a configuration change.
 */
export async function removeEscalationStep(db: ScopedDb, policyId: string, stepOrder: number) {
  await getEscalationPolicy(db, policyId);
  const step = await db.restaurantSopEscalationStep.findUnique({
    where: { policyId_stepOrder: { policyId, stepOrder } },
    select: { id: true },
  });
  if (!step) throw new SopEscalationConfigError('Escalation step not found.', 'NOT_FOUND');
  await db.restaurantSopEscalationStep.delete({ where: { id: step.id } });
  return { id: step.id, policyId, stepOrder };
}

// ── Acknowledge ───────────────────────────────────────────────────────────────

export type AcknowledgeEscalationInput = {
  occurrenceId: string;
  actorStaffProfileId?: string | null;
  now?: Date;
};

export type AcknowledgeEscalationResult = {
  eventId: string;
  occurrenceId: string;
};

/**
 * Record an acknowledgement on an occurrence's escalation chain. Idempotent:
 * if already acknowledged, returns the existing event.
 */
export async function acknowledgeEscalation(
  db: ScopedDb,
  input: AcknowledgeEscalationInput
): Promise<AcknowledgeEscalationResult> {
  const now = input.now ?? new Date();
  return (
    db.$transaction as unknown as (
      fn: (tx: ScopedDb) => Promise<AcknowledgeEscalationResult>
    ) => Promise<AcknowledgeEscalationResult>
  )(async (tx) => {
    const existing = await tx.restaurantSopEscalationEvent.findFirst({
      where: { occurrenceId: input.occurrenceId, kind: 'ACKNOWLEDGED' },
      select: { id: true },
    });
    if (existing) return { eventId: existing.id, occurrenceId: input.occurrenceId };

    const event = await tx.restaurantSopEscalationEvent.create({
      data: {
        occurrenceId: input.occurrenceId,
        escalationStepId: null,
        kind: 'ACKNOWLEDGED',
        actorStaffProfileId: input.actorStaffProfileId ?? null,
        detail: 'Acknowledged by operator.',
        createdAt: now,
      },
      select: { id: true },
    });
    return { eventId: event.id, occurrenceId: input.occurrenceId };
  });
}
