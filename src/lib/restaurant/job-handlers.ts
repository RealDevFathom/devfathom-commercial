import 'server-only';

import type { ClaimedJob } from '@/lib/restaurant/scheduler';
import {
  WEBHOOK_PROCESS_JOB_TYPE,
  processInboundWebhookHandler,
} from '@/lib/restaurant/webhook-inbox';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
// M7-L3: SOP occurrence generation. Supervisor-sequenced merge order L2 -> L3 ->
// L4 -> L5; the only conflict is this import list and the object literal below.
import {
  SOP_GENERATE_OCCURRENCES_JOB,
  generateSopOccurrencesHandler,
} from '@/lib/restaurant/sop-occurrence-generation';
// M7-L4: late/missed sweep + escalation chain
import { SOP_LATE_MISSED_JOB, sopLateMissedHandler } from '@/lib/restaurant/sop-late-missed';
import { SOP_ESCALATION_JOB, sopEscalationHandler } from '@/lib/restaurant/sop-escalation';
import {
  NOTIFICATION_FANOUT_JOB,
  notificationFanoutHandler,
} from '@/lib/restaurant/notification-fanout';
import { LOYALTY_EXPIRY_JOB, loyaltyExpiryHandler } from '@/lib/restaurant/loyalty-expiry';
import { INSIGHTS_ROLLUP_DAY_JOB, rollupDayHandler } from '@/lib/restaurant/insight-rollups';

/**
 * M7-L1 — the typed job-handler registry. The scheduler primitive
 * (src/lib/restaurant/scheduler.ts) is domain-agnostic: it knows how to claim,
 * retry, and record jobs, but not what any job DOES. This registry is the seam
 * where each later lane plugs in, so L2–L5 register INDEPENDENTLY without
 * touching the scheduler.
 *
 * Registration is ONE import + ONE key per lane (supervisor-sequenced merge
 * order L2 -> L3 -> L4 -> L5; the only conflict is this import list and this
 * object literal, resolved by rebasing the later lane over the earlier one):
 *
 *   import { generateSopOccurrencesHandler } from '@/lib/restaurant/sop-jobs';
 *
 *   export const restaurantJobHandlers: Record<string, RestaurantJobHandler> = {
 *     'sop.generateOccurrences': generateSopOccurrencesHandler,
 *     // …later lanes append one key each here…
 *   };
 *
 * A handler receives a tenant-scoped `db` (the worker opens it inside the target
 * organization's RLS context) and the claimed job. Handlers MUST be idempotent —
 * a job can run more than once across retries and worker crashes (D13) — and
 * MUST validate `job.payload` (an opaque `Prisma.JsonValue`) with strict zod at
 * their own boundary before use.
 */

export type RestaurantJobContext = {
  /** A tenant-scoped client bound to the job's organization (forced RLS). */
  db: ScopedDb;
  /** The claimed job (already RUNNING; `payload` is an opaque JSON value). */
  job: ClaimedJob;
};

export type RestaurantJobHandler = (context: RestaurantJobContext) => Promise<void>;

/**
 * The job-type → handler map. Keyed by the string `RestaurantJob.type` an
 * enqueuer set. Intentionally empty in L1: later lanes add exactly one key each.
 */
export const restaurantJobHandlers: Record<string, RestaurantJobHandler> = {
  // M7-L2: inbound-webhook processing (the receiver enqueues one job per envelope).
  [WEBHOOK_PROCESS_JOB_TYPE]: processInboundWebhookHandler,
  // …later lanes (L3 SOP, L5 notifications) append one key each here…
  [SOP_GENERATE_OCCURRENCES_JOB]: generateSopOccurrencesHandler,
  [SOP_LATE_MISSED_JOB]: sopLateMissedHandler,
  [SOP_ESCALATION_JOB]: sopEscalationHandler,
  [NOTIFICATION_FANOUT_JOB]: notificationFanoutHandler,
  [LOYALTY_EXPIRY_JOB]: loyaltyExpiryHandler,
  [INSIGHTS_ROLLUP_DAY_JOB]: rollupDayHandler,
};

/** Look up the handler registered for a job type (undefined when none is). */
export function resolveRestaurantJobHandler(type: string): RestaurantJobHandler | undefined {
  return restaurantJobHandlers[type];
}

/**
 * Resolve and run the handler for a claimed job. Throws when no handler is
 * registered for the job's type, so an unknown type surfaces as a normal job
 * failure (bounded retries → DEAD) rather than a silent success.
 */
export async function runRestaurantJob(context: RestaurantJobContext): Promise<void> {
  const handler = resolveRestaurantJobHandler(context.job.type);
  if (!handler) {
    throw new Error(`No restaurant job handler is registered for type "${context.job.type}".`);
  }
  await handler(context);
}
