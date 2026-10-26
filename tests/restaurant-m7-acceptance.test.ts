/** WHA-88 — independent M7 API/contract acceptance against real PostgreSQL. */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { TRPCContext } from '@/server/trpc';
import { seedDepartments } from '@/lib/test-support/departments';

const mocks = vi.hoisted(() => ({
  can: vi.fn<(subject: unknown, action: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({
    enabledModules: ['restaurant-pos', 'restaurant-sop', 'restaurant-integrations'],
  })),
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

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha88_${suffix}`;
const ids = {
  branch: `branch_wha88_${suffix}`,
  user: `user_wha88_${suffix}`,
  operator: `staff_operator_wha88_${suffix}`,
  manager: `staff_manager_wha88_${suffix}`,
};
const T0 = new Date('2026-08-20T12:00:00.000Z');

type JobsCaller = ReturnType<
  (typeof import('@/server/routers/restaurant-jobs'))['restaurantJobsRouter']['createCaller']
>;
type SopCaller = ReturnType<
  (typeof import('@/server/routers/restaurant-sop'))['restaurantSopRouter']['createCaller']
>;
type ExecutionCaller = ReturnType<
  (typeof import('@/server/routers/restaurant-sop-execution'))['restaurantSopExecutionRouter']['createCaller']
>;
type NotificationsCaller = ReturnType<
  (typeof import('@/server/routers/restaurant-notifications'))['restaurantNotificationsRouter']['createCaller']
>;

type Deps = {
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  scheduler: typeof import('@/lib/restaurant/scheduler');
  jobRunner: typeof import('@/lib/restaurant/job-runner');
  outboxDispatcher: typeof import('@/lib/restaurant/outbox-dispatcher');
  notificationFanout: typeof import('@/lib/restaurant/notification-fanout');
  webhookInbox: typeof import('@/lib/restaurant/webhook-inbox');
  occurrenceGeneration: typeof import('@/lib/restaurant/sop-occurrence-generation');
  lateMissed: typeof import('@/lib/restaurant/sop-late-missed');
  escalation: typeof import('@/lib/restaurant/sop-escalation');
};

type SeededOccurrence = {
  id: string;
  assignmentId: string;
  templateStepId: string;
  occurrenceStepId: string;
};

let deps: Deps;
let api: {
  jobs: JobsCaller;
  sop: SopCaller;
  execution: ExecutionCaller;
  notifications: NotificationsCaller;
};

const claimedJob = (type: string, payload: Record<string, unknown>) =>
  ({ id: `job_context_${suffix}`, type, payload }) as never;

async function seedOccurrence(
  label: string,
  status:
    | 'SCHEDULED'
    | 'IN_PROGRESS'
    | 'SUBMITTED'
    | 'VERIFIED'
    | 'REJECTED'
    | 'LATE'
    | 'MISSED'
    | 'WAIVED',
  options: { windowEndsAt?: Date; graceMinutes?: number } = {}
): Promise<SeededOccurrence> {
  const templateId = `sop_template_${label}_${suffix}`;
  const versionId = `sop_version_${label}_${suffix}`;
  const templateStepId = `sop_step_${label}_${suffix}`;
  const assignmentId = `sop_assignment_${label}_${suffix}`;
  const occurrenceId = `sop_occurrence_${label}_${suffix}`;
  const occurrenceStepId = `sop_occurrence_step_${label}_${suffix}`;
  const windowEndsAt = options.windowEndsAt ?? new Date('2099-08-20T13:00:00.000Z');

  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantSopTemplate.create({
      data: {
        id: templateId,
        name: `Acceptance ${label}`,
        versions: {
          create: {
            id: versionId,
            versionNumber: 1,
            status: 'PUBLISHED',
            publishedAt: T0,
            steps: {
              create: {
                id: templateStepId,
                stepOrder: 1,
                title: `Step ${label}`,
              },
            },
          },
        },
      },
    });
    await tx.restaurantSopAssignment.create({
      data: {
        id: assignmentId,
        branchId: ids.branch,
        templateId,
        frequency: 'ONCE',
        daysOfWeek: [],
        startDate: new Date('2026-08-20T00:00:00.000Z'),
        dueTimeMinutes: 720,
        windowMinutes: 60,
        graceMinutes: options.graceMinutes ?? 0,
        assigneeTargetType: 'PERSON',
        assigneeStaffProfileId: ids.operator,
      },
    });
    await tx.restaurantSopOccurrence.create({
      data: {
        id: occurrenceId,
        assignmentId,
        templateVersionId: versionId,
        branchId: ids.branch,
        businessDate: new Date('2026-08-20T00:00:00.000Z'),
        status,
        // SOP-1 gates execution on occurrence ownership. Real generation
        // materializes this from the PERSON-target assignment above; this
        // fixture writes the occurrence directly, so it must do the same.
        assignedStaffProfileId: ids.operator,
        dueAt: new Date(windowEndsAt.getTime() - 60 * 60_000),
        windowEndsAt,
        steps: {
          create: {
            id: occurrenceStepId,
            templateStepId,
          },
        },
      },
    });
  });

  return { id: occurrenceId, assignmentId, templateStepId, occurrenceStepId };
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [
    scopedDb,
    scheduler,
    jobRunner,
    outboxDispatcher,
    notificationFanout,
    webhookInbox,
    occurrenceGeneration,
    lateMissed,
    escalation,
    jobsRouter,
    sopRouter,
    executionRouter,
    notificationsRouter,
  ] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/scheduler'),
    import('@/lib/restaurant/job-runner'),
    import('@/lib/restaurant/outbox-dispatcher'),
    import('@/lib/restaurant/notification-fanout'),
    import('@/lib/restaurant/webhook-inbox'),
    import('@/lib/restaurant/sop-occurrence-generation'),
    import('@/lib/restaurant/sop-late-missed'),
    import('@/lib/restaurant/sop-escalation'),
    import('@/server/routers/restaurant-jobs'),
    import('@/server/routers/restaurant-sop'),
    import('@/server/routers/restaurant-sop-execution'),
    import('@/server/routers/restaurant-notifications'),
  ]);
  deps = {
    createTenantDb: scopedDb.createTenantDb,
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    scheduler,
    jobRunner,
    outboxDispatcher,
    notificationFanout,
    webhookInbox,
    occurrenceGeneration,
    lateMissed,
    escalation,
  };

  const roles = await deps.withPlatformDb(
    (tx) =>
      tx.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
    `
  );
  if (roles[0]?.rolsuper || roles[0]?.rolbypassrls) {
    throw new Error('WHA-88 requires an unprivileged NOBYPASSRLS TEST_DATABASE_URL role.');
  }

  await deps.withPlatformDb(async (tx) => {
    await tx.organization.create({
      data: {
        id: orgId,
        slug: `wha88-${suffix}`,
        legalName: 'WHA-88 Acceptance',
        displayName: 'WHA-88 Acceptance',
        status: 'ACTIVE',
      },
    });
    await seedDepartments(tx, [orgId], ['QUALITY']);
  });
  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({
      data: { id: ids.branch, name: 'New York Branch', timezone: 'America/New_York' },
    });
    await tx.user.create({
      data: {
        id: ids.user,
        name: 'WHA-88 Operator',
        email: `wha88-${suffix}@example.test`,
        department: 'QUALITY',
        title: 'Operator',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
      },
    });
    await tx.restaurantStaffProfile.createMany({
      data: [
        {
          id: ids.operator,
          userId: ids.user,
          displayName: 'Acceptance Operator',
          primaryBranchId: ids.branch,
        },
        {
          id: ids.manager,
          displayName: 'Acceptance Manager',
          primaryBranchId: ids.branch,
        },
      ],
    });
  });

  const context = {
    db: scopedDb.createTenantDb(orgId),
    entitlements: {
      // WHA-264 gates SOP depth on the module set AND limit values. This battery
      // exercises co-authorized waivers and escalation chains, so the fixture
      // org is entitled to the depths those paths require.
      enabledModules: ['restaurant-pos', 'restaurant-sop', 'restaurant-integrations'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: {
        'sop.templates.max': 100,
        'sop.evidenceRetentionDays': 1_095,
        'integrations.connections.max': 5,
      },
    },
    session: {
      expires: 'later',
      user: {
        id: ids.user,
        role: 'EMPLOYEE',
        department: 'QUALITY',
        status: 'ACTIVE',
        organizationId: orgId,
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  api = {
    jobs: jobsRouter.restaurantJobsRouter.createCaller(context),
    sop: sopRouter.restaurantSopRouter.createCaller(context),
    execution: executionRouter.restaurantSopExecutionRouter.createCaller(context),
    notifications: notificationsRouter.restaurantNotificationsRouter.createCaller(context),
  };
}, 60_000);

describeIfDatabase('WHA-88 M7 independent acceptance (real PostgreSQL + API)', () => {
  it('claims due jobs once across eight overlapping workers', async () => {
    const jobType = `acceptance.parallel.${suffix}`;
    const jobCount = 16;
    await deps.withTenantDb(orgId, async (tx) => {
      for (let index = 0; index < jobCount; index += 1) {
        await deps.scheduler.enqueue(
          tx,
          {
            type: jobType,
            payload: { index },
            idempotencyKey: `parallel_${suffix}_${index}`,
            scheduledAt: T0,
          },
          T0
        );
      }
    });

    const work = async (workerId: string) => {
      let claimed = 0;
      for (;;) {
        const job = await deps.withTenantDb(orgId, (tx) =>
          deps.scheduler.claimNextDue(tx, { workerId, now: T0 })
        );
        if (!job) return claimed;
        await deps.withTenantDb(orgId, (tx) =>
          deps.scheduler.complete(tx, job.id, {
            workerId,
            attempt: job.attempts,
            claimToken: job.claimToken,
            now: T0,
          })
        );
        claimed += 1;
      }
    };
    const totals = await Promise.all(
      Array.from({ length: 8 }, (_, index) => work(`parallel_worker_${index}_${suffix}`))
    );
    expect(totals.reduce((sum, count) => sum + count, 0)).toBe(jobCount);

    const [jobs, executions] = await deps.withTenantDb(orgId, async (tx) => [
      await tx.restaurantJob.findMany({
        where: { type: jobType },
        select: { id: true, status: true, attempts: true },
      }),
      await tx.restaurantJobExecution.groupBy({
        by: ['jobId'],
        where: { job: { type: jobType } },
        _count: { _all: true },
      }),
    ]);
    expect(jobs).toHaveLength(jobCount);
    expect(jobs.every((job) => job.status === 'SUCCEEDED' && job.attempts === 1)).toBe(true);
    expect(executions).toHaveLength(jobCount);
    expect(executions.every((row) => row._count._all === 1)).toBe(true);
  }, 120_000);

  it('deduplicates enqueue retries, dead-letters bounded failures, and requeues as new', async () => {
    const idempotencyKey = `enqueue_retry_${suffix}`;
    const scheduledAt = new Date('2100-01-01T00:00:00.000Z');
    const first = await deps.withTenantDb(orgId, (tx) =>
      deps.scheduler.enqueue(tx, { type: 'acceptance.idempotent', idempotencyKey, scheduledAt }, T0)
    );
    const retry = await deps.withTenantDb(orgId, (tx) =>
      deps.scheduler.enqueue(tx, { type: 'acceptance.idempotent', idempotencyKey, scheduledAt }, T0)
    );
    expect(first.deduplicated).toBe(false);
    expect(retry).toMatchObject({ deduplicated: true, job: { id: first.job.id } });
    await expect(
      deps.withTenantDb(orgId, (tx) => tx.restaurantJob.count({ where: { idempotencyKey } }))
    ).resolves.toBe(1);

    const dead = await deps.withTenantDb(orgId, (tx) =>
      deps.scheduler.enqueue(
        tx,
        { type: `acceptance.dead.${suffix}`, maxAttempts: 2, scheduledAt: T0 },
        T0
      )
    );
    const workerId = `dead_worker_${suffix}`;
    const due = new Date('2026-08-21T12:00:00.000Z');
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptAt = new Date(due.getTime() + attempt * (deps.scheduler.RETRY_BASE_MS + 1));
      const claimed = await deps.withTenantDb(orgId, (tx) =>
        deps.scheduler.claimNextDue(tx, { workerId, now: attemptAt })
      );
      expect(claimed?.id).toBe(dead.job.id);
      outcomes.push(
        await deps.withTenantDb(orgId, (tx) =>
          deps.scheduler.fail(tx, dead.job.id, new Error('induced failure'), {
            workerId,
            attempt: claimed!.attempts,
            claimToken: claimed!.claimToken,
            now: attemptAt,
          })
        )
      );
    }
    expect(outcomes).toEqual(['retried', 'dead']);

    const requeued = await api.jobs.requeueDeadJob({ jobId: dead.job.id });
    expect(requeued).toMatchObject({ requeuedFrom: dead.job.id, status: 'QUEUED' });
    expect(requeued.jobId).not.toBe(dead.job.id);
    const beforeSettle = await deps.withTenantDb(orgId, async (tx) => ({
      old: await tx.restaurantJob.findUniqueOrThrow({ where: { id: dead.job.id } }),
      history: await tx.restaurantJobExecution.findMany({
        where: { jobId: dead.job.id },
        orderBy: { attempt: 'asc' },
        select: { attempt: true, outcome: true },
      }),
    }));
    expect(beforeSettle.old.status).toBe('DEAD');
    expect(beforeSettle.history).toEqual([
      { attempt: 1, outcome: 'FAILED' },
      { attempt: 2, outcome: 'FAILED' },
    ]);

    const requeuedClaim = await deps.withTenantDb(orgId, (tx) =>
      deps.scheduler.claimNextDue(tx, {
        workerId: `requeue_worker_${suffix}`,
        now: new Date('2099-01-01T00:00:00.000Z'),
      })
    );
    expect(requeuedClaim?.id).toBe(requeued.jobId);
    await deps.withTenantDb(orgId, (tx) =>
      deps.scheduler.complete(tx, requeued.jobId, {
        workerId: `requeue_worker_${suffix}`,
        attempt: requeuedClaim!.attempts,
        claimToken: requeuedClaim!.claimToken,
        now: new Date('2099-01-01T00:00:00.000Z'),
      })
    );
  }, 60_000);

  it('settles in-flight work before graceful shutdown and leaves no RUNNING orphan', async () => {
    const jobType = `acceptance.shutdown.${suffix}`;
    const queued = await deps.withTenantDb(orgId, (tx) =>
      deps.scheduler.enqueue(
        tx,
        {
          type: jobType,
          idempotencyKey: `shutdown_${suffix}`,
          maxAttempts: 1,
          scheduledAt: T0,
        },
        T0
      )
    );
    const controller = new AbortController();
    const handlerStarted = vi.fn();
    const { restaurantJobHandlers } = await import('@/lib/restaurant/job-handlers');
    restaurantJobHandlers[jobType] = async () => {
      handlerStarted();
      controller.abort();
    };
    const result = await (async () => {
      try {
        return await deps.jobRunner.runRestaurantWorker({
          workerId: `shutdown_worker_${suffix}`,
          signal: controller.signal,
          clock: () => T0,
          maxJobsPerOrg: 1,
          maxOutboxPerOrg: 1,
          discoverOrganizations: async () => [orgId],
          runInOrg: (organizationId, work) => deps.withTenantDb(organizationId, work),
          outboxClient: (organizationId) => deps.createTenantDb(organizationId),
        });
      } finally {
        delete restaurantJobHandlers[jobType];
      }
    })();
    expect(handlerStarted).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ stoppedBy: 'signal', ticks: 1, jobs: { succeeded: 1 } });
    const state = await deps.withTenantDb(orgId, async (tx) => ({
      job: await tx.restaurantJob.findUniqueOrThrow({ where: { id: queued.job.id } }),
      running: await tx.restaurantJob.count({ where: { status: 'RUNNING' } }),
    }));
    expect(state.job.status).toBe('SUCCEEDED');
    expect(state.running).toBe(0);
  }, 60_000);

  it('dispatches one durable outbox effect once and terminates a failing row at DEAD', async () => {
    const requestId = `outbox_request_${suffix}`;
    await deps.withTenantDb(orgId, (tx) =>
      deps.notificationFanout.appendNotificationRequest(tx, {
        requestId,
        recipientStaffProfileIds: [ids.operator],
        branchId: ids.branch,
        category: 'acceptance.outbox',
        title: 'Outbox acceptance',
        channels: ['IN_APP'],
      })
    );
    const successRegistry = new deps.outboxDispatcher.OutboxConsumerRegistry();
    deps.notificationFanout.registerNotificationOutboxConsumer(successRegistry);
    const outboxDb = deps.createTenantDb(orgId);
    const first = await deps.outboxDispatcher.dispatchOutboxBatch(outboxDb, {
      registry: successRegistry,
      now: T0,
    });
    const retry = await deps.outboxDispatcher.dispatchOutboxBatch(outboxDb, {
      registry: successRegistry,
      now: T0,
    });
    expect(first).toMatchObject({ dispatched: 1, dead: 0, retried: 0 });
    expect(retry).toEqual({ dispatched: 0, retried: 0, dead: 0, skipped: 0 });
    await expect(
      deps.withTenantDb(orgId, (tx) =>
        tx.restaurantJob.count({
          where: { idempotencyKey: `notification-fanout:${requestId}` },
        })
      )
    ).resolves.toBe(1);

    const failingEventType = `acceptance.outbox.failure.${suffix}`;
    const failing = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantEventOutbox.create({
        data: {
          eventType: failingEventType,
          aggregateType: 'acceptance',
          aggregateId: `failure_${suffix}`,
          payload: {},
          status: 'PENDING',
        },
      })
    );
    const failingRegistry = new deps.outboxDispatcher.OutboxConsumerRegistry();
    failingRegistry.register(failingEventType, async () => {
      throw new Error('induced outbox failure');
    });
    const policy = { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 };
    const failedOnce = await deps.outboxDispatcher.dispatchOutboxBatch(outboxDb, {
      registry: failingRegistry,
      now: T0,
      policy,
      batchSize: 1,
    });
    const failedTwice = await deps.outboxDispatcher.dispatchOutboxBatch(outboxDb, {
      registry: failingRegistry,
      now: T0,
      policy,
      batchSize: 1,
    });
    expect(failedOnce.retried).toBe(1);
    expect(failedTwice.dead).toBe(1);
    await expect(
      deps.withTenantDb(orgId, (tx) =>
        tx.restaurantEventOutbox.findUniqueOrThrow({
          where: { id: failing.id },
          select: { status: true, attempts: true, lastError: true },
        })
      )
    ).resolves.toEqual({
      status: 'DEAD',
      attempts: 2,
      lastError: 'induced outbox failure',
    });
  }, 60_000);

  it('deduplicates webhooks and records explicit STUB signature states', async () => {
    const input = {
      source: 'wha88-provider',
      externalEventId: `signed_${suffix}`,
      eventType: 'restaurant.acceptance',
      payload: { accepted: true },
      signature: 'stub-signature',
    };
    const first = await deps.withTenantDb(orgId, (tx) =>
      deps.webhookInbox.recordInboundWebhook(tx, input, T0)
    );
    const duplicate = await deps.withTenantDb(orgId, (tx) =>
      deps.webhookInbox.recordInboundWebhook(tx, input, T0)
    );
    const unsigned = await deps.withTenantDb(orgId, (tx) =>
      deps.webhookInbox.recordInboundWebhook(
        tx,
        {
          ...input,
          externalEventId: `unsigned_${suffix}`,
          signature: null,
        },
        T0
      )
    );
    expect(first).toMatchObject({ deduplicated: false, inbox: { verificationStatus: 'VERIFIED' } });
    expect(duplicate).toMatchObject({
      deduplicated: true,
      enqueuedJobId: null,
      inbox: { id: first.inbox.id },
    });
    expect(unsigned.inbox.verificationStatus).toBe('PENDING');
    const counts = await deps.withTenantDb(orgId, async (tx) => ({
      signedRows: await tx.restaurantWebhookInbox.count({
        where: { source: input.source, externalEventId: input.externalEventId },
      }),
      signedJobs: await tx.restaurantJob.count({
        where: { idempotencyKey: `webhook.process:${first.inbox.id}` },
      }),
    }));
    expect(counts).toEqual({ signedRows: 1, signedJobs: 1 });
  });

  it('freezes published templates, pins generated versions, and resolves both DST edges', async () => {
    const template = await api.sop.createTemplate({ name: `DST checklist ${suffix}` });
    const version1 = template.versions[0]!;
    const step1 = await api.sop.addStep({
      templateVersionId: version1.id,
      title: 'Original immutable step',
    });
    await api.sop.publishVersion({ versionId: version1.id });
    await expect(
      api.sop.updateStep({ stepId: step1.id, title: 'Forbidden mutation' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const spring = await api.sop.previewSchedule({
      branchId: ids.branch,
      from: '2026-03-08',
      to: '2026-03-08',
      frequency: 'DAILY',
      startDate: '2026-03-01',
      dueTimeMinutes: 150,
    });
    const fall = await api.sop.previewSchedule({
      branchId: ids.branch,
      from: '2026-11-01',
      to: '2026-11-01',
      frequency: 'DAILY',
      startDate: '2026-10-01',
      dueTimeMinutes: 90,
    });
    expect(spring[0]?.dueAt.toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(fall[0]?.dueAt.toISOString()).toBe('2026-11-01T05:30:00.000Z');

    const assignment = await api.sop.createAssignment({
      branchId: ids.branch,
      templateId: template.id,
      frequency: 'ONCE',
      startDate: '2026-08-20',
      dueTimeMinutes: 600,
      windowMinutes: 60,
      graceMinutes: 15,
      // SOP-1: an assignment must now name an assignee. A PERSON target keeps
      // this M7 DST assertion about scheduling only, with no pool to claim.
      assigneeTarget: { type: 'person', staffProfileId: ids.operator },
    });
    const generated = await deps.withTenantDb(orgId, (tx) =>
      deps.occurrenceGeneration.generateDueSopOccurrences(tx, {
        now: new Date('2026-08-20T16:00:00.000Z'),
        lookbackDays: 0,
        horizonDays: 0,
      })
    );
    expect(generated.created).toBe(1);
    const pinned = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantSopOccurrence.findFirstOrThrow({
        where: {
          assignmentId: assignment.id,
          businessDate: new Date('2026-08-20T00:00:00.000Z'),
        },
        select: { id: true, templateVersionId: true },
      })
    );
    expect(pinned.templateVersionId).toBe(version1.id);

    const version2 = await api.sop.createDraftVersion({ templateId: template.id });
    await api.sop.updateStep({ stepId: version2.steps[0]!.id, title: 'New version step' });
    await api.sop.publishVersion({ versionId: version2.id });
    const rerun = await deps.withTenantDb(orgId, (tx) =>
      deps.occurrenceGeneration.generateDueSopOccurrences(tx, {
        now: new Date('2026-08-20T16:00:00.000Z'),
        lookbackDays: 0,
        horizonDays: 0,
      })
    );
    const afterNewVersion = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantSopOccurrence.findMany({
        where: { assignmentId: assignment.id },
        select: { id: true, templateVersionId: true },
      })
    );
    expect(rerun.created).toBe(0);
    expect(afterNewVersion).toEqual([{ id: pinned.id, templateVersionId: version1.id }]);
  }, 60_000);

  it('keeps evidence append-only through rejection, resubmission, and verification', async () => {
    const occurrence = await seedOccurrence('evidence', 'SCHEDULED');
    await api.execution.start({ occurrenceId: occurrence.id, actorStaffProfileId: ids.operator });
    await api.execution.completeStep({
      occurrenceId: occurrence.id,
      templateStepId: occurrence.templateStepId,
      actorStaffProfileId: ids.operator,
      note: 'complete',
    });
    const first = await api.execution.attachEvidence({
      occurrenceId: occurrence.id,
      occurrenceStepId: occurrence.occurrenceStepId,
      contentHashHex: '1'.repeat(64),
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      storageRef: 'stub://first',
      uploaderStaffProfileId: ids.operator,
    });
    await api.execution.submit({ occurrenceId: occurrence.id, actorStaffProfileId: ids.operator });

    const submittedMutation = await deps.withTenantDb(orgId, async (tx) => ({
      updated: await tx.restaurantSopEvidence.updateMany({
        where: { id: first.evidenceId },
        data: { contentHash: '9'.repeat(64) },
      }),
      deleted: await tx.restaurantSopEvidence.deleteMany({ where: { id: first.evidenceId } }),
    }));
    expect(submittedMutation).toEqual({ updated: { count: 0 }, deleted: { count: 0 } });

    await api.execution.reject({
      occurrenceId: occurrence.id,
      actorStaffProfileId: ids.manager,
      reason: 'Resubmit evidence',
    });
    await api.execution.start({ occurrenceId: occurrence.id, actorStaffProfileId: ids.operator });
    const second = await api.execution.attachEvidence({
      occurrenceId: occurrence.id,
      occurrenceStepId: occurrence.occurrenceStepId,
      contentHashHex: '2'.repeat(64),
      mimeType: 'image/jpeg',
      sizeBytes: 12,
      storageRef: 'stub://second',
      uploaderStaffProfileId: ids.operator,
    });
    await api.execution.submit({ occurrenceId: occurrence.id, actorStaffProfileId: ids.operator });
    await api.execution.verify({
      occurrenceId: occurrence.id,
      actorStaffProfileId: ids.manager,
      reason: 'Accepted',
    });
    expect(second.evidenceId).not.toBe(first.evidenceId);

    const verifiedMutation = await deps.withTenantDb(orgId, async (tx) => ({
      updated: await tx.restaurantSopEvidence.updateMany({
        where: { id: second.evidenceId },
        data: { contentHash: '8'.repeat(64) },
      }),
      deleted: await tx.restaurantSopEvidence.deleteMany({ where: { id: second.evidenceId } }),
    }));
    expect(verifiedMutation).toEqual({ updated: { count: 0 }, deleted: { count: 0 } });
    await expect(
      api.execution.attachEvidence({
        occurrenceId: occurrence.id,
        contentHashHex: '3'.repeat(64),
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        // The owning operator, so SOP-1's ownership guard passes and the
        // assertion lands on what it is about: a VERIFIED occurrence is closed
        // to further evidence.
        uploaderStaffProfileId: ids.operator,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const detail = await api.execution.getOccurrence({ id: occurrence.id });
    expect(detail.status).toBe('VERIFIED');
    expect(detail.evidence.map((row) => row.contentHash)).toEqual(['1'.repeat(64), '2'.repeat(64)]);
  }, 60_000);

  it('requires verify permission and distinct manager co-authorization for a waiver', async () => {
    const occurrence = await seedOccurrence('waiver', 'MISSED', { windowEndsAt: T0 });
    mocks.can.mockResolvedValueOnce(false);
    await expect(
      api.execution.waive({
        occurrenceId: occurrence.id,
        actorStaffProfileId: ids.operator,
        approvingStaffProfileId: ids.manager,
        reason: 'Caller lacks manager verification permission',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      api.execution.waive({
        occurrenceId: occurrence.id,
        actorStaffProfileId: ids.operator,
        approvingStaffProfileId: ids.operator,
        reason: 'Self approval is forbidden',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.execution.getOccurrence({ id: occurrence.id })).resolves.toMatchObject({
      status: 'MISSED',
    });

    const waived = await api.execution.waive({
      occurrenceId: occurrence.id,
      actorStaffProfileId: ids.operator,
      approvingStaffProfileId: ids.manager,
      reason: 'Manager-approved operational waiver',
    });
    const persisted = await deps.withTenantDb(orgId, async (tx) => {
      const verification = await tx.restaurantSopVerification.findUniqueOrThrow({
        where: { id: waived.verificationId },
        select: { coAuthorizationId: true },
      });
      return tx.restaurantCoAuthorization.findUniqueOrThrow({
        where: { id: verification.coAuthorizationId! },
        select: { actingStaffProfileId: true, approvingStaffProfileId: true },
      });
    });
    expect(persisted).toEqual({
      actingStaffProfileId: ids.operator,
      approvingStaffProfileId: ids.manager,
    });
  });

  it('moves LATE to MISSED only when the scheduler sweep runs', async () => {
    const occurrence = await seedOccurrence('late_missed', 'LATE', {
      windowEndsAt: T0,
      graceMinutes: 30,
    });
    await expect(api.execution.getOccurrence({ id: occurrence.id })).resolves.toMatchObject({
      status: 'LATE',
    });
    await deps.withTenantDb(orgId, (tx) =>
      deps.lateMissed.sopLateMissedHandler({
        db: tx,
        job: claimedJob(deps.lateMissed.SOP_LATE_MISSED_JOB, {
          now: new Date(T0.getTime() + 31 * 60_000).toISOString(),
        }),
      })
    );
    await expect(api.execution.getOccurrence({ id: occurrence.id })).resolves.toMatchObject({
      status: 'MISSED',
    });
  });

  it('terminates escalation on acknowledgement or exhaustion and defers quiet hours', async () => {
    const createPolicy = (label: string, quiet: boolean) =>
      deps.withTenantDb(orgId, (tx) =>
        tx.restaurantSopEscalationPolicy.create({
          data: {
            name: `Policy ${label}`,
            scope: 'ORG',
            stopOnAcknowledged: true,
            quietHoursStartMinutes: quiet ? 0 : null,
            quietHoursEndMinutes: quiet ? 60 : null,
            steps: {
              create: [
                {
                  stepOrder: 1,
                  delayMinutes: 0,
                  target: ids.operator,
                  channel: 'IN_APP',
                  maxAttempts: 1,
                },
                {
                  stepOrder: 2,
                  delayMinutes: 0,
                  target: ids.manager,
                  channel: 'EMAIL',
                  maxAttempts: 1,
                },
              ],
            },
          },
        })
      );
    const noOutboxConsumers = new deps.outboxDispatcher.OutboxConsumerRegistry();
    let runNumber = 0;
    const run = async (occurrenceId: string, policyId: string, now = T0) => {
      runNumber += 1;
      const queued = await deps.withTenantDb(orgId, (tx) =>
        deps.scheduler.enqueue(
          tx,
          {
            type: deps.escalation.SOP_ESCALATION_JOB,
            payload: { occurrenceId, policyId, now: now.toISOString() },
            idempotencyKey: `escalation_${suffix}_${runNumber}`,
            scheduledAt: new Date('2000-01-01T00:00:00.000Z'),
            maxAttempts: 1,
          },
          now
        )
      );
      const result = await deps.jobRunner.runRestaurantWorkerTick({
        workerId: `escalation_worker_${suffix}_${runNumber}`,
        now,
        maxJobsPerOrg: 1,
        maxOutboxPerOrg: 1,
        outboxConsumers: noOutboxConsumers,
        discoverOrganizations: async () => [orgId],
        runInOrg: (organizationId, work) => deps.withTenantDb(organizationId, work),
        outboxClient: (organizationId) => deps.createTenantDb(organizationId),
      });
      expect(result.jobs).toMatchObject({ claimed: 1, succeeded: 1 });
      await expect(
        deps.withTenantDb(orgId, (tx) =>
          tx.restaurantJob.findUniqueOrThrow({
            where: { id: queued.job.id },
            select: { status: true },
          })
        )
      ).resolves.toEqual({ status: 'SUCCEEDED' });
    };

    const exhaustedOccurrence = await seedOccurrence('escalation_exhausted', 'MISSED', {
      windowEndsAt: T0,
    });
    const exhaustionPolicy = await createPolicy('exhaustion', false);
    await run(exhaustedOccurrence.id, exhaustionPolicy.id);
    await run(exhaustedOccurrence.id, exhaustionPolicy.id);
    await run(exhaustedOccurrence.id, exhaustionPolicy.id);
    const exhaustionKinds = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantSopEscalationEvent.findMany({
        where: { occurrenceId: exhaustedOccurrence.id },
        select: { kind: true },
      })
    );
    expect(exhaustionKinds.filter((event) => event.kind === 'FIRED')).toHaveLength(2);
    expect(exhaustionKinds.filter((event) => event.kind === 'STOPPED')).toHaveLength(1);
    expect(exhaustionKinds.some((event) => event.kind === 'ACKNOWLEDGED')).toBe(false);

    const acknowledgedOccurrence = await seedOccurrence('escalation_ack', 'MISSED', {
      windowEndsAt: T0,
    });
    const acknowledgementPolicy = await createPolicy('acknowledgement', false);
    await run(acknowledgedOccurrence.id, acknowledgementPolicy.id);
    await api.execution.acknowledge({
      occurrenceId: acknowledgedOccurrence.id,
      actorStaffProfileId: ids.operator,
    });
    await run(acknowledgedOccurrence.id, acknowledgementPolicy.id);
    const acknowledgementKinds = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantSopEscalationEvent.findMany({
        where: { occurrenceId: acknowledgedOccurrence.id },
        select: { kind: true },
      })
    );
    expect(acknowledgementKinds.filter((event) => event.kind === 'FIRED')).toHaveLength(1);
    expect(acknowledgementKinds.filter((event) => event.kind === 'ACKNOWLEDGED')).toHaveLength(1);
    expect(acknowledgementKinds.filter((event) => event.kind === 'STOPPED')).toHaveLength(1);

    const quietOccurrence = await seedOccurrence('escalation_quiet', 'MISSED', {
      windowEndsAt: T0,
    });
    const quietPolicy = await createPolicy('quiet', true);
    const beforeOutbox = await deps.withTenantDb(orgId, (tx) => tx.restaurantEventOutbox.count());
    await run(quietOccurrence.id, quietPolicy.id, new Date('2026-08-20T04:30:00.000Z'));
    const quietState = await deps.withTenantDb(orgId, async (tx) => ({
      events: await tx.restaurantSopEscalationEvent.count({
        where: { occurrenceId: quietOccurrence.id },
      }),
      outbox: await tx.restaurantEventOutbox.count(),
    }));
    expect(quietState).toEqual({ events: 0, outbox: beforeOutbox });
  }, 60_000);

  it('persists in-app read state, stubs external channels, and omits matrix-off delivery', async () => {
    const category = `acceptance.notification.${suffix}`;
    await api.notifications.updateMatrix({
      category,
      branchId: ids.branch,
      channel: 'PUSH',
      enabled: false,
    });
    const request = {
      requestId: `notification_${suffix}`,
      recipientStaffProfileIds: [ids.operator],
      branchId: ids.branch,
      category,
      title: 'Acceptance notification',
      body: 'Read-state battery',
      channels: ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WHATSAPP'] as const,
    };
    await deps.withTenantDb(orgId, (tx) =>
      deps.notificationFanout.notificationFanoutHandler({
        db: tx,
        job: claimedJob(deps.notificationFanout.NOTIFICATION_FANOUT_JOB, request),
      })
    );
    await deps.withTenantDb(orgId, (tx) =>
      deps.notificationFanout.notificationFanoutHandler({
        db: tx,
        job: claimedJob(deps.notificationFanout.NOTIFICATION_FANOUT_JOB, request),
      })
    );

    const persisted = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantNotification.findMany({
        where: { category },
        include: { deliveries: true },
      })
    );
    expect(persisted).toHaveLength(1);
    expect(
      persisted[0]!.deliveries
        .map((delivery) => [delivery.channel, delivery.status] as const)
        .sort(([left], [right]) => left.localeCompare(right))
    ).toEqual([
      ['EMAIL', 'STUBBED'],
      ['IN_APP', 'DELIVERED_IN_APP'],
      ['SMS', 'STUBBED'],
      ['WHATSAPP', 'STUBBED'],
    ]);
    expect(persisted[0]!.deliveries.some((delivery) => delivery.channel === 'PUSH')).toBe(false);

    await expect(api.notifications.unreadCount({})).resolves.toEqual({ count: 1 });
    const unread = await api.notifications.list({ limit: 10, unreadOnly: true });
    expect(unread.items).toHaveLength(1);
    expect(unread.items[0]).toMatchObject({ id: persisted[0]!.id, isRead: false });
    await expect(api.notifications.markRead({ id: persisted[0]!.id })).resolves.toMatchObject({
      isRead: true,
    });
    await expect(api.notifications.unreadCount({})).resolves.toEqual({ count: 0 });
    await expect(api.notifications.list({ limit: 10, unreadOnly: true })).resolves.toMatchObject({
      items: [],
    });
  }, 60_000);
});
