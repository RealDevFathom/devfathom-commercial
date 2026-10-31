import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import '@/lib/restaurant/notification-webhook';
import { runRestaurantJob } from '@/lib/restaurant/job-handlers';
import {
  dispatchOutboxBatch,
  restaurantOutboxConsumers,
  type OutboxConsumerRegistry,
  type OutboxDispatchSummary,
} from '@/lib/restaurant/outbox-dispatcher';
import {
  DEMO_RESET_JOB_TYPE,
  drainDueJobs,
  recoverStaleJobs,
  type Clock,
  type DrainResult,
} from '@/lib/restaurant/scheduler';
import {
  enqueueDueSopEscalations,
  escalationLookbackStart,
} from '@/lib/restaurant/sop-late-missed';
import {
  createTenantDb,
  withPlatformDb,
  withTenantDb,
  type ScopedDb,
} from '@/lib/tenancy/scoped-db';

/**
 * M7-L2 / D13 — the restaurant background worker runtime. It drives BOTH durable
 * seams over the tenant queue: the scheduler (`restaurant_jobs` → registered
 * handlers) and the transactional outbox (`restaurant_event_outbox` → registered
 * consumers). L1 built the domain-agnostic primitives; this is the runtime that
 * runs them across organizations.
 *
 * D13 §(5) worker org-scoping — the invariant this runtime enforces: there is NO
 * cross-org queue MUTATION in the app role. Discovery (which orgs have due work)
 * is a privileged READ scan (`withPlatformDb`, allowed by the tenant-isolation
 * policy's `is_platform_admin` branch); every claim, handler, settle, and outbox
 * dispatch then runs INSIDE the target org's RLS context (`withTenantDb`), so the
 * strong M1–M6 tenancy boundary holds even for this privileged worker. A job
 * handler receives a tenant-scoped `db` bound to its own organization.
 * `demo-reset` is reserved for its dedicated authenticated cron because it needs
 * a longer transaction and stale-job lease than ordinary restaurant work.
 *
 * Everything time- or tenancy-dependent is injectable (`clock`, `discover
 * Organizations`, `runInOrg`, `outboxClient`, `sleep`), so the unit tests exercise
 * the multi-org loop, the drain/dispatch fan-out, and graceful shutdown
 * deterministically with in-memory fakes — the DB concurrency evidence lives in
 * L1's battery (`tests/restaurant-m7-scheduler-concurrency.test.ts`).
 */

/** Default per-org, per-tick bound on jobs drained (fairness across orgs). */
export const DEFAULT_MAX_JOBS_PER_ORG = 100;
/** Default per-org, per-tick bound on outbox rows dispatched. */
export const DEFAULT_MAX_OUTBOX_PER_ORG = 50;
/** Default idle poll interval for the daemon loop. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Run one org's work (claim/handler/settle/dispatch) in its RLS context. */
type RunInOrg = <T>(organizationId: string, work: (db: ScopedDb) => Promise<T>) => Promise<T>;

export type RunRestaurantWorkerTickOptions = {
  /** Identifies the worker; recorded on claimed jobs + execution rows. */
  workerId: string;
  /** The tick instant — a single `now` for every time decision in the tick. */
  now?: Date;
  /** Aborting stops the tick between orgs and releases any just-claimed job. */
  signal?: AbortSignal;
  /** The outbox consumer registry (defaults to the process-wide restaurant one). */
  outboxConsumers?: OutboxConsumerRegistry;
  /** Stale-lease cutoff for crashed-worker recovery (scheduler default when unset). */
  leaseMs?: number;
  /** Per-org bound on jobs drained this tick (default {@link DEFAULT_MAX_JOBS_PER_ORG}). */
  maxJobsPerOrg?: number;
  /** Per-org bound on outbox rows dispatched this tick (default {@link DEFAULT_MAX_OUTBOX_PER_ORG}). */
  maxOutboxPerOrg?: number;
  /** Seam: which orgs have due work (default = privileged cross-org read scan). */
  discoverOrganizations?: (now: Date) => Promise<string[]>;
  /** Seam: materialize occurrence-driven jobs before draining the queue. */
  produceDueJobs?: (db: ScopedDb, now: Date) => Promise<number>;
  /** Seam: run work inside an org's RLS transaction (default = `withTenantDb`). */
  runInOrg?: RunInOrg;
  /** Seam: a per-op tenant client for outbox dispatch (default = `createTenantDb`). */
  outboxClient?: (organizationId: string) => ScopedDb;
};

export type RestaurantWorkerTickResult = {
  /** Organizations visited this tick. */
  organizations: number;
  /** Stale (crashed-worker) jobs requeued across all orgs. */
  recovered: number;
  /** Aggregated scheduler drain result across all orgs. */
  jobs: DrainResult;
  /** Aggregated outbox dispatch result across all orgs. */
  outbox: OutboxDispatchSummary;
};

function emptyDrain(): DrainResult {
  return { claimed: 0, succeeded: 0, retried: 0, dead: 0, failed: 0, released: 0 };
}

function emptyOutbox(): OutboxDispatchSummary {
  return { dispatched: 0, retried: 0, dead: 0, skipped: 0 };
}

function addDrain(into: DrainResult, from: DrainResult): void {
  into.claimed += from.claimed;
  into.succeeded += from.succeeded;
  into.retried += from.retried;
  into.dead += from.dead;
  into.failed += from.failed;
  into.released += from.released;
}

function addOutbox(into: OutboxDispatchSummary, from: OutboxDispatchSummary): void {
  into.dispatched += from.dispatched;
  into.retried += from.retried;
  into.dead += from.dead;
  into.skipped += from.skipped;
}

/**
 * How often the (heavier) SOP-escalation discovery scan may run per process.
 * Escalation delays are minute-granular, so re-running the scan every 1s poll
 * adds DB load without surfacing new work any sooner.
 */
export const SOP_ESCALATION_DISCOVERY_INTERVAL_MS = 60_000;

let sopDiscoveryCache: { bucket: number; organizationIds: string[] } | null = null;

/** Orgs with in-lookback overdue occurrences that an active policy can still act on. */
async function discoverSopEscalationOrganizations(now: Date): Promise<string[]> {
  const bucket = Math.floor(now.getTime() / SOP_ESCALATION_DISCOVERY_INTERVAL_MS);
  if (sopDiscoveryCache?.bucket === bucket) return sopDiscoveryCache.organizationIds;
  // Unfinished chains re-anchor on their latest FIRED step (mirrors the
  // producer), so long multi-step chains stay discoverable past window close.
  const lookbackStart = escalationLookbackStart(now);
  const organizationIds = await withPlatformDb(async (db) => {
    const rows = await db.$queryRaw<Array<{ organizationId: string }>>(Prisma.sql`
      SELECT DISTINCT occ."organizationId"
      FROM "restaurant_sop_occurrences" occ
      WHERE occ."windowEndsAt" <= ${now}
        AND (
          occ."windowEndsAt" >= ${lookbackStart}
          OR EXISTS (
            SELECT 1
            FROM "restaurant_sop_escalation_events" fired
            WHERE fired."occurrenceId" = occ.id
              AND fired.kind = 'FIRED'
              AND fired."createdAt" >= ${lookbackStart}
          )
        )
        AND occ."status" IN ('SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'LATE', 'MISSED')
        AND occ."organizationId" <> ''
        AND EXISTS (
          SELECT 1
          FROM "restaurant_sop_escalation_policies" policy
          JOIN "restaurant_sop_escalation_steps" step ON step."policyId" = policy.id
          WHERE policy."organizationId" = occ."organizationId"
            AND policy.active = true
            AND policy."createdAt" <= occ."windowEndsAt"
            AND (policy.scope = 'ORG' OR policy."branchId" = occ."branchId")
            AND NOT EXISTS (
              SELECT 1
              FROM "restaurant_sop_escalation_events" terminal
              WHERE terminal."occurrenceId" = occ.id
                AND (
                  terminal.kind = 'STOPPED'
                  OR (policy."stopOnAcknowledged" = true AND terminal.kind = 'ACKNOWLEDGED')
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "restaurant_sop_escalation_events" event
              WHERE event."occurrenceId" = occ.id
                AND event."escalationStepId" = step.id
                AND event.kind = 'FIRED'
            )
        )
    `);
    return rows.map((row) => row.organizationId);
  });
  sopDiscoveryCache = { bucket, organizationIds };
  return organizationIds;
}

/** The privileged cross-org discovery scan. Reads only — never mutates a tenant
 * row outside its RLS context (D13 §5). Returns orgs with ordinary pending
 * scheduler or outbox work plus (throttled) SOP escalation candidates; per-org
 * due-ness is filtered later. */
async function defaultDiscoverOrganizations(now: Date): Promise<string[]> {
  const [queued, escalation] = await Promise.all([
    withPlatformDb(async (db) => {
      const rows = await db.$queryRaw<Array<{ organizationId: string }>>(Prisma.sql`
        SELECT DISTINCT "organizationId"
        FROM (
          SELECT "organizationId"
          FROM "restaurant_jobs"
          WHERE "status" IN ('QUEUED', 'RUNNING') AND "type" <> ${DEMO_RESET_JOB_TYPE}
          UNION
          SELECT "organizationId" FROM "restaurant_event_outbox" WHERE "status" = 'PENDING'
        ) AS pending
        WHERE "organizationId" <> ''
      `);
      return rows.map((row) => row.organizationId);
    }),
    discoverSopEscalationOrganizations(now),
  ]);
  return [...new Set([...queued, ...escalation])].sort();
}

const defaultRunInOrg: RunInOrg = (organizationId, work) => withTenantDb(organizationId, work);

/**
 * Run ONE worker tick: discover organizations with due work, then for each org (in
 * its RLS context) recover stale jobs, drain due jobs through the registered
 * handlers, and dispatch due outbox rows through the registered consumers. Honors
 * `signal` between organizations (graceful shutdown); the in-flight drain releases
 * its just-claimed job on abort.
 */
export async function runRestaurantWorkerTick(
  options: RunRestaurantWorkerTickOptions
): Promise<RestaurantWorkerTickResult> {
  const workerId = options.workerId?.trim();
  if (!workerId) {
    throw new Error('runRestaurantWorkerTick requires a non-empty workerId.');
  }
  const now = options.now ?? new Date();
  const outboxConsumers = options.outboxConsumers ?? restaurantOutboxConsumers;
  const discover = options.discoverOrganizations ?? defaultDiscoverOrganizations;
  const runInOrg = options.runInOrg ?? defaultRunInOrg;
  const outboxClient = options.outboxClient ?? ((organizationId) => createTenantDb(organizationId));
  const maxJobsPerOrg = options.maxJobsPerOrg ?? DEFAULT_MAX_JOBS_PER_ORG;
  const maxOutboxPerOrg = options.maxOutboxPerOrg ?? DEFAULT_MAX_OUTBOX_PER_ORG;

  const result: RestaurantWorkerTickResult = {
    organizations: 0,
    recovered: 0,
    jobs: emptyDrain(),
    outbox: emptyOutbox(),
  };

  const organizationIds = await discover(now);
  for (const organizationId of organizationIds) {
    if (options.signal?.aborted) break;
    result.organizations += 1;

    // Materialize time-driven escalation work before draining. Discovery includes
    // organizations with eligible SOP occurrences, so this runs even when their
    // queue is completely empty; no separately seeded sweep job is required.
    // A failing sweep in one tenant must not starve recovery, drain, and outbox
    // dispatch for this or any later organization in the tick.
    try {
      await runInOrg(organizationId, (db) =>
        (options.produceDueJobs ?? enqueueDueSopEscalations)(db, now)
      );
    } catch (error) {
      // Constant format string: the org id is passed as an argument, never
      // interpolated into the format, so it cannot inject format specifiers.
      console.error(
        '[restaurant-worker] SOP escalation producer failed for org %s',
        organizationId,
        error
      );
    }

    if (options.signal?.aborted) break;

    // 1. Requeue jobs abandoned by a crashed worker (in this org's RLS scope).
    result.recovered += await runInOrg(organizationId, (db) =>
      recoverStaleJobs(db, {
        now,
        leaseMs: options.leaseMs,
        excludeJobType: DEMO_RESET_JOB_TYPE,
      })
    );

    if (options.signal?.aborted) break;

    // 2. Drain due jobs. Claim/settle run in fresh per-op tenant transactions; the
    //    handler runs the registered job handler inside the org's RLS context.
    const drain = await drainDueJobs({
      runScoped: (work) => runInOrg(organizationId, work),
      workerId,
      excludeJobType: DEMO_RESET_JOB_TYPE,
      handler: (job) => runInOrg(organizationId, (db) => runRestaurantJob({ db, job })),
      signal: options.signal,
      clock: () => now,
      maxJobs: maxJobsPerOrg,
    });
    addDrain(result.jobs, drain);

    if (options.signal?.aborted) break;

    // 3. Dispatch due outbox rows for this org (each row in its own tenant tx).
    const outbox = await dispatchOutboxBatch(outboxClient(organizationId), {
      registry: outboxConsumers,
      now,
      batchSize: maxOutboxPerOrg,
      signal: options.signal,
    });
    addOutbox(result.outbox, outbox);
  }

  return result;
}

export type RunRestaurantWorkerOptions = Omit<RunRestaurantWorkerTickOptions, 'now'> & {
  /** Injectable clock — each tick's `now`. Defaults to the system clock. */
  clock?: Clock;
  /** Idle sleep between ticks with no work (default {@link DEFAULT_POLL_INTERVAL_MS}). */
  pollIntervalMs?: number;
  /** Safety bound on ticks (default: unbounded — the daemon runs until aborted). */
  maxTicks?: number;
  /** Called with each tick's result (logging / metrics). */
  onTick?: (result: RestaurantWorkerTickResult) => void;
  /** Injectable interruptible sleep (default = a `setTimeout` that wakes on abort). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type RestaurantWorkerRunResult = {
  ticks: number;
  organizations: number;
  recovered: number;
  jobs: DrainResult;
  outbox: OutboxDispatchSummary;
  stoppedBy: 'signal' | 'maxTicks';
};

/** A `setTimeout` sleep that resolves early when `signal` aborts (responsive
 * graceful shutdown — the daemon never waits out a full poll interval to stop). */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Run the worker as a daemon loop: repeat {@link runRestaurantWorkerTick} until
 * `signal` aborts (graceful shutdown) or `maxTicks` is reached, sleeping
 * `pollIntervalMs` only when a tick found no work. Returns aggregate totals.
 */
export async function runRestaurantWorker(
  options: RunRestaurantWorkerOptions
): Promise<RestaurantWorkerRunResult> {
  const clock = options.clock ?? (() => new Date());
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxTicks = options.maxTicks ?? Number.POSITIVE_INFINITY;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;

  const totals: RestaurantWorkerRunResult = {
    ticks: 0,
    organizations: 0,
    recovered: 0,
    jobs: emptyDrain(),
    outbox: emptyOutbox(),
    stoppedBy: 'signal',
  };

  while (totals.ticks < maxTicks) {
    if (signal?.aborted) break;

    const tick = await runRestaurantWorkerTick({ ...options, now: clock() });
    totals.ticks += 1;
    totals.organizations += tick.organizations;
    totals.recovered += tick.recovered;
    addDrain(totals.jobs, tick.jobs);
    addOutbox(totals.outbox, tick.outbox);
    options.onTick?.(tick);

    if (signal?.aborted) break;

    const didWork =
      tick.jobs.claimed > 0 ||
      tick.outbox.dispatched + tick.outbox.retried + tick.outbox.dead > 0 ||
      tick.recovered > 0;
    if (!didWork) {
      await sleep(pollIntervalMs, signal);
    }
  }

  totals.stoppedBy = signal?.aborted ? 'signal' : 'maxTicks';
  return totals;
}
