import 'server-only';

import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import type { RestaurantJobHandler } from '@/lib/restaurant/job-handlers-core';
import {
  SchedulerError,
  enqueue,
  runSchedulerTransaction,
  type EnqueueResult,
} from '@/lib/restaurant/scheduler';
import {
  SOP_ESCALATION_JOB,
  createEscalationPolicy,
  setEscalationPolicyActive,
  upsertEscalationStep,
} from '@/lib/restaurant/sop-escalation';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { PharmacySopSiteRef } from '@/lib/pharmacy/sop-adapter';
import { pharmacySopPackForTemplateName } from '@/lib/pharmacy/sop-library';
import { PHARMACY_SOP_ESCALATION_DELAY } from '@/lib/pharmacy/sop-shared';

/**
 * DEV-751 — opt-in overdue escalation for pharmacy procedures.
 *
 * OFF unless a manager turns it on for a branch: with no policy (or an inactive
 * one) nothing here runs, nothing is enqueued and overdue work is only flagged
 * on the board, exactly as before. There is no default escalation.
 *
 * No second engine. Turning a branch ON stores one BRANCH-scoped policy on the
 * shared restaurant escalation model (`restaurant_sop_escalation_policies`) for
 * the site's engine branch, with a single IN_APP step to the manager who turned
 * it on, after the chosen delay. The shared handler (`sop.runEscalation`)
 * remains the only interpreter of a policy: delay anchoring, stop conditions
 * (verified, waived, sent back, acknowledged, chain exhausted), quiet hours,
 * the append-only event ledger and the notification outbox are all its own.
 * Turning a branch OFF deactivates the policy, which the shared handler already
 * treats as "do nothing"; its history stays.
 *
 * The one pharmacy addition is the sweep that decides WHICH occurrences to hand
 * to the shared handler: a job (`pharmacy.sop.escalateOverdue`) on the existing
 * restaurant job queue that exists only while at least one branch is ON. Each
 * run reads the active pharmacy policies (none → it stops, so the organization
 * carries no recurring job), ensures the next run, and enqueues one shared
 * escalation job per overdue, unsubmitted pharmacy occurrence at an ON branch
 * whose window closed after the branch was turned on (never back-dated). Keys
 * are deterministic per occurrence × policy × slot, so re-runs deduplicate.
 *
 * Escalation is a notification only. It never blocks, gates or changes any
 * pharmacy workflow or record, and its text is the procedure name only (the
 * channel is IN_APP; never WhatsApp).
 */

/** No policy for a branch reads as this value. */
export const PHARMACY_SOP_ESCALATION_DEFAULT = false;

/** The name of the one policy a pharmacy branch can own on the shared model. */
export const PHARMACY_SOP_ESCALATION_POLICY_NAME = 'Pharmacy overdue procedures';

/** The sweep job type, registered in job-handlers.ts. */
export const PHARMACY_SOP_ESCALATE_OVERDUE_JOB = 'pharmacy.sop.escalateOverdue';

/** One sweep per organization every 15 minutes while any branch is ON. */
export const PHARMACY_SOP_ESCALATE_OVERDUE_CADENCE_MS = 15 * 60_000;

/** How far back an overdue window is still swept (bounds every run). */
export const PHARMACY_SOP_ESCALATION_LOOKBACK_MS = 7 * 86_400_000;

/** At most this many occurrences are handed to the shared handler per branch per run. */
const SWEEP_LIMIT = 200;

/** Unsubmitted states the shared handler escalates (REJECTED would stop the chain for good). */
const ESCALATABLE_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'MISSED'] as const;

export class PharmacySopEscalationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PharmacySopEscalationError';
  }
}

export type PharmacySopOverdueEscalationSetting = {
  pharmacyBranchId: string;
  enabled: boolean;
  /** Minutes after the window closes; the default when never turned on. */
  delayMinutes: number;
  /** The staff profile told when work is overdue; null when never turned on. */
  targetStaffProfileId: string | null;
  /** When it was last turned on or off; null when never changed. */
  changedAt: Date | null;
};

const POLICY_SELECT = {
  id: true,
  active: true,
  updatedAt: true,
  steps: {
    orderBy: { stepOrder: 'asc' as const },
    take: 1,
    select: { delayMinutes: true, target: true },
  },
} as const;

type PolicyRow = {
  id: string;
  active: boolean;
  updatedAt: Date;
  steps: Array<{ delayMinutes: number; target: string }>;
};

function policyWhere(sopBranchId: string) {
  return {
    branchId: sopBranchId,
    scope: 'BRANCH' as const,
    name: PHARMACY_SOP_ESCALATION_POLICY_NAME,
  };
}

async function findPolicy(db: ScopedDb, sopBranchId: string): Promise<PolicyRow | null> {
  return db.restaurantSopEscalationPolicy.findFirst({
    where: policyWhere(sopBranchId),
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: POLICY_SELECT,
  });
}

function toSetting(
  pharmacyBranchId: string,
  policy: PolicyRow | null
): PharmacySopOverdueEscalationSetting {
  const step = policy?.steps[0];
  return {
    pharmacyBranchId,
    enabled: policy ? policy.active && Boolean(step) : PHARMACY_SOP_ESCALATION_DEFAULT,
    delayMinutes: step?.delayMinutes ?? PHARMACY_SOP_ESCALATION_DELAY.defaultMinutes,
    targetStaffProfileId: step?.target ?? null,
    changedAt: policy?.updatedAt ?? null,
  };
}

/** The branch's current overdue-escalation setting; OFF when never turned on. */
export async function pharmacySopOverdueEscalation(
  db: ScopedDb,
  input: { site: Pick<PharmacySopSiteRef, 'pharmacyBranchId' | 'sopBranchId'> }
): Promise<PharmacySopOverdueEscalationSetting> {
  return toSetting(input.site.pharmacyBranchId, await findPolicy(db, input.site.sopBranchId));
}

export function assertPharmacySopEscalationDelay(delayMinutes: number): void {
  if (
    !Number.isInteger(delayMinutes) ||
    delayMinutes < PHARMACY_SOP_ESCALATION_DELAY.minMinutes ||
    delayMinutes > PHARMACY_SOP_ESCALATION_DELAY.maxMinutes
  ) {
    throw new PharmacySopEscalationError(
      `The delay must be a whole number of minutes from ${PHARMACY_SOP_ESCALATION_DELAY.minMinutes} to ${PHARMACY_SOP_ESCALATION_DELAY.maxMinutes}.`
    );
  }
}

export type SetPharmacySopOverdueEscalationResult = {
  setting: PharmacySopOverdueEscalationSetting;
  changed: boolean;
  /** When the sweep next runs (only while ON). */
  nextRunAt: Date | null;
};

/**
 * Turn overdue escalation on or off for one branch. The caller has already
 * resolved `site` within the session's branch scope and `targetStaffProfileId`
 * from the session (the manager making the change); neither comes from input.
 *
 * ON: create (or reactivate) the branch's policy, set its one step to the
 * delay and target, and ensure the organization's next sweep. OFF: deactivate
 * the policy; with none, nothing is written. Idempotent: an unchanged setting
 * writes nothing but still re-ensures the sweep while ON (restarting a chain
 * whose last job failed for good). Changes are serialized per branch.
 */
export async function setPharmacySopOverdueEscalation(
  db: ScopedDb,
  input: {
    organizationId: string;
    site: Pick<PharmacySopSiteRef, 'pharmacyBranchId' | 'sopBranchId'>;
    enabled: boolean;
    delayMinutes?: number;
    targetStaffProfileId: string;
    now: Date;
  }
): Promise<SetPharmacySopOverdueEscalationResult> {
  const { site } = input;
  const delayMinutes = input.delayMinutes ?? PHARMACY_SOP_ESCALATION_DELAY.defaultMinutes;
  if (input.enabled) assertPharmacySopEscalationDelay(delayMinutes);
  if (input.enabled && !input.targetStaffProfileId) {
    throw new PharmacySopEscalationError('A manager to notify is required.');
  }

  return runSchedulerTransaction(db, async (tx) => {
    const lockKey = `pharmacy-sop-escalation:${site.sopBranchId}`;
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    let policy = await findPolicy(tx, site.sopBranchId);
    const before = toSetting(site.pharmacyBranchId, policy);

    if (!input.enabled) {
      if (policy?.active) {
        await setEscalationPolicyActive(tx, policy.id, false);
        policy = await findPolicy(tx, site.sopBranchId);
      }
      const setting = toSetting(site.pharmacyBranchId, policy);
      return { setting, changed: before.enabled !== setting.enabled, nextRunAt: null };
    }

    if (!policy) {
      const created = await createEscalationPolicy(tx, {
        name: PHARMACY_SOP_ESCALATION_POLICY_NAME,
        scope: 'BRANCH',
        branchId: site.sopBranchId,
        stopOnAcknowledged: true,
        stopOnVerified: true,
      });
      policy = { id: created.id, active: created.active, updatedAt: created.updatedAt, steps: [] };
    } else if (!policy.active) {
      await setEscalationPolicyActive(tx, policy.id, true);
    }
    const step = policy.steps[0];
    if (!step || step.delayMinutes !== delayMinutes || step.target !== input.targetStaffProfileId) {
      await upsertEscalationStep(tx, {
        policyId: policy.id,
        stepOrder: 1,
        delayMinutes,
        target: input.targetStaffProfileId,
        channel: 'IN_APP',
      });
    }
    const setting = toSetting(site.pharmacyBranchId, await findPolicy(tx, site.sopBranchId));
    const job = await ensurePharmacySopEscalationSweep(tx, {
      organizationId: input.organizationId,
      now: input.now,
    });
    const changed =
      before.enabled !== setting.enabled ||
      before.delayMinutes !== setting.delayMinutes ||
      before.targetStaffProfileId !== setting.targetStaffProfileId;
    return { setting, changed, nextRunAt: job.slot };
  });
}

// ── The sweep job ─────────────────────────────────────────────────────────────

/** The slot `now` falls in (floored to the cadence, UTC). */
export function pharmacySopEscalationSlot(now: Date): Date {
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new RangeError('A valid instant is required.');
  return new Date(
    Math.floor(time / PHARMACY_SOP_ESCALATE_OVERDUE_CADENCE_MS) *
      PHARMACY_SOP_ESCALATE_OVERDUE_CADENCE_MS
  );
}

/** The first slot strictly after the one `now` falls in. */
export function nextPharmacySopEscalationSlot(now: Date): Date {
  return new Date(
    pharmacySopEscalationSlot(now).getTime() + PHARMACY_SOP_ESCALATE_OVERDUE_CADENCE_MS
  );
}

/** Deterministic per-organization key for one sweep slot. */
export function pharmacySopEscalationSweepKey(slot: Date): string {
  return `${PHARMACY_SOP_ESCALATE_OVERDUE_JOB}:${pharmacySopEscalationSlot(slot).toISOString()}`;
}

/** Deterministic per-organization key for one occurrence × policy × slot. */
export function pharmacySopEscalationRunKey(
  occurrenceId: string,
  policyId: string,
  slot: Date
): string {
  return `${PHARMACY_SOP_ESCALATE_OVERDUE_JOB}:run:${occurrenceId}:${policyId}:${pharmacySopEscalationSlot(slot).toISOString()}`;
}

const ORGANIZATION_ID = /^[a-zA-Z0-9_-]{3,128}$/;

/**
 * Ensure the organization's sweep for the next slot exists, on the caller's
 * `db` only. Concurrent ensures of the same slot are serialized on an
 * organization-scoped advisory lock, so the loser reads the winner's row.
 */
export async function ensurePharmacySopEscalationSweep(
  db: ScopedDb,
  input: { organizationId: string; now: Date }
): Promise<EnqueueResult & { slot: Date }> {
  if (typeof input.organizationId !== 'string' || !ORGANIZATION_ID.test(input.organizationId)) {
    throw new TypeError('An organization is required to schedule overdue escalation.');
  }
  const slot = nextPharmacySopEscalationSlot(input.now);
  const lockKey = `${PHARMACY_SOP_ESCALATE_OVERDUE_JOB}:${input.organizationId}:${slot.toISOString()}`;
  const job = {
    type: PHARMACY_SOP_ESCALATE_OVERDUE_JOB,
    payload: { slot: slot.toISOString() },
    idempotencyKey: pharmacySopEscalationSweepKey(slot),
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
    if (error instanceof SchedulerError && error.reason === 'DUPLICATE_ENQUEUE') {
      return { ...(await attempt()), slot };
    }
    throw error;
  }
}

/** The active pharmacy policies (one per ON branch), in the `db`'s organization. */
export async function activePharmacySopEscalationPolicies(
  db: ScopedDb
): Promise<Array<{ policyId: string; sopBranchId: string; enabledAt: Date }>> {
  const sites = await db.pharmacySopSite.findMany({
    where: { pharmacyBranch: { active: true } },
    select: { sopBranchId: true },
    orderBy: { sopBranchId: 'asc' },
  });
  if (sites.length === 0) return [];
  const policies = await db.restaurantSopEscalationPolicy.findMany({
    where: {
      name: PHARMACY_SOP_ESCALATION_POLICY_NAME,
      scope: 'BRANCH',
      active: true,
      branchId: { in: sites.map((site) => site.sopBranchId) },
      steps: { some: {} },
    },
    orderBy: [{ branchId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, branchId: true, updatedAt: true },
  });
  const seen = new Set<string>();
  const result: Array<{ policyId: string; sopBranchId: string; enabledAt: Date }> = [];
  for (const policy of policies) {
    if (!policy.branchId || seen.has(policy.branchId)) continue;
    seen.add(policy.branchId);
    result.push({ policyId: policy.id, sopBranchId: policy.branchId, enabledAt: policy.updatedAt });
  }
  return result;
}

/**
 * The overdue, unsubmitted pharmacy occurrences at one ON branch to hand to the
 * shared handler: window closed (strictly) before `now`, but not before the
 * branch was turned on nor beyond the lookback, and no chain already stopped.
 */
export async function overduePharmacySopOccurrenceIds(
  db: ScopedDb,
  input: { sopBranchId: string; enabledAt: Date; now: Date }
): Promise<string[]> {
  const floor = new Date(
    Math.max(input.enabledAt.getTime(), input.now.getTime() - PHARMACY_SOP_ESCALATION_LOOKBACK_MS)
  );
  const rows = await db.restaurantSopOccurrence.findMany({
    where: {
      branchId: input.sopBranchId,
      status: { in: [...ESCALATABLE_STATUSES] },
      submittedAt: null,
      windowEndsAt: { lt: input.now, gte: floor },
      escalationEvents: { none: { kind: 'STOPPED' } },
    },
    orderBy: [{ windowEndsAt: 'asc' }, { id: 'asc' }],
    take: SWEEP_LIMIT,
    select: { id: true, assignment: { select: { template: { select: { name: true } } } } },
  });
  return rows
    .filter((row) => pharmacySopPackForTemplateName(row.assignment.template.name))
    .map((row) => row.id);
}

const SLOT = z
  .string()
  .datetime()
  .refine(
    (value) => Date.parse(value) % PHARMACY_SOP_ESCALATE_OVERDUE_CADENCE_MS === 0,
    'The slot must be aligned to the sweep cadence.'
  );

const SWEEP_PAYLOAD = z.object({ slot: SLOT }).strict();

export function parsePharmacySopEscalationSweepPayload(payload: unknown): { slot: string } {
  return SWEEP_PAYLOAD.parse(payload);
}

/**
 * The sweep handler, on the worker's handler transaction `db` and nothing else,
 * as of the claim instant. No ON branch → nothing (the chain stops). Otherwise
 * it ensures the next sweep and enqueues one shared `sop.runEscalation` job per
 * overdue occurrence × the branch's policy. It never writes an escalation event
 * or notification itself: the shared handler does, under its own row lock.
 */
export const pharmacySopEscalateOverdueHandler: RestaurantJobHandler = async ({ db, job }) => {
  const { slot } = parsePharmacySopEscalationSweepPayload(job.payload);
  const now = job.startedAt;
  const policies = await activePharmacySopEscalationPolicies(db);
  if (policies.length === 0) return;

  await ensurePharmacySopEscalationSweep(db, { organizationId: job.organizationId, now });
  for (const policy of policies) {
    const occurrenceIds = await overduePharmacySopOccurrenceIds(db, {
      sopBranchId: policy.sopBranchId,
      enabledAt: policy.enabledAt,
      now,
    });
    for (const occurrenceId of occurrenceIds) {
      await enqueue(
        db,
        {
          type: SOP_ESCALATION_JOB,
          payload: { occurrenceId, policyId: policy.policyId },
          idempotencyKey: pharmacySopEscalationRunKey(
            occurrenceId,
            policy.policyId,
            new Date(slot)
          ),
          scheduledAt: now,
        },
        now
      );
    }
  }
};
