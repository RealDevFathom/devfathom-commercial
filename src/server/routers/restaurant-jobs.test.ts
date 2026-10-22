/**
 * M7-L2 router — capability gating (`reports:operational`), strict input rejection,
 * cursor-pagination shape, and the requeue-dead command semantics for the
 * background-operations console. Runs the real router against a hand-rolled
 * in-memory db; ABAC/audit/entitlement middleware mocked (platform middleware).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn<(subject: unknown, action: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
  enqueue: vi.fn(),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/restaurant/scheduler', () => ({
  enqueue: mocks.enqueue,
  SchedulerError: class SchedulerError extends Error {
    constructor(
      message: string,
      readonly reason: string
    ) {
      super(message);
    }
  },
}));

import { restaurantJobsRouter } from './restaurant-jobs';
import type { TRPCContext } from '../trpc';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const db = {
  restaurantJob: { findMany: vi.fn(), findUnique: vi.fn() },
  restaurantJobExecution: { findMany: vi.fn() },
  restaurantEventOutbox: { findMany: vi.fn() },
  restaurantWebhookInbox: { findMany: vi.fn() },
};

function caller(canOverride?: boolean) {
  if (canOverride !== undefined) mocks.can.mockResolvedValue(canOverride);
  return restaurantJobsRouter.createCaller({
    db: db as unknown as ScopedDb,
    entitlements: {
      enabledModules: ['restaurant-sop'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'user_test', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_test' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  db.restaurantJob.findMany.mockResolvedValue([]);
  db.restaurantJobExecution.findMany.mockResolvedValue([]);
  db.restaurantEventOutbox.findMany.mockResolvedValue([]);
  db.restaurantWebhookInbox.findMany.mockResolvedValue([]);
});

describe('restaurantJobsRouter — capability gate', () => {
  it('rejects every read + the requeue command when ABAC denies reports:operational', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().listJobs({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().listExecutions({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().listDeadLetters({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().listOutbox({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().listWebhookInbox({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().requeueDeadJob({ jobId: 'j1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('restaurantJobsRouter — strict input', () => {
  it('rejects unknown fields on the reads', async () => {
    await expect(caller().listJobs({ unknownField: true } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller().listOutbox({ nope: 1 } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller().listWebhookInbox({ nope: 1 } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects an invalid status enum value', async () => {
    await expect(caller().listJobs({ status: 'PAUSED' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('restaurantJobsRouter — reads', () => {
  it('paginates: over-fetches limit+1 and returns items + nextCursor', async () => {
    db.restaurantJob.findMany.mockResolvedValue([{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }]);
    const page = await caller().listJobs({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe('j2');
    const args = db.restaurantJob.findMany.mock.calls[0]![0];
    expect(args.take).toBe(3);
  });

  it('returns no cursor when the page is not full', async () => {
    db.restaurantJob.findMany.mockResolvedValue([{ id: 'j1' }]);
    const page = await caller().listJobs({ limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('listDeadLetters filters status=DEAD', async () => {
    await caller().listDeadLetters({ type: 'sop.sweep' });
    const args = db.restaurantJob.findMany.mock.calls[0]![0];
    expect(args.where).toMatchObject({ status: 'DEAD', type: 'sop.sweep' });
  });

  it('listWebhookInbox never selects the raw payload', async () => {
    await caller().listWebhookInbox({ source: 'stripe' });
    const args = db.restaurantWebhookInbox.findMany.mock.calls[0]![0];
    expect(args.select.payload).toBeUndefined();
    expect(args.where).toMatchObject({ source: 'stripe' });
  });

  it('applies a cursor with skip:1', async () => {
    await caller().listExecutions({ jobId: 'j1', cursor: 'exec_9' });
    const args = db.restaurantJobExecution.findMany.mock.calls[0]![0];
    expect(args.cursor).toEqual({ id: 'exec_9' });
    expect(args.skip).toBe(1);
    expect(args.where).toMatchObject({ jobId: 'j1' });
  });
});

describe('restaurantJobsRouter — requeueDeadJob', () => {
  it('creates a NEW job from a dead one and retains the dead row', async () => {
    db.restaurantJob.findUnique.mockResolvedValue({
      id: 'dead_1',
      type: 'sop.sweep',
      payload: { assignmentId: 'a1' },
      maxAttempts: 5,
      status: 'DEAD',
    });
    mocks.enqueue.mockResolvedValue({
      job: { id: 'job_new', status: 'QUEUED' },
      deduplicated: false,
    });

    const result = await caller().requeueDeadJob({ jobId: 'dead_1' });

    expect(result).toEqual({
      requeuedFrom: 'dead_1',
      jobId: 'job_new',
      status: 'QUEUED',
      deduplicated: false,
    });
    const [, enqueueInput] = mocks.enqueue.mock.calls[0]!;
    expect(enqueueInput).toEqual({
      type: 'sop.sweep',
      payload: { assignmentId: 'a1' },
      maxAttempts: 5,
      idempotencyKey: 'dead-job-requeue:dead_1',
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'restaurant.job.requeue',
        targetId: 'dead_1',
        metadata: {
          requeuedFrom: 'dead_1',
          successorJobId: 'job_new',
          deduplicated: false,
        },
      })
    );
  });

  it('returns the same successor when the requeue mutation is replayed', async () => {
    db.restaurantJob.findUnique.mockResolvedValue({
      id: 'dead_1',
      type: 'sop.sweep',
      payload: {},
      maxAttempts: 5,
      status: 'DEAD',
    });
    mocks.enqueue.mockResolvedValue({
      job: { id: 'existing_retry', status: 'QUEUED' },
      deduplicated: true,
    });

    const first = await caller().requeueDeadJob({ jobId: 'dead_1' });
    const replay = await caller().requeueDeadJob({ jobId: 'dead_1' });

    expect(first.jobId).toBe('existing_retry');
    expect(replay).toEqual(first);
    expect(replay.deduplicated).toBe(true);
    expect(mocks.enqueue).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'dead-job-requeue:dead_1' })
    );
  });

  it('rejects a missing job with NOT_FOUND', async () => {
    db.restaurantJob.findUnique.mockResolvedValue(null);
    await expect(caller().requeueDeadJob({ jobId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('refuses to requeue a job that is not DEAD', async () => {
    db.restaurantJob.findUnique.mockResolvedValue({
      id: 'j1',
      type: 'sop.sweep',
      payload: {},
      maxAttempts: 5,
      status: 'QUEUED',
    });
    await expect(caller().requeueDeadJob({ jobId: 'j1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
