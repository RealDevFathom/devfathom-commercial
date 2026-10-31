import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { OutboxConsumerRegistry } from '@/lib/restaurant/outbox-dispatcher';

const mocks = vi.hoisted(() => ({
  runRestaurantJob: vi.fn(),
}));

// Decouple the runner ORCHESTRATION test from the concrete handler registry: the
// runner's job dispatch is `runRestaurantJob({ db, job })`, which we control here.
vi.mock('@/lib/restaurant/job-handlers', () => ({
  runRestaurantJob: mocks.runRestaurantJob,
}));
vi.mock('@/lib/demo/jobs', () => ({ DEMO_RESET_JOB_TYPE: 'demo-reset' }));

import {
  runRestaurantWorker,
  runRestaurantWorkerTick,
  type RestaurantWorkerTickResult,
} from '@/lib/restaurant/job-runner';

type Row = Record<string, unknown>;
const FIELD_MAX_ATTEMPTS = Symbol('RestaurantJob.maxAttempts');

function applyData(target: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (
      value &&
      typeof value === 'object' &&
      !(value instanceof Date) &&
      ('increment' in value || 'decrement' in value)
    ) {
      const op = value as { increment?: number; decrement?: number };
      if (op.increment !== undefined) target[key] = ((target[key] as number) ?? 0) + op.increment;
      else target[key] = ((target[key] as number) ?? 0) - (op.decrement as number);
    } else {
      target[key] = value;
    }
  }
}

function matchWhere(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('gte' in cond) {
        const compared = cond.gte === FIELD_MAX_ATTEMPTS ? row.maxAttempts : cond.gte;
        if (!((row[key] as number) >= (compared as number))) return false;
      } else if ('lt' in cond) {
        if (cond.lt === FIELD_MAX_ATTEMPTS) {
          if (!((row[key] as number) < (row.maxAttempts as number))) return false;
          continue;
        }
        const current = row[key] as Date | null | undefined;
        if (!(current instanceof Date) || !(current < (cond as { lt: Date }).lt)) return false;
      } else if ('not' in cond) {
        if (row[key] === (cond as { not: unknown }).not) return false;
      } else {
        return false;
      }
    } else if (row[key] !== cond) {
      return false;
    }
  }
  return true;
}

const T0 = new Date('2026-08-20T12:00:00.000Z');

/** A per-org fake scheduler db (restaurant_jobs + append-only executions). */
function createJobDb(seed: Row[] = []) {
  const jobs = new Map<string, Row>();
  const executions: Row[] = [];
  let seq = 0;
  for (const row of seed) jobs.set(row.id as string, { ...row });

  const restaurantJob = {
    fields: { maxAttempts: FIELD_MAX_ATTEMPTS },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = jobs.get(where.id);
      return row ? { ...row } : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = jobs.get(where.id);
      if (!row) throw new Error(`fake update: job ${where.id} not found`);
      applyData(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      for (const row of jobs.values()) {
        if (!matchWhere(row, where)) continue;
        applyData(row, data);
        count += 1;
      }
      return { count };
    },
  };

  const restaurantJobExecution = {
    create: async ({ data }: { data: Row }) => {
      executions.push({ id: `exec_${(seq += 1)}`, ...data });
      return {};
    },
  };

  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    $queryRaw: async (sql: { values: unknown[]; strings?: readonly string[] }) => {
      const now = sql.values[0] as Date;
      const typeFilter = sql.values[1] as string | undefined;
      const excludesType = sql.strings?.join('').includes('<>') ?? false;
      const due = [...jobs.values()]
        .filter(
          (row) =>
            row.status === 'QUEUED' &&
            (row.nextAttemptAt as Date) <= now &&
            (!typeFilter || (excludesType ? row.type !== typeFilter : row.type === typeFilter))
        )
        .sort(
          (a, b) =>
            (a.nextAttemptAt as Date).getTime() - (b.nextAttemptAt as Date).getTime() ||
            (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()
        );
      return due.length ? [{ id: due[0]!.id as string }] : [];
    },
    restaurantJob,
    restaurantJobExecution,
  };

  return { db: db as unknown as ScopedDb, jobs, executions };
}

/** A per-org fake outbox db. */
function createOutboxDb(seed: Row[] = []) {
  const rows = new Map<string, Row>();
  for (const row of seed) rows.set(row.id as string, { ...row });

  const restaurantEventOutbox = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id);
      return row ? { ...row } : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = rows.get(where.id);
      if (!row) throw new Error(`fake outbox update: ${where.id} not found`);
      Object.assign(row, data);
      return { ...row };
    },
  };

  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    $queryRaw: async (sql: { values: unknown[] }) => {
      const now = sql.values[0] as Date;
      const excluded = new Set(sql.values.slice(1) as string[]);
      const due = [...rows.values()]
        .filter(
          (row) =>
            row.status === 'PENDING' &&
            (row.nextAttemptAt == null || (row.nextAttemptAt as Date) <= now) &&
            !excluded.has(row.id as string)
        )
        .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
      return due.length ? [{ id: due[0]!.id as string }] : [];
    },
    restaurantEventOutbox,
  };

  return { db: db as unknown as ScopedDb, rows };
}

function queuedJob(overrides: Row = {}): Row {
  return {
    id: 'job_1',
    type: 'sop.sweep',
    payload: {},
    status: 'QUEUED',
    attempts: 0,
    maxAttempts: 5,
    scheduledAt: T0,
    nextAttemptAt: T0,
    claimedAt: null,
    claimedBy: null,
    createdAt: T0,
    ...overrides,
  };
}

function pendingOutbox(overrides: Row = {}): Row {
  return {
    id: 'ob_1',
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: null,
    eventType: 'order.opened',
    aggregateType: 'restaurant.order',
    aggregateId: 'order_1',
    payload: {},
    lastError: null,
    createdAt: T0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runRestaurantJob.mockResolvedValue(undefined);
});

describe('runRestaurantWorkerTick', () => {
  it('rejects an empty workerId', async () => {
    await expect(
      runRestaurantWorkerTick({ workerId: '  ', discoverOrganizations: async () => [] })
    ).rejects.toThrow(/workerId/);
  });

  it('drains due jobs per org inside each org RLS context and dispatches its outbox', async () => {
    const orgA = {
      jobs: createJobDb([queuedJob({ id: 'a1' })]),
      outbox: createOutboxDb([pendingOutbox({ id: 'oa' })]),
    };
    const orgB = {
      jobs: createJobDb([queuedJob({ id: 'b1' })]),
      outbox: createOutboxDb([pendingOutbox({ id: 'ob' })]),
    };
    const jobDbs: Record<string, ReturnType<typeof createJobDb>> = {
      org_a: orgA.jobs,
      org_b: orgB.jobs,
    };
    const outboxDbs: Record<string, ReturnType<typeof createOutboxDb>> = {
      org_a: orgA.outbox,
      org_b: orgB.outbox,
    };

    const registry = new OutboxConsumerRegistry();
    const delivered: string[] = [];
    registry.register('order.opened', async (record) => {
      delivered.push(record.aggregateId);
    });

    const result = await runRestaurantWorkerTick({
      workerId: 'worker-1',
      now: T0,
      outboxConsumers: registry,
      discoverOrganizations: async () => ['org_a', 'org_b'],
      runInOrg: (orgId, work) => work(jobDbs[orgId]!.db),
      outboxClient: (orgId) => outboxDbs[orgId]!.db,
    });

    expect(result.organizations).toBe(2);
    expect(result.jobs.claimed).toBe(2);
    expect(result.jobs.succeeded).toBe(2);
    expect(result.outbox.dispatched).toBe(2);
    expect(delivered.sort()).toEqual(['order_1', 'order_1']);
    // The handler ran once per claimed job, in the org's scope.
    expect(mocks.runRestaurantJob).toHaveBeenCalledTimes(2);
    expect(orgA.jobs.jobs.get('a1')!.status).toBe('SUCCEEDED');
    expect(orgB.jobs.jobs.get('b1')!.status).toBe('SUCCEEDED');
  });

  it('settles a failing handler as a retry and records the execution', async () => {
    mocks.runRestaurantJob.mockRejectedValue(new Error('handler exploded'));
    const org = createJobDb([queuedJob({ id: 'j1' })]);

    const result = await runRestaurantWorkerTick({
      workerId: 'worker-1',
      now: T0,
      discoverOrganizations: async () => ['org_a'],
      runInOrg: (_orgId, work) => work(org.db),
      outboxClient: () => createOutboxDb().db,
    });

    expect(result.jobs.claimed).toBe(1);
    expect(result.jobs.retried).toBe(1);
    expect(result.jobs.succeeded).toBe(0);
    expect(org.jobs.get('j1')!.status).toBe('QUEUED');
    expect(org.executions).toHaveLength(1);
    expect(org.executions[0]!.outcome).toBe('FAILED');
  });

  it('leaves demo-reset claims and stale recovery to the dedicated demo worker', async () => {
    const stale = new Date(T0.getTime() - 20 * 60_000);
    const org = createJobDb([
      queuedJob({ id: 'demo_due', type: 'demo-reset', createdAt: new Date(T0.getTime() - 2_000) }),
      queuedJob({ id: 'ordinary_due', type: 'sop.sweep' }),
      queuedJob({
        id: 'demo_running',
        type: 'demo-reset',
        status: 'RUNNING',
        attempts: 1,
        claimedAt: stale,
      }),
    ]);

    const result = await runRestaurantWorkerTick({
      workerId: 'worker-1',
      now: T0,
      discoverOrganizations: async () => ['org_a'],
      runInOrg: (_orgId, work) => work(org.db),
      outboxClient: () => createOutboxDb().db,
    });

    expect(result.recovered).toBe(0);
    expect(result.jobs).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(org.jobs.get('ordinary_due')!.status).toBe('SUCCEEDED');
    expect(org.jobs.get('demo_due')!.status).toBe('QUEUED');
    expect(org.jobs.get('demo_running')!.status).toBe('RUNNING');
  });

  it('recovers a job abandoned past its lease', async () => {
    const stale = queuedJob({
      id: 'j_stale',
      status: 'RUNNING',
      attempts: 1,
      claimedAt: new Date(T0.getTime() - 60 * 60_000),
      claimedBy: 'dead-worker',
    });
    const org = createJobDb([stale]);

    const result = await runRestaurantWorkerTick({
      workerId: 'worker-1',
      now: T0,
      discoverOrganizations: async () => ['org_a'],
      runInOrg: (_orgId, work) => work(org.db),
      outboxClient: () => createOutboxDb().db,
    });

    // Recovered → requeued at `now` → re-drained within the same tick (prompt retry).
    expect(result.recovered).toBe(1);
    expect(result.jobs.claimed).toBe(1);
    expect(result.jobs.succeeded).toBe(1);
    expect(org.jobs.get('j_stale')!.status).toBe('SUCCEEDED');
  });

  it.each([3, 4])(
    'does not dispatch a stale job with %i attempts against a budget of 3',
    async (attempts) => {
      const abandoned = {
        status: 'RUNNING',
        claimedAt: new Date(T0.getTime() - 60 * 60_000),
        claimedBy: 'dead-worker',
      };
      const org = createJobDb([
        queuedJob({ ...abandoned, id: 'exhausted', attempts, maxAttempts: 3 }),
        queuedJob({ ...abandoned, id: 'retryable', attempts: 1, maxAttempts: 2 }),
      ]);

      const result = await runRestaurantWorkerTick({
        workerId: 'worker-1',
        now: T0,
        discoverOrganizations: async () => ['org_a'],
        runInOrg: (_orgId, work) => work(org.db),
        outboxClient: () => createOutboxDb().db,
      });

      expect(result.recovered).toBe(2);
      expect(result.jobs).toMatchObject({ claimed: 1, succeeded: 1 });
      expect(mocks.runRestaurantJob).toHaveBeenCalledTimes(1);
      expect(org.jobs.get('exhausted')).toMatchObject({
        status: 'DEAD',
        attempts,
        claimedAt: null,
        claimedBy: null,
      });
      expect(org.jobs.get('retryable')).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
      expect(org.executions).toHaveLength(1);
      expect(org.executions[0]!.jobId).toBe('retryable');
    }
  );

  it('stops before doing work when the signal is already aborted', async () => {
    const discover = vi.fn(async () => ['org_a']);
    const runInOrg = vi.fn();
    const controller = new AbortController();
    controller.abort();

    const result = await runRestaurantWorkerTick({
      workerId: 'worker-1',
      now: T0,
      signal: controller.signal,
      discoverOrganizations: discover,
      runInOrg: runInOrg as never,
      outboxClient: () => createOutboxDb().db,
    });

    expect(result.organizations).toBe(0);
    expect(runInOrg).not.toHaveBeenCalled();
  });
});

describe('runRestaurantWorker (daemon loop)', () => {
  it('runs a bounded number of ticks and sleeps only when idle', async () => {
    const sleep = vi.fn(async () => {});
    const ticks: RestaurantWorkerTickResult[] = [];

    const result = await runRestaurantWorker({
      workerId: 'worker-1',
      clock: () => T0,
      maxTicks: 3,
      sleep,
      discoverOrganizations: async () => [],
      onTick: (tick) => ticks.push(tick),
    });

    expect(result.ticks).toBe(3);
    expect(result.stoppedBy).toBe('maxTicks');
    expect(ticks).toHaveLength(3);
    // Every tick was idle (no orgs), so the loop slept between ticks.
    expect(sleep).toHaveBeenCalled();
  });

  it('stops gracefully when the signal aborts', async () => {
    const controller = new AbortController();
    const sleep = vi.fn(async () => {});

    const result = await runRestaurantWorker({
      workerId: 'worker-1',
      clock: () => T0,
      signal: controller.signal,
      sleep,
      discoverOrganizations: async () => [],
      onTick: () => controller.abort(),
    });

    expect(result.ticks).toBe(1);
    expect(result.stoppedBy).toBe('signal');
  });
});
