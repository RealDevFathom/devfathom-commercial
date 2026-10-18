import 'server-only';

import { z } from 'zod';

import { demoOrganizationId, getDemoSeatCount, isDemoEnabled } from '@/lib/demo/config';
import { resetDemoSeatInTransaction } from '@/lib/demo/reset';
import type { RestaurantJobHandler } from '@/lib/restaurant/job-handlers';
import {
  DEMO_RESET_JOB_TYPE,
  drainDueJobs,
  enqueue,
  recoverStaleJobs,
  runSchedulerTransaction,
  type DrainResult,
  type EnqueueResult,
} from '@/lib/restaurant/scheduler';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

export { DEMO_RESET_JOB_TYPE } from '@/lib/restaurant/scheduler';
/** One reset may rebuild 90 days of demo data in the same tenant transaction. */
export const DEMO_RESET_TRANSACTION_TIMEOUT_MS = 30 * 60_000;
/** Outlive the transaction timeout so another cron cannot recover active work. */
export const DEMO_RESET_LEASE_MS = 45 * 60_000;

const KARACHI_OFFSET_MS = 5 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const ORGANIZATION_ID_PATTERN = /^[a-zA-Z0-9_-]{3,128}$/;
const payloadSchema = z
  .object({ organizationId: z.string().regex(ORGANIZATION_ID_PATTERN) })
  .strict();

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('Demo reset requires a valid date.');
  }
}

function nextResetAt(now: Date): Date {
  const karachiNow = new Date(now.getTime() + KARACHI_OFFSET_MS);
  let next = new Date(
    Date.UTC(karachiNow.getUTCFullYear(), karachiNow.getUTCMonth(), karachiNow.getUTCDate(), -2)
  );
  if (next.getTime() <= now.getTime()) next = new Date(next.getTime() + DAY_MS);
  return next;
}

async function assertSharedRestaurantDemo(db: ScopedDb, organizationId: string): Promise<void> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, isDemo: true, deploymentMode: true, vertical: true },
  });
  if (
    !organization?.isDemo ||
    organization.deploymentMode !== 'SHARED' ||
    organization.vertical !== 'RESTAURANT'
  ) {
    throw new Error('Demo reset is restricted to a flagged SHARED restaurant organization.');
  }
}

export async function scheduleDemoReset(
  db: ScopedDb,
  input: { organizationId: string; now?: Date }
): Promise<EnqueueResult> {
  const parsed = payloadSchema.parse({ organizationId: input.organizationId });
  const now = input.now ?? new Date();
  assertValidDate(now);
  await assertSharedRestaurantDemo(db, parsed.organizationId);

  const scheduledAt = nextResetAt(now);
  const localDate = new Date(scheduledAt.getTime() + KARACHI_OFFSET_MS).toISOString().slice(0, 10);
  return enqueue(
    db,
    {
      type: DEMO_RESET_JOB_TYPE,
      payload: parsed,
      scheduledAt,
      idempotencyKey: `${DEMO_RESET_JOB_TYPE}:${parsed.organizationId}:${localDate}`,
    },
    now
  );
}

export const demoResetJobHandler: RestaurantJobHandler = async ({ db, job }) => {
  if (!isDemoEnabled()) throw new Error('Restaurant demo is disabled.');
  if (job.type !== DEMO_RESET_JOB_TYPE) throw new Error('Unexpected restaurant demo job type.');
  const payload = payloadSchema.parse(job.payload);
  if (payload.organizationId !== job.organizationId) {
    throw new Error('Demo reset payload organization does not match the claimed job scope.');
  }
  assertValidDate(job.startedAt);

  await runSchedulerTransaction(db, async (tx) => {
    await assertSharedRestaurantDemo(tx, payload.organizationId);
    await resetDemoSeatInTransaction(tx, {
      organizationId: payload.organizationId,
      now: job.startedAt,
    });
    await scheduleDemoReset(tx, {
      organizationId: payload.organizationId,
      now: job.startedAt,
    });
  });
};

export type ProcessDueDemoResetJobsInput = {
  now?: Date;
  maxJobs?: number;
  workerId?: string;
};

export type ProcessDueDemoResetJobsResult = {
  organizations: number;
  recovered: number;
  jobs: DrainResult;
};

function emptyDrain(): DrainResult {
  return { claimed: 0, succeeded: 0, retried: 0, dead: 0, failed: 0, released: 0 };
}

function addDrain(into: DrainResult, from: DrainResult): void {
  for (const key of Object.keys(into) as Array<keyof DrainResult>) into[key] += from[key];
}

export async function processDueDemoResetJobs(
  input: ProcessDueDemoResetJobsInput = {}
): Promise<ProcessDueDemoResetJobsResult> {
  if (!isDemoEnabled()) throw new Error('Restaurant demo is disabled.');
  const fixedNow = input.now;
  const clock = () => fixedNow ?? new Date();
  assertValidDate(clock());
  const seatCount = getDemoSeatCount();
  const maxJobs = input.maxJobs ?? seatCount;
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > seatCount) {
    throw new Error(`maxJobs must be an integer from 1 through ${seatCount}.`);
  }
  const workerId = input.workerId?.trim() || 'demo-restaurants-cron';

  const ids = Array.from({ length: seatCount }, (_, index) => demoOrganizationId(index + 1));
  const organizations = await withPlatformDb((db) =>
    db.organization.findMany({
      where: {
        id: { in: ids },
        isDemo: true,
        deploymentMode: 'SHARED',
        vertical: 'RESTAURANT',
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    })
  );
  const result: ProcessDueDemoResetJobsResult = {
    organizations: 0,
    recovered: 0,
    jobs: emptyDrain(),
  };

  for (const organization of organizations) {
    if (result.jobs.claimed >= maxJobs) break;
    result.organizations += 1;
    const runScoped = <T>(work: (db: ScopedDb) => Promise<T>) =>
      withTenantDb(organization.id, work, {
        maxWait: 30_000,
        timeout: DEMO_RESET_TRANSACTION_TIMEOUT_MS,
      });

    result.recovered += await runScoped(async (db) => {
      await assertSharedRestaurantDemo(db, organization.id);
      return recoverStaleJobs(db, {
        now: clock(),
        leaseMs: DEMO_RESET_LEASE_MS,
        jobType: DEMO_RESET_JOB_TYPE,
      });
    });
    const drained = await drainDueJobs({
      runScoped,
      workerId,
      jobType: DEMO_RESET_JOB_TYPE,
      clock,
      maxJobs: maxJobs - result.jobs.claimed,
      handler: (job) => runScoped((db) => demoResetJobHandler({ db, job })),
    });
    addDrain(result.jobs, drained);
  }

  return result;
}
