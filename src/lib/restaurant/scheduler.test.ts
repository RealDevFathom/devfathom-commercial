import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  DEFAULT_LEASE_MS,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  SchedulerError,
  backoffMs,
  claimNextDue,
  complete,
  drainDueJobs,
  enqueue,
  fail,
  nextRetryAt,
  recoverStaleJobs,
  releaseClaim,
  type ClaimedJob,
} from '@/lib/restaurant/scheduler';

// A minimal in-memory ScopedDb that mirrors the exact Prisma operations the
// scheduler primitive performs — enough to exercise the enqueue guard, the
// claim/settle state machine, backoff-with-injected-clock, stale recovery,
// graceful release, and the single-worker drain loop DETERMINISTICALLY (no DB).
// The binding >=8-way concurrency + exactly-once evidence lives in the DB
// battery tests/restaurant-m7-scheduler-concurrency.test.ts.
type Row = Record<string, unknown>;

function coerceNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function applyData(target: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (
      value &&
      typeof value === 'object' &&
      !(value instanceof Date) &&
      ('increment' in value || 'decrement' in value || 'set' in value)
    ) {
      const op = value as { increment?: number; decrement?: number; set?: unknown };
      if (op.increment !== undefined) target[key] = coerceNumber(target[key]) + op.increment;
      else if (op.decrement !== undefined) target[key] = coerceNumber(target[key]) - op.decrement;
      else target[key] = op.set;
    } else {
      target[key] = value;
    }
  }
}

function matchWhere(row: Row, where: Row): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const cond = condition as { lt?: Date; not?: unknown };
      if ('lt' in cond) {
        const current = row[key] as Date | null | undefined;
        if (!(current instanceof Date) || !(current < cond.lt!)) return false;
      } else if ('not' in cond) {
        if (row[key] === cond.not) return false;
      } else {
        return false;
      }
    } else if (row[key] !== condition) {
      return false;
    }
  }
  return true;
}

function createFakeDb(seed: Row[] = []) {
  const jobs = new Map<string, Row>();
  const executions: Row[] = [];
  let seq = 0;
  for (const row of seed) {
    jobs.set(row.id as string, {
      ...(row.status === 'RUNNING' ? { claimToken: 'claim-current' } : {}),
      ...row,
    });
  }

  const restaurantJob = {
    findFirst: async ({ where }: { where: Row }) => {
      for (const row of jobs.values()) {
        if (where.idempotencyKey !== undefined && row.idempotencyKey !== where.idempotencyKey) {
          continue;
        }
        return { ...row };
      }
      return null;
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = jobs.get(where.id);
      return row ? { ...row } : null;
    },
    create: async ({ data }: { data: Row }) => {
      const id = (data.id as string | undefined) ?? `job_${(seq += 1)}`;
      if (data.idempotencyKey != null) {
        for (const row of jobs.values()) {
          if (row.idempotencyKey === data.idempotencyKey) {
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
            });
          }
        }
      }
      const now = new Date();
      const row: Row = {
        id,
        organizationId: 'org_test',
        attempts: 0,
        status: 'QUEUED',
        payload: {},
        claimedAt: null,
        claimedBy: null,
        lastError: null,
        idempotencyKey: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      jobs.set(id, row);
      return { ...row };
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
      const row = { id: `exec_${(seq += 1)}`, ...data };
      executions.push(row);
      return { ...row };
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

const T0 = new Date('2026-08-20T12:00:00.000Z');

describe('scheduler backoff', () => {
  it('is exponential from the base delay and capped', () => {
    expect(backoffMs(1)).toBe(RETRY_BASE_MS);
    expect(backoffMs(2)).toBe(RETRY_BASE_MS * 2);
    expect(backoffMs(3)).toBe(RETRY_BASE_MS * 4);
    expect(backoffMs(50)).toBe(RETRY_CAP_MS);
    // A zero/negative attempt count never underflows the exponent.
    expect(backoffMs(0)).toBe(RETRY_BASE_MS);
  });

  it('schedules the next retry from the injected clock', () => {
    expect(nextRetryAt(2, T0).getTime()).toBe(T0.getTime() + RETRY_BASE_MS * 2);
  });
});

describe('enqueue', () => {
  it('rejects an empty type and a non-positive maxAttempts', async () => {
    const { db } = createFakeDb();
    await expect(enqueue(db, { type: '  ' })).rejects.toMatchObject({ reason: 'INVALID' });
    await expect(enqueue(db, { type: 'sop.sweep', maxAttempts: 0 })).rejects.toMatchObject({
      reason: 'INVALID',
    });
  });

  it('creates a QUEUED job due at scheduledAt', async () => {
    const { db, jobs } = createFakeDb();
    const { job, deduplicated } = await enqueue(
      db,
      { type: 'sop.generateOccurrences', payload: { assignmentId: 'a1' }, scheduledAt: T0 },
      T0
    );
    expect(deduplicated).toBe(false);
    expect(job.status).toBe('QUEUED');
    expect(job.nextAttemptAt).toEqual(T0);
    expect(jobs.size).toBe(1);
  });

  it('deduplicates a repeat enqueue of the same idempotency key', async () => {
    const { db, jobs } = createFakeDb();
    const first = await enqueue(db, { type: 'sop.sweep', idempotencyKey: 'key-1' }, T0);
    const second = await enqueue(db, { type: 'sop.sweep', idempotencyKey: 'key-1' }, T0);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(jobs.size).toBe(1);
  });
});

describe('complete', () => {
  it('rejects a missing or non-running job', async () => {
    const { db } = createFakeDb([{ id: 'j1', status: 'QUEUED', attempts: 0, maxAttempts: 5 }]);
    await expect(
      complete(db, 'missing', {
        workerId: 'worker-a',
        attempt: 1,
        claimToken: 'claim-current',
      })
    ).rejects.toMatchObject({ reason: 'JOB_NOT_FOUND' });
    await expect(
      complete(db, 'j1', { workerId: 'worker-a', attempt: 1, claimToken: 'claim-current' })
    ).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
  });

  it('marks a running job SUCCEEDED and appends one execution', async () => {
    const { db, jobs, executions } = createFakeDb([
      {
        id: 'j1',
        status: 'RUNNING',
        attempts: 1,
        maxAttempts: 5,
        claimedAt: T0,
        claimedBy: 'worker-a',
      },
    ]);
    await complete(db, 'j1', {
      workerId: 'worker-a',
      attempt: 1,
      claimToken: 'claim-current',
      now: new Date(T0.getTime() + 5_000),
    });
    expect(jobs.get('j1')!.status).toBe('SUCCEEDED');
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      jobId: 'j1',
      workerId: 'worker-a',
      attempt: 1,
      outcome: 'SUCCEEDED',
      error: null,
    });
    expect(executions[0]!.startedAt).toEqual(T0);
  });
});

describe('fail', () => {
  it('retries with exponential backoff while attempts remain', async () => {
    const { db, jobs, executions } = createFakeDb([
      {
        id: 'j1',
        status: 'RUNNING',
        attempts: 1,
        maxAttempts: 3,
        claimedAt: T0,
        claimedBy: 'worker-a',
      },
    ]);
    const outcome = await fail(db, 'j1', new Error('boom'), {
      workerId: 'worker-a',
      attempt: 1,
      claimToken: 'claim-current',
      now: T0,
    });
    expect(outcome).toBe('retried');
    const job = jobs.get('j1')!;
    expect(job.status).toBe('QUEUED');
    expect(job.claimedAt).toBeNull();
    expect(job.claimedBy).toBeNull();
    expect(job.nextAttemptAt).toEqual(new Date(T0.getTime() + RETRY_BASE_MS));
    expect(job.lastError).toBe('boom');
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ outcome: 'FAILED', attempt: 1, error: 'boom' });
  });

  it('moves the job to DEAD once bounded retries are exhausted', async () => {
    const { db, jobs, executions } = createFakeDb([
      {
        id: 'j1',
        status: 'RUNNING',
        attempts: 3,
        maxAttempts: 3,
        claimedAt: T0,
        claimedBy: 'worker-a',
      },
    ]);
    const outcome = await fail(db, 'j1', new Error('boom'), {
      workerId: 'worker-a',
      attempt: 3,
      claimToken: 'claim-current',
      now: T0,
    });
    expect(outcome).toBe('dead');
    expect(jobs.get('j1')!.status).toBe('DEAD');
    expect(executions).toHaveLength(1);
  });

  it('moves a permanent failure straight to FAILED without retrying', async () => {
    const { db, jobs } = createFakeDb([
      {
        id: 'j1',
        status: 'RUNNING',
        attempts: 1,
        maxAttempts: 5,
        claimedAt: T0,
        claimedBy: 'worker-a',
      },
    ]);
    const outcome = await fail(db, 'j1', new Error('bad payload'), {
      workerId: 'worker-a',
      attempt: 1,
      claimToken: 'claim-current',
      now: T0,
      permanent: true,
    });
    expect(outcome).toBe('failed');
    expect(jobs.get('j1')!.status).toBe('FAILED');
  });

  it('refuses to settle a job that is not RUNNING', async () => {
    const { db } = createFakeDb([{ id: 'j1', status: 'QUEUED', attempts: 0, maxAttempts: 5 }]);
    await expect(
      fail(db, 'j1', new Error('x'), {
        workerId: 'worker-a',
        attempt: 1,
        claimToken: 'claim-current',
      })
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });

  it.each([
    ['complete', 'worker-b', 2, 'claim-stale'],
    ['complete', 'worker-b', 1, 'claim-current'],
    ['complete', 'worker-a', 2, 'claim-current'],
    ['fail', 'worker-b', 2, 'claim-stale'],
    ['fail', 'worker-b', 1, 'claim-current'],
    ['fail', 'worker-a', 2, 'claim-current'],
  ] as const)(
    'rejects a stale claim attempting to %s with worker %s at attempt %i and token %s',
    async (operation, workerId, attempt, claimToken) => {
      const { db, jobs, executions } = createFakeDb([
        {
          id: 'j1',
          status: 'RUNNING',
          attempts: 2,
          maxAttempts: 5,
          claimedAt: new Date(T0.getTime() + DEFAULT_LEASE_MS),
          claimedBy: 'worker-b',
        },
      ]);

      const settlement =
        operation === 'complete'
          ? complete(db, 'j1', {
              workerId,
              attempt,
              claimToken,
              now: T0,
            })
          : fail(db, 'j1', new Error('late failure'), {
              workerId,
              attempt,
              claimToken,
              now: T0,
            });

      await expect(settlement).rejects.toMatchObject({ reason: 'INVALID_STATE' });
      expect(jobs.get('j1')).toMatchObject({
        status: 'RUNNING',
        attempts: 2,
        claimedBy: 'worker-b',
      });
      expect(executions).toHaveLength(0);
    }
  );
});

describe('recoverStaleJobs', () => {
  it('requeues only RUNNING jobs whose lease has expired', async () => {
    const stale = new Date(T0.getTime() - DEFAULT_LEASE_MS - 1_000);
    const fresh = new Date(T0.getTime() - 1_000);
    const { db, jobs } = createFakeDb([
      { id: 'stale', status: 'RUNNING', attempts: 1, maxAttempts: 5, claimedAt: stale },
      { id: 'fresh', status: 'RUNNING', attempts: 1, maxAttempts: 5, claimedAt: fresh },
    ]);
    const recovered = await recoverStaleJobs(db, { now: T0 });
    expect(recovered).toBe(1);
    expect(jobs.get('stale')).toMatchObject({
      status: 'QUEUED',
      claimedAt: null,
      claimedBy: null,
      claimToken: null,
    });
    expect(jobs.get('fresh')).toMatchObject({
      status: 'RUNNING',
      claimToken: 'claim-current',
    });
  });

  it('recovers only the requested job type', async () => {
    const stale = new Date(T0.getTime() - DEFAULT_LEASE_MS - 1_000);
    const { db, jobs } = createFakeDb([
      {
        id: 'demo',
        type: 'demo-reset',
        status: 'RUNNING',
        attempts: 1,
        maxAttempts: 5,
        claimedAt: stale,
      },
      {
        id: 'other',
        type: 'sop.sweep',
        status: 'RUNNING',
        attempts: 1,
        maxAttempts: 5,
        claimedAt: stale,
      },
    ]);
    expect(await recoverStaleJobs(db, { now: T0, jobType: 'demo-reset' })).toBe(1);
    expect(jobs.get('demo')!.status).toBe('QUEUED');
    expect(jobs.get('other')!.status).toBe('RUNNING');
  });

  it('leaves an excluded stale job running', async () => {
    const stale = new Date(T0.getTime() - DEFAULT_LEASE_MS - 1_000);
    const { db, jobs } = createFakeDb([
      {
        id: 'demo',
        type: 'demo-reset',
        status: 'RUNNING',
        attempts: 1,
        maxAttempts: 5,
        claimedAt: stale,
      },
      {
        id: 'other',
        type: 'sop.sweep',
        status: 'RUNNING',
        attempts: 1,
        maxAttempts: 5,
        claimedAt: stale,
      },
    ]);
    expect(await recoverStaleJobs(db, { now: T0, excludeJobType: 'demo-reset' })).toBe(1);
    expect(jobs.get('demo')!.status).toBe('RUNNING');
    expect(jobs.get('other')!.status).toBe('QUEUED');
  });
});

describe('releaseClaim', () => {
  it('restores a running job to QUEUED and rolls back the claim attempt', async () => {
    const { db, jobs } = createFakeDb([
      { id: 'j1', status: 'RUNNING', attempts: 1, maxAttempts: 5, claimedAt: T0, claimedBy: 'w' },
    ]);
    await releaseClaim(db, 'j1', {
      workerId: 'w',
      attempt: 1,
      claimToken: 'claim-current',
      now: T0,
    });
    const job = jobs.get('j1')!;
    expect(job.status).toBe('QUEUED');
    expect(job.attempts).toBe(0);
    expect(job.claimedBy).toBeNull();
    expect(job.claimToken).toBeNull();
  });

  it.each(['complete', 'fail'] as const)(
    'rejects a released claim after the same worker reclaims and tries to %s',
    async (operation) => {
      const due = new Date(T0.getTime() - 1_000);
      const { db, jobs, executions } = createFakeDb([
        {
          id: 'j1',
          type: 'test',
          status: 'QUEUED',
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: due,
          createdAt: due,
          payload: {},
        },
      ]);
      const staleClaim = await claimNextDue(db, { workerId: 'worker-a', now: T0 });
      await releaseClaim(db, 'j1', {
        workerId: staleClaim!.claimedBy,
        attempt: staleClaim!.attempts,
        claimToken: staleClaim!.claimToken,
        now: T0,
      });
      const currentClaim = await claimNextDue(db, { workerId: 'worker-a', now: T0 });

      expect(staleClaim?.attempts).toBe(currentClaim?.attempts);
      expect(staleClaim?.claimToken).not.toBe(currentClaim?.claimToken);
      await releaseClaim(db, 'j1', {
        workerId: staleClaim!.claimedBy,
        attempt: staleClaim!.attempts,
        claimToken: staleClaim!.claimToken,
        now: T0,
      });
      const settlement =
        operation === 'complete'
          ? complete(db, 'j1', {
              workerId: 'worker-a',
              attempt: staleClaim!.attempts,
              claimToken: staleClaim!.claimToken,
            })
          : fail(db, 'j1', new Error('stale failure'), {
              workerId: 'worker-a',
              attempt: staleClaim!.attempts,
              claimToken: staleClaim!.claimToken,
            });

      await expect(settlement).rejects.toMatchObject({ reason: 'INVALID_STATE' });
      expect(jobs.get('j1')).toMatchObject({
        status: 'RUNNING',
        attempts: currentClaim!.attempts,
        claimedBy: 'worker-a',
        claimToken: currentClaim!.claimToken,
      });
      expect(executions).toHaveLength(0);
    }
  );

  it("does not release a newer worker's claim with stale ownership", async () => {
    const due = new Date(T0.getTime() - DEFAULT_LEASE_MS - 1_000);
    const { db, jobs } = createFakeDb([
      {
        id: 'j1',
        type: 'test',
        status: 'QUEUED',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: due,
        createdAt: due,
        payload: {},
      },
    ]);
    const staleClaim = await claimNextDue(db, { workerId: 'worker-a', now: due });
    await recoverStaleJobs(db, { now: T0 });
    const currentClaim = await claimNextDue(db, { workerId: 'worker-b', now: T0 });

    await releaseClaim(db, 'j1', {
      workerId: staleClaim!.claimedBy,
      attempt: staleClaim!.attempts,
      claimToken: staleClaim!.claimToken,
      now: T0,
    });

    expect(currentClaim!.claimToken).not.toBe(staleClaim!.claimToken);
    expect(jobs.get('j1')).toMatchObject({
      status: 'RUNNING',
      attempts: currentClaim!.attempts,
      claimedBy: currentClaim!.claimedBy,
      claimToken: currentClaim!.claimToken,
    });
  });
});

describe('claimNextDue', () => {
  it('claims the most-due job and moves it to RUNNING', async () => {
    const earlier = new Date(T0.getTime() - 2_000);
    const later = new Date(T0.getTime() - 1_000);
    const { db, jobs } = createFakeDb([
      {
        id: 'late',
        type: 'sop.sweep',
        status: 'QUEUED',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: later,
        createdAt: later,
        payload: {},
      },
      {
        id: 'early',
        type: 'sop.sweep',
        status: 'QUEUED',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: earlier,
        createdAt: earlier,
        payload: {},
      },
    ]);
    const claimed = await claimNextDue(db, { workerId: 'w1', now: T0 });
    expect(claimed?.id).toBe('early');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.claimToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(jobs.get('early')!.status).toBe('RUNNING');
    expect(jobs.get('early')!.claimedBy).toBe('w1');
    expect(jobs.get('early')!.claimToken).toBe(claimed?.claimToken);
  });

  it('returns null when nothing is due and rejects a blank workerId', async () => {
    const { db } = createFakeDb([
      {
        id: 'future',
        type: 't',
        status: 'QUEUED',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(T0.getTime() + 60_000),
        createdAt: T0,
        payload: {},
      },
    ]);
    expect(await claimNextDue(db, { workerId: 'w', now: T0 })).toBeNull();
    await expect(claimNextDue(db, { workerId: ' ', now: T0 })).rejects.toMatchObject({
      reason: 'INVALID',
    });
    await expect(claimNextDue(db, { workerId: 'w', now: T0, jobType: ' ' })).rejects.toMatchObject({
      reason: 'INVALID',
    });
    await expect(
      claimNextDue(db, {
        workerId: 'w',
        now: T0,
        jobType: 'demo-reset',
        excludeJobType: 'sop.sweep',
      })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('claims only the requested job type', async () => {
    const earlier = new Date(T0.getTime() - 2_000);
    const later = new Date(T0.getTime() - 1_000);
    const { db, jobs } = createFakeDb([
      {
        id: 'other',
        type: 'sop.sweep',
        status: 'QUEUED',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: earlier,
        createdAt: earlier,
        payload: {},
      },
      {
        id: 'demo',
        type: 'demo-reset',
        status: 'QUEUED',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: later,
        createdAt: later,
        payload: {},
      },
    ]);
    expect((await claimNextDue(db, { workerId: 'w', now: T0, jobType: 'demo-reset' }))?.id).toBe(
      'demo'
    );
    expect(jobs.get('other')!.status).toBe('QUEUED');
  });

  it('does not claim an excluded job type', async () => {
    const { db, jobs } = createFakeDb([
      {
        id: 'demo',
        type: 'demo-reset',
        status: 'QUEUED',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(T0.getTime() - 2_000),
        createdAt: new Date(T0.getTime() - 2_000),
        payload: {},
      },
      {
        id: 'other',
        type: 'sop.sweep',
        status: 'QUEUED',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(T0.getTime() - 1_000),
        createdAt: new Date(T0.getTime() - 1_000),
        payload: {},
      },
    ]);
    expect(
      (await claimNextDue(db, { workerId: 'w', now: T0, excludeJobType: 'demo-reset' }))?.id
    ).toBe('other');
    expect(jobs.get('demo')!.status).toBe('QUEUED');
  });
});

describe('drainDueJobs (single worker)', () => {
  const runScoped =
    (db: ScopedDb) =>
    <T>(work: (db: ScopedDb) => Promise<T>): Promise<T> =>
      work(db);

  function seededQueue() {
    return createFakeDb(
      ['a', 'b', 'c'].map((id) => ({
        id,
        type: 'sop.sweep',
        status: 'QUEUED',
        attempts: 0,
        maxAttempts: 3,
        nextAttemptAt: T0,
        createdAt: T0,
        payload: {},
      }))
    );
  }

  it('drains every due job exactly once through the handler', async () => {
    const { db, jobs, executions } = seededQueue();
    const seen: string[] = [];
    const result = await drainDueJobs({
      runScoped: runScoped(db),
      workerId: 'w1',
      clock: () => T0,
      handler: async (job: ClaimedJob) => {
        seen.push(job.id);
      },
    });
    expect(result.claimed).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    expect([...jobs.values()].every((job) => job.status === 'SUCCEEDED')).toBe(true);
    expect(executions.filter((execution) => execution.outcome === 'SUCCEEDED')).toHaveLength(3);
  });

  it('settles a throwing handler through the retry path', async () => {
    const { db, executions } = seededQueue();
    const result = await drainDueJobs({
      runScoped: runScoped(db),
      workerId: 'w1',
      clock: () => T0,
      maxJobs: 3,
      handler: async () => {
        throw new Error('handler exploded');
      },
    });
    expect(result.claimed).toBe(3);
    expect(result.retried).toBe(3);
    expect(result.succeeded).toBe(0);
    expect(executions.every((execution) => execution.outcome === 'FAILED')).toBe(true);
  });

  it('stops claiming when the abort signal is already set', async () => {
    const { db } = seededQueue();
    const controller = new AbortController();
    controller.abort();
    const result = await drainDueJobs({
      runScoped: runScoped(db),
      workerId: 'w1',
      clock: () => T0,
      signal: controller.signal,
      handler: async () => undefined,
    });
    expect(result.claimed).toBe(0);
  });
});

describe('SchedulerError', () => {
  it('carries a machine-readable reason', () => {
    const error = new SchedulerError('nope', 'INVALID');
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe('INVALID');
    expect(error.name).toBe('SchedulerError');
  });
});
