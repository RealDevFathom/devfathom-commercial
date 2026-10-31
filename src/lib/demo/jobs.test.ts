import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaimedJob } from '@/lib/restaurant/scheduler';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({
  createTenantDb: vi.fn(),
  reset: vi.fn(),
  withPlatformDb: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock('@/lib/demo/reset', () => ({ resetDemoSeatInTransaction: mocks.reset }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: mocks.createTenantDb,
  withPlatformDb: mocks.withPlatformDb,
  withTenantDb: mocks.withTenantDb,
}));

import {
  DEMO_RESET_JOB_TYPE,
  DEMO_RESET_LEASE_MS,
  DEMO_RESET_TRANSACTION_TIMEOUT_MS,
  demoResetJobHandler,
  processDueDemoResetJobs,
  scheduleDemoReset,
} from '@/lib/demo/jobs';
import { resolveRestaurantJobHandler } from '@/lib/restaurant/job-handlers';

type Row = Record<string, unknown>;
const FIELD_MAX_ATTEMPTS = Symbol('RestaurantJob.maxAttempts');
type DemoOrganization = {
  id: string;
  isDemo: boolean;
  deploymentMode: 'SHARED' | 'DEDICATED';
  vertical: 'RESTAURANT' | 'PHARMACY';
};

const ORGANIZATION_ID = 'org_demo_restaurant_seat_1';
const NOW = new Date('2026-09-04T12:00:00.000Z');
const originalDemoAccessCode = process.env.DEMO_ACCESS_CODE;
const originalDemoSeats = process.env.DEMO_SEATS;

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (
      value &&
      typeof value === 'object' &&
      !(value instanceof Date) &&
      ('increment' in value || 'decrement' in value)
    ) {
      const operation = value as { increment?: number; decrement?: number };
      row[key] = Number(row[key] ?? 0) + (operation.increment ?? -(operation.decrement ?? 0));
    } else {
      row[key] = value;
    }
  }
}

function matches(row: Row, where: Row): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('gte' in condition) {
        const compared = condition.gte === FIELD_MAX_ATTEMPTS ? row.maxAttempts : condition.gte;
        if (!((row[key] as number) >= (compared as number))) return false;
        continue;
      }
      if ('lt' in condition) {
        if (condition.lt === FIELD_MAX_ATTEMPTS) {
          if (!((row[key] as number) < (row.maxAttempts as number))) return false;
          continue;
        }
        if (!((row[key] as Date) < (condition as { lt: Date }).lt)) return false;
        continue;
      }
      return false;
    }
    if (row[key] !== condition) return false;
  }
  return true;
}

function createDemoDb(
  organization: DemoOrganization = {
    id: ORGANIZATION_ID,
    isDemo: true,
    deploymentMode: 'SHARED',
    vertical: 'RESTAURANT',
  },
  seed: Row[] = []
) {
  const jobs = new Map(seed.map((row) => [row.id as string, { ...row }]));
  const executions: Row[] = [];
  const state = { resets: 0, failCreates: false };
  let sequence = seed.length;

  const raw = {
    __state: state,
    organization: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === organization.id ? { ...organization } : null
      ),
    },
    restaurantJob: {
      fields: { maxAttempts: FIELD_MAX_ATTEMPTS },
      findFirst: vi.fn(
        async ({ where }: { where: { idempotencyKey?: string } }) =>
          [...jobs.values()].find((job) => job.idempotencyKey === where.idempotencyKey) ?? null
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => jobs.get(where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Row }) => {
        if (state.failCreates) throw new Error('queue unavailable');
        const row = {
          id: `job_${(sequence += 1)}`,
          organizationId: organization.id,
          createdAt: NOW,
          claimedAt: null,
          claimedBy: null,
          lastError: null,
          ...data,
        };
        jobs.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = jobs.get(where.id);
        if (!row) throw new Error(`Missing fake job ${where.id}.`);
        applyData(row, data);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const row of jobs.values()) {
          if (!matches(row, where)) continue;
          applyData(row, data);
          count += 1;
        }
        return { count };
      }),
    },
    restaurantJobExecution: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        executions.push(data);
        return data;
      }),
    },
    $queryRaw: vi.fn(async (sql: { values: unknown[]; strings?: readonly string[] }) => {
      const now = sql.values[0] as Date;
      const typeFilter = sql.values[1] as string | undefined;
      const excludesType = sql.strings?.join('').includes('<>') ?? false;
      const due = [...jobs.values()]
        .filter(
          (job) =>
            job.status === 'QUEUED' &&
            (job.nextAttemptAt as Date) <= now &&
            (!typeFilter || (excludesType ? job.type !== typeFilter : job.type === typeFilter))
        )
        .sort(
          (left, right) =>
            (left.nextAttemptAt as Date).getTime() - (right.nextAttemptAt as Date).getTime() ||
            (left.createdAt as Date).getTime() - (right.createdAt as Date).getTime()
        );
      return due[0] ? [{ id: due[0].id }] : [];
    }),
    $transaction: vi.fn(async (work: (tx: ScopedDb) => Promise<unknown>) => {
      const jobSnapshot = structuredClone([...jobs.entries()]);
      const stateSnapshot = { ...state };
      try {
        return await work(raw as unknown as ScopedDb);
      } catch (error) {
        jobs.clear();
        for (const [id, row] of jobSnapshot) jobs.set(id, row);
        Object.assign(state, stateSnapshot);
        throw error;
      }
    }),
  };
  const db = raw as unknown as ScopedDb;
  return { db, jobs, executions, state, organization };
}

function queuedJob(id: string, type = DEMO_RESET_JOB_TYPE, organizationId = ORGANIZATION_ID): Row {
  return {
    id,
    organizationId,
    type,
    payload: { organizationId },
    status: 'QUEUED',
    attempts: 0,
    maxAttempts: 5,
    scheduledAt: NOW,
    nextAttemptAt: NOW,
    claimedAt: null,
    claimedBy: null,
    createdAt: NOW,
  };
}

function claimedJob(payload: unknown = { organizationId: ORGANIZATION_ID }): ClaimedJob {
  return {
    id: 'active_reset',
    organizationId: ORGANIZATION_ID,
    type: DEMO_RESET_JOB_TYPE,
    payload: payload as ClaimedJob['payload'],
    attempts: 1,
    maxAttempts: 5,
    claimedBy: 'demo-restaurants-cron',
    startedAt: NOW,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEMO_SEATS = '5';
  process.env.DEMO_ACCESS_CODE = 'enabled-for-jobs-test';
  mocks.reset.mockImplementation(async (db: ScopedDb) => {
    const fake = db as unknown as { __state?: { resets: number } };
    if (fake.__state) fake.__state.resets += 1;
  });
});

afterAll(() => {
  if (originalDemoAccessCode === undefined) delete process.env.DEMO_ACCESS_CODE;
  else process.env.DEMO_ACCESS_CODE = originalDemoAccessCode;
  if (originalDemoSeats === undefined) delete process.env.DEMO_SEATS;
  else process.env.DEMO_SEATS = originalDemoSeats;
});

describe('scheduleDemoReset', () => {
  it.each([
    ['before 03:00 Karachi', '2026-09-04T21:59:59.999Z', '2026-09-04T22:00:00.000Z'],
    ['exactly 03:00 Karachi', '2026-09-04T22:00:00.000Z', '2026-09-05T22:00:00.000Z'],
    ['after UTC midnight', '2026-09-05T00:00:00.000Z', '2026-09-05T22:00:00.000Z'],
  ])('uses next nightly boundary %s', async (_label, input, expected) => {
    const { db } = createDemoDb();
    const result = await scheduleDemoReset(db, {
      organizationId: ORGANIZATION_ID,
      now: new Date(input),
    });
    expect(result.job.scheduledAt).toEqual(new Date(expected));
  });

  it('deduplicates repeated scheduling for the same seat and Karachi date', async () => {
    const { db, jobs } = createDemoDb();
    const first = await scheduleDemoReset(db, { organizationId: ORGANIZATION_ID, now: NOW });
    const second = await scheduleDemoReset(db, { organizationId: ORGANIZATION_ID, now: NOW });
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(jobs.size).toBe(1);
    expect(first.job.idempotencyKey).toBe(`${DEMO_RESET_JOB_TYPE}:${ORGANIZATION_ID}:2026-09-05`);
  });

  it('rejects invalid dates and organizations not flagged as SHARED restaurant demos', async () => {
    const invalid = createDemoDb();
    await expect(
      scheduleDemoReset(invalid.db, {
        organizationId: ORGANIZATION_ID,
        now: new Date(Number.NaN),
      })
    ).rejects.toThrow(/valid date/);
    const ordinary = createDemoDb({
      id: ORGANIZATION_ID,
      isDemo: false,
      deploymentMode: 'SHARED',
      vertical: 'RESTAURANT',
    });
    await expect(
      scheduleDemoReset(ordinary.db, { organizationId: ORGANIZATION_ID, now: NOW })
    ).rejects.toThrow(/flagged SHARED restaurant/);
  });
});

describe('demoResetJobHandler', () => {
  it('is registered and resets plus schedules through one transaction', async () => {
    const fake = createDemoDb();
    await demoResetJobHandler({ db: fake.db, job: claimedJob() });
    expect(resolveRestaurantJobHandler(DEMO_RESET_JOB_TYPE)).toBe(demoResetJobHandler);
    expect(fake.state.resets).toBe(1);
    expect(fake.jobs.size).toBe(1);
    expect([...fake.jobs.values()][0]!.scheduledAt).toEqual(new Date('2026-09-04T22:00:00.000Z'));
  });

  it('validates strict payload and tenant scope before reset', async () => {
    const fake = createDemoDb();
    await expect(
      demoResetJobHandler({
        db: fake.db,
        job: { ...claimedJob(), type: 'sop.sweep' },
      })
    ).rejects.toThrow(/Unexpected restaurant demo job type/);
    await expect(
      demoResetJobHandler({
        db: fake.db,
        job: claimedJob({ organizationId: ORGANIZATION_ID, extra: true }),
      })
    ).rejects.toThrow();
    await expect(
      demoResetJobHandler({
        db: fake.db,
        job: claimedJob({ organizationId: 'org_demo_restaurant_seat_2' }),
      })
    ).rejects.toThrow(/claimed job scope/);
    const ordinary = createDemoDb({
      id: ORGANIZATION_ID,
      isDemo: false,
      deploymentMode: 'SHARED',
      vertical: 'RESTAURANT',
    });
    await expect(demoResetJobHandler({ db: ordinary.db, job: claimedJob() })).rejects.toThrow(
      /flagged SHARED restaurant/
    );
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('stays inert while disabled and runs after re-enable', async () => {
    const fake = createDemoDb();
    delete process.env.DEMO_ACCESS_CODE;
    await expect(demoResetJobHandler({ db: fake.db, job: claimedJob() })).rejects.toThrow(
      /disabled/
    );
    expect(fake.state.resets).toBe(0);

    process.env.DEMO_ACCESS_CODE = 'enabled-for-jobs-test';
    await demoResetJobHandler({ db: fake.db, job: claimedJob() });
    expect(fake.state.resets).toBe(1);
  });

  it('rolls reset back when scheduling the next run fails', async () => {
    const fake = createDemoDb();
    fake.state.failCreates = true;
    await expect(demoResetJobHandler({ db: fake.db, job: claimedJob() })).rejects.toThrow(
      /queue unavailable/
    );
    expect(fake.state.resets).toBe(0);
    expect(fake.jobs.size).toBe(0);
  });
});

describe('processDueDemoResetJobs', () => {
  it('does not query or claim jobs while disabled', async () => {
    delete process.env.DEMO_ACCESS_CODE;
    await expect(processDueDemoResetJobs({ now: NOW })).rejects.toThrow(/disabled/);
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('visits only configured flagged SHARED restaurant demos and drains only demo-reset', async () => {
    const demo = createDemoDb(undefined, [queuedJob('reset'), queuedJob('other', 'sop.sweep')]);
    const ordinary = createDemoDb({
      id: 'org_demo_restaurant_seat_2',
      isDemo: false,
      deploymentMode: 'SHARED',
      vertical: 'RESTAURANT',
    });
    const dedicated = createDemoDb({
      id: 'org_demo_restaurant_seat_3',
      isDemo: true,
      deploymentMode: 'DEDICATED',
      vertical: 'RESTAURANT',
    });
    const candidates = [demo.organization, ordinary.organization, dedicated.organization];
    mocks.withPlatformDb.mockImplementation(async (work: (db: ScopedDb) => Promise<unknown>) =>
      work({
        organization: {
          findMany: async ({ where }: { where: Row }) => {
            const allowed = new Set((where.id as { in: string[] }).in);
            return candidates
              .filter(
                (organization) =>
                  allowed.has(organization.id) &&
                  organization.isDemo === where.isDemo &&
                  organization.deploymentMode === where.deploymentMode &&
                  organization.vertical === where.vertical
              )
              .map(({ id }) => ({ id }));
          },
        },
      } as unknown as ScopedDb)
    );
    const databases = new Map([
      [demo.organization.id, demo.db],
      [ordinary.organization.id, ordinary.db],
      [dedicated.organization.id, dedicated.db],
    ]);
    mocks.withTenantDb.mockImplementation(
      async (organizationId: string, work: (db: ScopedDb) => Promise<unknown>) =>
        work(databases.get(organizationId)!)
    );

    const result = await processDueDemoResetJobs({ now: NOW, maxJobs: 5 });
    expect(result).toMatchObject({ organizations: 1, recovered: 0 });
    expect(result.jobs).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(demo.state.resets).toBe(1);
    expect(demo.jobs.get('reset')!.status).toBe('SUCCEEDED');
    expect(demo.jobs.get('other')!.status).toBe('QUEUED');
    expect(mocks.withTenantDb).toHaveBeenCalledWith(ORGANIZATION_ID, expect.any(Function), {
      maxWait: 30_000,
      timeout: DEMO_RESET_TRANSACTION_TIMEOUT_MS,
    });
    expect(DEMO_RESET_LEASE_MS).toBeGreaterThan(DEMO_RESET_TRANSACTION_TIMEOUT_MS);
  });

  it('applies maxJobs globally across configured demo organizations', async () => {
    const secondOrganizationId = 'org_demo_restaurant_seat_2';
    const first = createDemoDb(undefined, [queuedJob('reset_1')]);
    const second = createDemoDb(
      {
        id: secondOrganizationId,
        isDemo: true,
        deploymentMode: 'SHARED',
        vertical: 'RESTAURANT',
      },
      [queuedJob('reset_2', DEMO_RESET_JOB_TYPE, secondOrganizationId)]
    );
    mocks.withPlatformDb.mockImplementation(async (work: (db: ScopedDb) => Promise<unknown>) =>
      work({
        organization: {
          findMany: async () => [{ id: ORGANIZATION_ID }, { id: secondOrganizationId }],
        },
      } as unknown as ScopedDb)
    );
    const databases = new Map([
      [ORGANIZATION_ID, first.db],
      [secondOrganizationId, second.db],
    ]);
    mocks.withTenantDb.mockImplementation(
      async (organizationId: string, work: (db: ScopedDb) => Promise<unknown>) =>
        work(databases.get(organizationId)!)
    );

    const firstRun = await processDueDemoResetJobs({ now: NOW, maxJobs: 1 });
    expect(firstRun.jobs).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(first.state.resets + second.state.resets).toBe(1);
    expect(second.jobs.get('reset_2')!.status).toBe('QUEUED');

    const secondRun = await processDueDemoResetJobs({ now: NOW, maxJobs: 1 });
    expect(secondRun.jobs).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(first.state.resets + second.state.resets).toBe(2);
    expect(second.jobs.get('reset_2')!.status).toBe('SUCCEEDED');
  });

  it.each([3, 4])(
    'does not reset a stale job with %i attempts against a budget of 3',
    async (attempts) => {
      const abandoned = {
        status: 'RUNNING',
        claimedAt: new Date(NOW.getTime() - DEMO_RESET_LEASE_MS - 1),
        claimedBy: 'dead-worker',
      };
      const demo = createDemoDb(undefined, [
        { ...queuedJob('exhausted'), ...abandoned, attempts, maxAttempts: 3 },
        { ...queuedJob('retryable'), ...abandoned, attempts: 1, maxAttempts: 2 },
      ]);
      mocks.withPlatformDb.mockImplementation(async (work: (db: ScopedDb) => Promise<unknown>) =>
        work({
          organization: { findMany: async () => [{ id: ORGANIZATION_ID }] },
        } as unknown as ScopedDb)
      );
      mocks.withTenantDb.mockImplementation(
        async (_organizationId: string, work: (db: ScopedDb) => Promise<unknown>) => work(demo.db)
      );

      const result = await processDueDemoResetJobs({ now: NOW, maxJobs: 1 });

      expect(result.recovered).toBe(2);
      expect(result.jobs).toMatchObject({ claimed: 1, succeeded: 1 });
      expect(demo.state.resets).toBe(1);
      expect(demo.jobs.get('exhausted')).toMatchObject({
        status: 'DEAD',
        attempts,
        claimedAt: null,
        claimedBy: null,
      });
      expect(demo.jobs.get('retryable')).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
      expect(demo.executions).toHaveLength(1);
      expect(demo.executions[0]!.jobId).toBe('retryable');
    }
  );

  it('rolls back a failed reset and requeues it through scheduler retry', async () => {
    const demo = createDemoDb(undefined, [queuedJob('reset')]);
    mocks.reset.mockRejectedValueOnce(new Error('seed rebuild failed'));
    mocks.withPlatformDb.mockImplementation(async (work: (db: ScopedDb) => Promise<unknown>) =>
      work({
        organization: { findMany: async () => [{ id: ORGANIZATION_ID }] },
      } as unknown as ScopedDb)
    );
    mocks.withTenantDb.mockImplementation(
      async (_organizationId: string, work: (db: ScopedDb) => Promise<unknown>) => work(demo.db)
    );

    const result = await processDueDemoResetJobs({ now: NOW, maxJobs: 1 });
    expect(result.jobs).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
    expect(demo.jobs.get('reset')).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
    });
    expect(demo.executions).toHaveLength(1);
    expect(demo.executions[0]).toMatchObject({ outcome: 'FAILED', error: 'seed rebuild failed' });
  });
});
