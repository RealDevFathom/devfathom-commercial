import 'server-only';

import { z } from 'zod';

import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M7-L4 / §11.5 — SOP escalation chain execution: scheduler handler.
 *
 * An escalation policy is a sequence of ordered steps (delay + target + channel)
 * that fire when a compliance occurrence is overdue and unresolved. The handler
 * folds the escalation-event ledger (APPEND-ONLY: FIRED/ACKNOWLEDGED/STOPPED) to
 * determine current position, applies STOP conditions, respects quiet hours, and
 * emits `RestaurantNotification` rows (the D21 in-app channel; EMAIL/SMS/WEBHOOK
 * are recorded as STUBBED deliveries — never actually sent in M7).
 *
 * STOP conditions (policy flags):
 *   stopOnVerified     — occurrence is VERIFIED or WAIVED
 *   stopOnAcknowledged — an ACKNOWLEDGED escalation event exists for this occurrence
 *   chain exhausted    — all steps have fired and no more remain
 *
 * Quiet hours (branch-local):
 *   policy.quietHoursStartMinutes / quietHoursEndMinutes — minutes-of-day in the
 *   branch timezone. When the current wall-clock minute falls inside the quiet
 *   window, delivery is DEFERRED (a FIRED event is NOT written; the job re-runs on
 *   the next opportunity). Deferral is not a failure — the handler returns normally.
 *
 * Idempotency: each step fires AT MOST ONCE per policy × occurrence combination
 * (the FIRED event for a step is the guard). Re-runs observe the existing event
 * and skip ahead.
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
  channel: 'IN_APP' | 'EMAIL' | 'SMS' | 'WEBHOOK';
  maxAttempts: number;
};

type EscalationEvent = {
  id: string;
  escalationStepId: string | null;
  kind: 'FIRED' | 'ACKNOWLEDGED' | 'STOPPED';
};

/** Minutes-of-day in the branch's local timezone, derived from an Intl formatter. */
function localMinutesOfDay(branchTimezone: string, now: Date): number {
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
function isQuietHour(
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

async function emitNotification(
  tx: ScopedDb,
  opts: {
    recipientTarget: string;
    branchId: string | null;
    category: string;
    title: string;
    body: string;
    entityType: string;
    entityId: string;
    channel: 'IN_APP' | 'EMAIL' | 'SMS' | 'WEBHOOK';
    now: Date;
  }
): Promise<void> {
  // The target field is treated as a recipientStaffProfileId for IN_APP; for
  // other channels it is an opaque address string — we still create the
  // notification row but mark the delivery STUBBED (D21).
  const notification = await tx.restaurantNotification.create({
    data: {
      recipientStaffProfileId: opts.recipientTarget,
      branchId: opts.branchId,
      category: opts.category,
      title: opts.title,
      body: opts.body,
      entityType: opts.entityType,
      entityId: opts.entityId,
      createdAt: opts.now,
    },
    select: { id: true },
  });

  const status =
    opts.channel === 'IN_APP' ? 'DELIVERED_IN_APP' : 'STUBBED';

  await tx.restaurantNotificationDelivery.create({
    data: {
      notificationId: notification.id,
      channel: opts.channel,
      status,
    },
  });
}

export async function sopEscalationHandler({ db, job }: RestaurantJobContext): Promise<void> {
  const payload = PayloadSchema.parse(job.payload);
  const now = payload.now ? new Date(payload.now) : new Date();

  await (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<void>) => Promise<void>)(
    async (tx) => {
      // ── Load occurrence + policy + branch ──────────────────────────────────
      const occ = await tx.restaurantSopOccurrence.findUnique({
        where: { id: payload.occurrenceId },
        select: {
          id: true,
          status: true,
          branchId: true,
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
        select: { id: true, escalationStepId: true, kind: true },
      });

      const hasStopped = events.some((e) => e.kind === 'STOPPED');
      if (hasStopped) return; // chain already halted

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
        events.filter((e) => e.kind === 'FIRED' && e.escalationStepId).map((e) => e.escalationStepId!)
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

      // ── Delay check: has the delay window elapsed since the LAST fired step? ─
      const lastFiredEvent = [...events].reverse().find((e) => e.kind === 'FIRED');
      if (lastFiredEvent) {
        // We don't store firedAt on the event separately — use createdAt
        const lastFired = await tx.restaurantSopEscalationEvent.findUnique({
          where: { id: lastFiredEvent.id },
          select: { createdAt: true },
        });
        if (lastFired) {
          const delayMs = nextStep.delayMinutes * 60_000;
          if (now.getTime() - lastFired.createdAt.getTime() < delayMs) {
            // Delay not yet elapsed — defer silently
            return;
          }
        }
      }

      // ── Quiet-hour check ──────────────────────────────────────────────────
      if (
        policy.quietHoursStartMinutes !== null &&
        policy.quietHoursEndMinutes !== null
      ) {
        const branchTz = occ.branch?.timezone ?? 'UTC';
        const localMin = localMinutesOfDay(branchTz, now);
        if (isQuietHour(localMin, policy.quietHoursStartMinutes, policy.quietHoursEndMinutes)) {
          // Quiet hours — defer without recording an event
          return;
        }
      }

      // ── Fire the step ─────────────────────────────────────────────────────
      const templateName = occ.assignment?.template?.name ?? 'SOP';
      const title = `SOP Escalation: ${templateName}`;
      const body = `Occurrence is overdue. Target: ${nextStep.target}. Step ${nextStep.stepOrder}.`;

      await emitNotification(tx, {
        recipientTarget: nextStep.target,
        branchId: occ.branchId,
        category: 'sop.escalation',
        title,
        body,
        entityType: 'RestaurantSopOccurrence',
        entityId: occ.id,
        channel: nextStep.channel,
        now,
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
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<AcknowledgeEscalationResult>) => Promise<AcknowledgeEscalationResult>)(
    async (tx) => {
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
    }
  );
}
