/**
 * M7-L4 / WHA-226 — SOP late/missed sweep unit tests.
 *
 * Covers: the deterministic MISSED boundary (`missedAt` / `isMissedAt`), the fact
 * that the sweep issues exactly one set-based UPDATE and never writes LATE, the
 * guards that keep submitted-late work out of the sweep, payload schema
 * validation, and the injectable clock.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/scheduler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/restaurant/scheduler')>();
  return { ...actual, enqueue: vi.fn() };
});

import {
  enqueueDueSopEscalations,
  isMissedAt,
  MAX_ESCALATION_OCCURRENCES_PER_TICK,
  MAX_ESCALATION_PAIR_EVALUATIONS_PER_TICK,
  MAX_ESCALATION_POLICIES_PER_TICK,
  missedAt,
  sopEscalationJobKey,
  sopLateMissedHandler,
} from './sop-late-missed';
import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers';
import { enqueue } from '@/lib/restaurant/scheduler';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { sopEscalationHandler } from './sop-escalation';

const WINDOW_ENDS = new Date('2026-08-20T12:00:00.000Z');

function makeContext(payloadOverride: Record<string, unknown> = {}): {
  ctx: RestaurantJobContext;
  updateMany: ReturnType<typeof vi.fn>;
  executeRaw: ReturnType<typeof vi.fn>;
} {
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const executeRaw = vi.fn().mockResolvedValue(0);
  const findPolicies = vi.fn().mockResolvedValue([]);
  const findOccurrences = vi.fn().mockResolvedValue([]);

  const db = {
    restaurantSopOccurrence: {
      updateMany,
      count: vi.fn().mockResolvedValue(0),
      findMany: findOccurrences,
    },
    restaurantSopEscalationPolicy: { count: vi.fn().mockResolvedValue(1), findMany: findPolicies },
    $executeRaw: executeRaw,
  } as unknown as ScopedDb;

  const ctx: RestaurantJobContext = {
    db,
    job: {
      id: 'job_1',
      organizationId: 'org_1',
      type: 'sop.sweepLateMissed',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: payloadOverride as any,
      attempts: 1,
      maxAttempts: 5,
      claimedBy: 'worker_1',
      startedAt: new Date(),
    },
  };

  return { ctx, updateMany, executeRaw };
}

/** The SQL text of the single statement the handler issues. */
function sweepSql(executeRaw: ReturnType<typeof vi.fn>): string {
  const [template] = executeRaw.mock.calls[0] as [TemplateStringsArray];
  return template.join(' ').replace(/\s+/g, ' ');
}

describe('missedAt / isMissedAt', () => {
  it('adds the grace period to the window close', () => {
    expect(missedAt(WINDOW_ENDS, 0).toISOString()).toBe('2026-08-20T12:00:00.000Z');
    expect(missedAt(WINDOW_ENDS, 30).toISOString()).toBe('2026-08-20T12:30:00.000Z');
  });

  it('is not missed at the boundary instant (strict comparison)', () => {
    // The same instant `submitOccurrence` still treats as on-time (`now > windowEndsAt`),
    // so no single instant is claimed by both the request path and the sweep.
    expect(isMissedAt(WINDOW_ENDS, WINDOW_ENDS, 0)).toBe(false);
    expect(isMissedAt(new Date('2026-08-20T12:30:00.000Z'), WINDOW_ENDS, 30)).toBe(false);
  });

  it('is missed one millisecond past the boundary', () => {
    expect(isMissedAt(new Date('2026-08-20T12:00:00.001Z'), WINDOW_ENDS, 0)).toBe(true);
    expect(isMissedAt(new Date('2026-08-20T12:30:00.001Z'), WINDOW_ENDS, 30)).toBe(true);
  });

  it('is not missed before the grace period elapses', () => {
    expect(isMissedAt(new Date('2026-08-20T12:29:59.999Z'), WINDOW_ENDS, 30)).toBe(false);
  });
});

describe('sopLateMissedHandler', () => {
  it('issues exactly one set-based UPDATE', async () => {
    const { ctx, updateMany, executeRaw } = makeContext({ now: '2026-08-20T12:00:00.000Z' });
    await sopLateMissedHandler(ctx);

    expect(executeRaw).toHaveBeenCalledOnce();
    // A partially applied sweep must not be observable, so the handler does not
    // pair the raw statement with a second Prisma update.
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('never writes LATE — that status belongs to the submit path', async () => {
    const { ctx, executeRaw } = makeContext({ now: '2026-08-20T12:00:00.000Z' });
    await sopLateMissedHandler(ctx);

    const sql = sweepSql(executeRaw);
    expect(sql).toContain("status = 'MISSED'");
    expect(sql).not.toContain("status = 'LATE'");
  });

  it('only sweeps pre-submission states, and only when nothing was submitted', async () => {
    const { ctx, executeRaw } = makeContext({ now: '2026-08-20T12:00:00.000Z' });
    await sopLateMissedHandler(ctx);

    const sql = sweepSql(executeRaw);
    expect(sql).toContain("occ.status IN ('SCHEDULED', 'IN_PROGRESS', 'LATE')");
    // The NULL-submission guard — not the status list — is what protects
    // submitted work. A submitted-late occurrence (status LATE, submittedAt set)
    // is awaiting verification and must survive the sweep; a LATE row with no
    // submission was never handed in and is genuinely missed. Dropping this
    // guard would silently rewrite real submissions to MISSED.
    expect(sql).toContain('occ."submittedAt" IS NULL');
  });

  it('applies the grace period with a strict boundary', async () => {
    const { ctx, executeRaw } = makeContext({ now: '2026-08-20T12:00:00.000Z' });
    await sopLateMissedHandler(ctx);

    const sql = sweepSql(executeRaw);
    expect(sql).toContain('INTERVAL \'1 minute\' * asgn."graceMinutes"');
    expect(sql).toContain('< ');
    expect(sql).not.toContain('<= ');
  });

  it('passes the injected clock through to the statement', async () => {
    const { ctx, executeRaw } = makeContext({ now: '2026-08-20T12:00:00.000Z' });
    await sopLateMissedHandler(ctx);

    const params = executeRaw.mock.calls[0].slice(1) as unknown[];
    expect(params.every((p) => p instanceof Date)).toBe(true);
    expect((params[0] as Date).toISOString()).toBe('2026-08-20T12:00:00.000Z');
  });

  it('works with an empty payload (uses current time)', async () => {
    const { ctx } = makeContext();
    await expect(sopLateMissedHandler(ctx)).resolves.toBeUndefined();
  });

  it('rejects an unknown payload key (strict zod)', async () => {
    const { ctx } = makeContext({ unknown: true });
    await expect(sopLateMissedHandler(ctx)).rejects.toThrow();
  });
});

describe('enqueueDueSopEscalations', () => {
  it('bounds both sides of the producer sweep for per-tenant fairness', async () => {
    const findPolicies = vi.fn().mockResolvedValue([]);
    const findOccurrences = vi.fn().mockResolvedValue([]);
    const db = {
      restaurantSopEscalationPolicy: {
        count: vi.fn().mockResolvedValue(1),
        findMany: findPolicies,
      },
      restaurantSopOccurrence: { count: vi.fn().mockResolvedValue(1), findMany: findOccurrences },
    } as unknown as ScopedDb;

    await enqueueDueSopEscalations(db, WINDOW_ENDS);

    expect(findPolicies).toHaveBeenCalledWith(
      expect.objectContaining({ take: MAX_ESCALATION_POLICIES_PER_TICK })
    );
    expect(findOccurrences).toHaveBeenCalledWith(
      expect.objectContaining({
        take: MAX_ESCALATION_OCCURRENCES_PER_TICK,
        where: expect.objectContaining({ escalationEvents: { none: { kind: 'STOPPED' } } }),
      })
    );
  });

  it('enforces a tick-wide policy/occurrence pair budget', async () => {
    vi.mocked(enqueue).mockClear();
    const policies = Array.from({ length: MAX_ESCALATION_POLICIES_PER_TICK }, (_, i) => ({
      id: `policy_${i}`,
      scope: 'ORG' as const,
      branchId: null,
      stopOnAcknowledged: false,
      quietHoursStartMinutes: null,
      quietHoursEndMinutes: null,
      steps: [{ id: `step_${i}`, delayMinutes: 0 }],
    }));
    const occurrences = Array.from({ length: MAX_ESCALATION_OCCURRENCES_PER_TICK }, (_, i) => ({
      id: `occ_${i}`,
      branchId: 'branch_1',
      windowEndsAt: WINDOW_ENDS,
      branch: { timezone: 'UTC' },
      escalationEvents: [],
    }));
    const findPolicies = vi.fn().mockResolvedValue(policies);
    const findOccurrences = vi.fn().mockResolvedValue(occurrences);
    const db = {
      restaurantSopEscalationPolicy: {
        count: vi.fn().mockResolvedValue(1),
        findMany: findPolicies,
      },
      restaurantSopOccurrence: { count: vi.fn().mockResolvedValue(1), findMany: findOccurrences },
    } as unknown as ScopedDb;
    vi.mocked(enqueue).mockResolvedValue({
      job: {} as Awaited<ReturnType<typeof enqueue>>['job'],
      deduplicated: false,
    });

    await expect(enqueueDueSopEscalations(db, WINDOW_ENDS)).resolves.toBe(
      MAX_ESCALATION_PAIR_EVALUATIONS_PER_TICK
    );
    expect(enqueue).toHaveBeenCalledTimes(MAX_ESCALATION_PAIR_EVALUATIONS_PER_TICK);
    expect(findPolicies).toHaveBeenCalledOnce();
    expect(findOccurrences).toHaveBeenCalledOnce();
  });

  it('rotates pages across ticks so rows beyond every bound are eventually evaluated', async () => {
    vi.mocked(enqueue).mockClear();
    const policies = Array.from({ length: 51 }, (_, i) => ({
      id: `policy_${i.toString().padStart(3, '0')}`,
      scope: (i === 50 ? 'ORG' : 'BRANCH') as 'ORG' | 'BRANCH',
      branchId: i === 50 ? null : 'another_branch',
      stopOnAcknowledged: false,
      quietHoursStartMinutes: null,
      quietHoursEndMinutes: null,
      steps: [{ id: `step_${i}`, delayMinutes: 0 }],
    }));
    const occurrences = Array.from({ length: 101 }, (_, i) => ({
      id: `occ_${i.toString().padStart(3, '0')}`,
      branchId: 'branch_1',
      windowEndsAt: WINDOW_ENDS,
      branch: { timezone: 'UTC' },
      escalationEvents: [],
    }));
    const findPolicies = vi.fn(({ skip, take }: { skip: number; take: number }) =>
      Promise.resolve(policies.slice(skip, skip + take))
    );
    const findOccurrences = vi.fn(({ skip, take }: { skip: number; take: number }) =>
      Promise.resolve(occurrences.slice(skip, skip + take))
    );
    const db = {
      restaurantSopEscalationPolicy: {
        count: vi.fn().mockResolvedValue(policies.length),
        findMany: findPolicies,
      },
      restaurantSopOccurrence: {
        count: vi.fn().mockResolvedValue(occurrences.length),
        findMany: findOccurrences,
      },
    } as unknown as ScopedDb;
    vi.mocked(enqueue).mockResolvedValue({
      job: {} as Awaited<ReturnType<typeof enqueue>>['job'],
      deduplicated: false,
    });

    const pageCombinations =
      Math.ceil(policies.length / MAX_ESCALATION_POLICIES_PER_TICK) *
      Math.ceil(occurrences.length / MAX_ESCALATION_OCCURRENCES_PER_TICK);
    for (let minute = 0; minute < pageCombinations; minute += 1) {
      await enqueueDueSopEscalations(db, new Date(WINDOW_ENDS.getTime() + minute * 60_000));
    }

    expect(enqueue).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        idempotencyKey: sopEscalationJobKey('occ_100', 'policy_050', 'step_50'),
      })
    );
    expect(new Set(findPolicies.mock.calls.map(([query]) => query.skip))).toEqual(
      new Set([0, 20, 40])
    );
    expect(new Set(findOccurrences.mock.calls.map(([query]) => query.skip))).toEqual(
      new Set([0, 25, 50, 75, 100])
    );
  });

  it('does not produce acknowledged or stopped chains', async () => {
    const policy = {
      id: 'policy_1',
      scope: 'ORG',
      branchId: null,
      stopOnAcknowledged: true,
      quietHoursStartMinutes: null,
      quietHoursEndMinutes: null,
      steps: [{ id: 'step_1', delayMinutes: 0 }],
    };
    const occurrence = (kind: 'ACKNOWLEDGED' | 'STOPPED') => ({
      id: `occ_${kind}`,
      branchId: 'branch_1',
      windowEndsAt: WINDOW_ENDS,
      branch: { timezone: 'UTC' },
      escalationEvents: [{ kind, escalationStepId: null, createdAt: WINDOW_ENDS }],
    });
    const db = {
      restaurantSopEscalationPolicy: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([policy]),
      },
      restaurantSopOccurrence: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([occurrence('ACKNOWLEDGED'), occurrence('STOPPED')]),
      },
    } as unknown as ScopedDb;
    vi.mocked(enqueue).mockClear();

    await expect(enqueueDueSopEscalations(db, WINDOW_ENDS)).resolves.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('re-enqueues after a queued job reaches quiet hours, then fires exactly once', async () => {
    const policy = {
      id: 'policy_1',
      active: true,
      scope: 'BRANCH',
      branchId: 'branch_1',
      stopOnAcknowledged: true,
      stopOnVerified: true,
      quietHoursStartMinutes: 780,
      quietHoursEndMinutes: 900,
      steps: [
        {
          id: 'step_1',
          stepOrder: 1,
          delayMinutes: 0,
          target: 'staff_mgr',
          channel: 'IN_APP',
          maxAttempts: 1,
        },
      ],
    };
    const occurrence = {
      id: 'occ_1',
      status: 'MISSED',
      branchId: 'branch_1',
      windowEndsAt: WINDOW_ENDS,
      branch: { timezone: 'UTC' },
      assignment: { template: { name: 'Open Check' } },
      escalationEvents: [],
    };
    const eventCreate = vi.fn().mockResolvedValue({ id: 'event_1' });
    const outboxCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const jobUpdate = vi.fn().mockResolvedValue({ id: 'job_1' });
    const dbObject = {
      restaurantSopEscalationPolicy: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([policy]),
        findUnique: vi.fn().mockResolvedValue(policy),
      },
      restaurantSopOccurrence: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([occurrence]),
        findUnique: vi.fn().mockResolvedValue(occurrence),
      },
      restaurantSopEscalationEvent: {
        findMany: vi.fn().mockResolvedValue([]),
        create: eventCreate,
      },
      restaurantEventOutbox: { createMany: outboxCreateMany },
      restaurantJob: { update: jobUpdate },
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'occ_1' }]),
    };
    Object.assign(dbObject, {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbObject)),
    });
    const db = dbObject as unknown as ScopedDb;
    vi.mocked(enqueue).mockResolvedValue({
      job: {} as Awaited<ReturnType<typeof enqueue>>['job'],
      deduplicated: false,
    });

    // Enqueued just before quiet hours, but not claimed until they have begun.
    await expect(enqueueDueSopEscalations(db, new Date('2026-08-20T12:59:00.000Z'))).resolves.toBe(
      1
    );
    await sopEscalationHandler({
      db,
      job: {
        id: 'job_1',
        organizationId: 'org_1',
        type: 'sop.runEscalation',
        payload: {
          occurrenceId: 'occ_1',
          policyId: 'policy_1',
          now: '2026-08-20T14:00:00.000Z',
        },
        attempts: 1,
        maxAttempts: 5,
        claimedBy: 'worker_1',
        startedAt: new Date('2026-08-20T14:00:00.000Z'),
      },
    });

    await expect(enqueueDueSopEscalations(db, new Date('2026-08-20T15:00:00.000Z'))).resolves.toBe(
      1
    );
    await sopEscalationHandler({
      db,
      job: {
        id: 'job_2',
        organizationId: 'org_1',
        type: 'sop.runEscalation',
        payload: {
          occurrenceId: 'occ_1',
          policyId: 'policy_1',
          now: '2026-08-20T15:00:00.000Z',
        },
        attempts: 1,
        maxAttempts: 5,
        claimedBy: 'worker_1',
        startedAt: new Date('2026-08-20T15:00:00.000Z'),
      },
    });

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(jobUpdate).toHaveBeenCalledWith({
      where: { id: 'job_1' },
      data: { idempotencyKey: null },
    });
    expect(outboxCreateMany).toHaveBeenCalledOnce();
    expect(eventCreate).toHaveBeenCalledOnce();
    expect(eventCreate.mock.calls[0][0].data.kind).toBe('FIRED');
  });

  it('queues the next elapsed step with a deterministic occurrence/policy/step key', async () => {
    const now = new Date('2026-08-20T12:30:00.000Z');
    const db = {
      restaurantSopEscalationPolicy: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'policy_1',
            scope: 'BRANCH',
            branchId: 'branch_1',
            quietHoursStartMinutes: null,
            quietHoursEndMinutes: null,
            steps: [
              { id: 'step_1', delayMinutes: 5 },
              { id: 'step_2', delayMinutes: 10 },
            ],
          },
        ]),
      },
      restaurantSopOccurrence: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'occ_1',
            branchId: 'branch_1',
            windowEndsAt: WINDOW_ENDS,
            branch: { timezone: 'UTC' },
            escalationEvents: [
              {
                escalationStepId: 'step_1',
                kind: 'FIRED',
                createdAt: new Date('2026-08-20T12:10:00.000Z'),
              },
            ],
          },
        ]),
      },
    } as unknown as ScopedDb;
    vi.mocked(enqueue).mockResolvedValue({
      job: {} as Awaited<ReturnType<typeof enqueue>>['job'],
      deduplicated: false,
    });

    await expect(enqueueDueSopEscalations(db, now)).resolves.toBe(1);
    expect(enqueue).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        type: 'sop.runEscalation',
        payload: { occurrenceId: 'occ_1', policyId: 'policy_1' },
        idempotencyKey: sopEscalationJobKey('occ_1', 'policy_1', 'step_2'),
      })
    );
  });

  it('queues an org-wide first step without letting another policy event delay it', async () => {
    const now = new Date('2026-08-20T12:06:00.000Z');
    const db = {
      restaurantSopEscalationPolicy: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'policy_1',
            scope: 'ORG',
            branchId: null,
            quietHoursStartMinutes: null,
            quietHoursEndMinutes: null,
            steps: [{ id: 'step_1', delayMinutes: 5 }],
          },
        ]),
      },
      restaurantSopOccurrence: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'occ_1',
            branchId: 'branch_1',
            windowEndsAt: WINDOW_ENDS,
            branch: { timezone: 'UTC' },
            escalationEvents: [
              {
                escalationStepId: 'another_policy_step',
                kind: 'FIRED',
                createdAt: new Date('2026-08-20T12:05:00.000Z'),
              },
            ],
          },
        ]),
      },
    } as unknown as ScopedDb;
    vi.mocked(enqueue).mockResolvedValue({
      job: {} as Awaited<ReturnType<typeof enqueue>>['job'],
      deduplicated: false,
    });

    await expect(enqueueDueSopEscalations(db, now)).resolves.toBe(1);
    expect(enqueue).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        idempotencyKey: sopEscalationJobKey('occ_1', 'policy_1', 'step_1'),
      })
    );
  });

  it('does not queue a branch policy for an occurrence in another branch', async () => {
    const db = {
      restaurantSopEscalationPolicy: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'policy_other',
            scope: 'BRANCH',
            branchId: 'branch_2',
            quietHoursStartMinutes: null,
            quietHoursEndMinutes: null,
            steps: [{ id: 'step_1', delayMinutes: 0 }],
          },
        ]),
      },
      restaurantSopOccurrence: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'occ_1',
            branchId: 'branch_1',
            windowEndsAt: WINDOW_ENDS,
            branch: { timezone: 'UTC' },
            escalationEvents: [],
          },
        ]),
      },
    } as unknown as ScopedDb;
    vi.mocked(enqueue).mockClear();

    await expect(enqueueDueSopEscalations(db, WINDOW_ENDS)).resolves.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
