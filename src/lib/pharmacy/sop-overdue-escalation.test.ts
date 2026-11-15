/**
 * DEV-751 — opt-in overdue escalation for pharmacy procedures.
 *
 * Runs the real scheduler `enqueue`, the real shared escalation policy
 * configuration and the real shared escalation handler (`sop.runEscalation`)
 * over an in-memory org-scoped db; only the notification outbox write is
 * mocked. Pins: OFF by default (no policy, no job, nothing enqueued, nothing
 * fired); turning ON stores one BRANCH policy on the shared model with one
 * IN_APP step to the manager who turned it on and starts the sweep; the sweep
 * hands overdue, unsubmitted pharmacy work at ON branches to the shared
 * handler, which fires once the delay elapses and stops on resolution;
 * turning OFF deactivates the policy and the sweep then stops.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const outbox = vi.hoisted(() => ({ appendNotificationRequest: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/notification-fanout', () => ({
  appendNotificationRequest: outbox.appendNotificationRequest,
}));

import type { ClaimedJob } from '@/lib/restaurant/scheduler';
import { SOP_ESCALATION_JOB, sopEscalationHandler } from '@/lib/restaurant/sop-escalation';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  PHARMACY_SOP_ESCALATE_OVERDUE_JOB,
  PHARMACY_SOP_ESCALATION_DEFAULT,
  PHARMACY_SOP_ESCALATION_POLICY_NAME,
  PharmacySopEscalationError,
  nextPharmacySopEscalationSlot,
  parsePharmacySopEscalationSweepPayload,
  pharmacySopEscalateOverdueHandler,
  pharmacySopEscalationRunKey,
  pharmacySopEscalationSweepKey,
  pharmacySopOverdueEscalation,
  setPharmacySopOverdueEscalation,
} from './sop-overdue-escalation';

const ORG = 'org_a';
const OPENING = 'Pharmacy — opening';
const at = (iso: string) => new Date(iso);

type Policy = {
  id: string;
  name: string;
  scope: 'ORG' | 'BRANCH';
  branchId: string | null;
  active: boolean;
  stopOnAcknowledged: boolean;
  stopOnVerified: boolean;
  quietHoursStartMinutes: number | null;
  quietHoursEndMinutes: number | null;
  createdAt: Date;
  updatedAt: Date;
};
type Step = {
  id: string;
  policyId: string;
  stepOrder: number;
  delayMinutes: number;
  target: string;
  channel: string;
  maxAttempts: number;
};
type Occurrence = {
  id: string;
  branchId: string;
  status: string;
  submittedAt: Date | null;
  windowEndsAt: Date;
  templateName: string;
};
type Event = {
  id: string;
  occurrenceId: string;
  escalationStepId: string | null;
  kind: 'FIRED' | 'ACKNOWLEDGED' | 'STOPPED';
  createdAt: Date;
  detail?: string | null;
};
type Job = { id: string; type: string; payload: unknown; idempotencyKey: string | null };

const SITES = [
  { pharmacyBranchId: 'pb_1', sopBranchId: 'sop_1' },
  { pharmacyBranchId: 'pb_2', sopBranchId: 'sop_2' },
];

function makeDb(opts: { occurrences?: Occurrence[]; clock?: () => Date } = {}) {
  const clock = opts.clock ?? (() => at('2026-11-04T06:00:00Z'));
  const policies: Policy[] = [];
  const steps: Step[] = [];
  const events: Event[] = [];
  const jobs: Job[] = [];
  const occurrences = [...(opts.occurrences ?? [])];
  const stepsOf = (policyId: string) =>
    steps.filter((step) => step.policyId === policyId).sort((a, b) => a.stepOrder - b.stepOrder);
  const withSteps = (policy: Policy, take?: number) => ({
    ...policy,
    steps: stepsOf(policy.id).slice(0, take ?? Infinity),
  });
  const raw = {
    restaurantJob: {
      findFirst: vi.fn(
        async ({ where }: { where: { idempotencyKey: string } }) =>
          jobs.find((job) => job.idempotencyKey === where.idempotencyKey) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Omit<Job, 'id'> }) => {
        const row = { ...data, id: `job_${jobs.length + 1}` };
        jobs.push(row);
        return row;
      }),
    },
    pharmacySopSite: {
      findMany: vi.fn(async () => SITES.map(({ sopBranchId }) => ({ sopBranchId }))),
    },
    restaurantSopEscalationPolicy: {
      findFirst: vi.fn(
        async ({ where }: { where: { branchId: string; scope: string; name: string } }) => {
          const row = policies.find(
            (policy) =>
              policy.branchId === where.branchId &&
              policy.scope === where.scope &&
              policy.name === where.name
          );
          return row ? withSteps(row, 1) : null;
        }
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { name: string; scope: string; active: boolean; branchId: { in: string[] } };
        }) =>
          policies.filter(
            (policy) =>
              policy.name === where.name &&
              policy.scope === where.scope &&
              policy.active === where.active &&
              where.branchId.in.includes(policy.branchId ?? '') &&
              stepsOf(policy.id).length > 0
          )
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = policies.find((policy) => policy.id === where.id);
        return row ? withSteps(row) : null;
      }),
      create: vi.fn(async ({ data }: { data: Partial<Policy> }) => {
        const row: Policy = {
          id: `pol_${policies.length + 1}`,
          name: data.name!,
          scope: data.scope!,
          branchId: data.branchId ?? null,
          active: true,
          stopOnAcknowledged: data.stopOnAcknowledged ?? true,
          stopOnVerified: data.stopOnVerified ?? true,
          quietHoursStartMinutes: data.quietHoursStartMinutes ?? null,
          quietHoursEndMinutes: data.quietHoursEndMinutes ?? null,
          createdAt: clock(),
          updatedAt: clock(),
        };
        policies.push(row);
        return withSteps(row);
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Policy> }) => {
        const row = policies.find((policy) => policy.id === where.id)!;
        Object.assign(row, data, { updatedAt: clock() });
        return withSteps(row);
      }),
      upsert: vi.fn(),
    },
    restaurantSopEscalationStep: {
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { policyId_stepOrder: { policyId: string; stepOrder: number } };
          create: Omit<Step, 'id'>;
          update: Partial<Step>;
        }) => {
          const { policyId, stepOrder } = where.policyId_stepOrder;
          const existing = steps.find((s) => s.policyId === policyId && s.stepOrder === stepOrder);
          if (existing) return Object.assign(existing, update);
          const row = { ...create, id: `step_${steps.length + 1}` } as Step;
          steps.push(row);
          return row;
        }
      ),
    },
    restaurantSopOccurrence: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            branchId: string;
            status: { in: string[] };
            submittedAt: null;
            windowEndsAt: { lt: Date; gte: Date };
          };
        }) =>
          occurrences
            .filter(
              (occ) =>
                occ.branchId === where.branchId &&
                where.status.in.includes(occ.status) &&
                occ.submittedAt === null &&
                occ.windowEndsAt < where.windowEndsAt.lt &&
                occ.windowEndsAt >= where.windowEndsAt.gte &&
                !events.some((e) => e.occurrenceId === occ.id && e.kind === 'STOPPED')
            )
            .map((occ) => ({ id: occ.id, assignment: { template: { name: occ.templateName } } }))
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const occ = occurrences.find((row) => row.id === where.id);
        return occ
          ? {
              id: occ.id,
              status: occ.status,
              branchId: occ.branchId,
              windowEndsAt: occ.windowEndsAt,
              branch: { timezone: 'Asia/Karachi' },
              assignment: { template: { name: occ.templateName } },
            }
          : null;
      }),
    },
    restaurantSopEscalationEvent: {
      findMany: vi.fn(async ({ where }: { where: { occurrenceId: string } }) =>
        events.filter((e) => e.occurrenceId === where.occurrenceId)
      ),
      create: vi.fn(async ({ data }: { data: Omit<Event, 'id'> }) => {
        const row = { ...data, id: `evt_${events.length + 1}` };
        events.push(row);
        return row;
      }),
    },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(),
  };
  raw.$transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(raw));
  return { db: raw as unknown as ScopedDb, raw, policies, steps, events, jobs, occurrences };
}

function claimed(slot: string, startedAt: string, type = PHARMACY_SOP_ESCALATE_OVERDUE_JOB) {
  return {
    id: 'job_claimed',
    organizationId: ORG,
    type,
    payload: { slot },
    attempts: 1,
    maxAttempts: 5,
    claimedBy: 'worker',
    claimToken: 'token',
    startedAt: at(startedAt),
  } as ClaimedJob;
}

/** Run every queued shared escalation job through the shared handler. */
async function runEscalationJobs(db: ScopedDb, jobs: Job[], now: string) {
  for (const job of jobs.filter((row) => row.type === SOP_ESCALATION_JOB)) {
    await sopEscalationHandler({
      db,
      job: {
        ...claimed('', now, SOP_ESCALATION_JOB),
        payload: { ...(job.payload as object), now: at(now).toISOString() },
      } as ClaimedJob,
    });
  }
}

const overdue = (id: string, overrides: Partial<Occurrence> = {}): Occurrence => ({
  id,
  branchId: 'sop_1',
  status: 'SCHEDULED',
  submittedAt: null,
  windowEndsAt: at('2026-11-04T07:00:00Z'),
  templateName: OPENING,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OFF by default (no default escalation)', () => {
  it('reads OFF when the branch never turned it on', async () => {
    const { db } = makeDb();
    expect(PHARMACY_SOP_ESCALATION_DEFAULT).toBe(false);
    await expect(pharmacySopOverdueEscalation(db, { site: SITES[0]! })).resolves.toEqual({
      pharmacyBranchId: 'pb_1',
      enabled: false,
      delayMinutes: 30,
      targetStaffProfileId: null,
      changedAt: null,
    });
  });

  it('a sweep with no branch ON enqueues nothing, not even its next run', async () => {
    const { db, raw, jobs } = makeDb({ occurrences: [overdue('occ_1')] });
    await pharmacySopEscalateOverdueHandler({
      db,
      job: claimed('2026-11-04T09:00:00.000Z', '2026-11-04T09:00:05Z'),
    });
    expect(jobs).toEqual([]);
    expect(raw.restaurantSopEscalationPolicy.create).not.toHaveBeenCalled();
    expect(raw.restaurantSopEscalationEvent.create).not.toHaveBeenCalled();
    expect(outbox.appendNotificationRequest).not.toHaveBeenCalled();
  });

  it('turning OFF a branch that was never ON writes nothing', async () => {
    const { db, raw, jobs } = makeDb();
    const result = await setPharmacySopOverdueEscalation(db, {
      organizationId: ORG,
      site: SITES[0]!,
      enabled: false,
      targetStaffProfileId: 'staff_mgr',
      now: at('2026-11-04T06:00:00Z'),
    });
    expect(result).toMatchObject({ changed: false, nextRunAt: null, setting: { enabled: false } });
    expect(raw.restaurantSopEscalationPolicy.create).not.toHaveBeenCalled();
    expect(raw.restaurantSopEscalationPolicy.update).not.toHaveBeenCalled();
    expect(jobs).toEqual([]);
  });
});

describe('turning ON', () => {
  it('stores one BRANCH policy on the shared model with one IN_APP step to the manager', async () => {
    const { db, policies, steps, jobs } = makeDb();
    const result = await setPharmacySopOverdueEscalation(db, {
      organizationId: ORG,
      site: SITES[0]!,
      enabled: true,
      delayMinutes: 45,
      targetStaffProfileId: 'staff_mgr',
      now: at('2026-11-04T06:07:00Z'),
    });
    expect(policies).toEqual([
      expect.objectContaining({
        name: PHARMACY_SOP_ESCALATION_POLICY_NAME,
        scope: 'BRANCH',
        branchId: 'sop_1',
        active: true,
        stopOnVerified: true,
        stopOnAcknowledged: true,
      }),
    ]);
    expect(steps).toEqual([
      expect.objectContaining({
        policyId: policies[0]!.id,
        stepOrder: 1,
        delayMinutes: 45,
        target: 'staff_mgr',
        channel: 'IN_APP',
      }),
    ]);
    expect(result.changed).toBe(true);
    expect(result.setting).toMatchObject({
      enabled: true,
      delayMinutes: 45,
      targetStaffProfileId: 'staff_mgr',
    });
    // The organization's next sweep (15-minute cadence).
    expect(result.nextRunAt?.toISOString()).toBe('2026-11-04T06:15:00.000Z');
    expect(jobs).toEqual([
      expect.objectContaining({
        type: PHARMACY_SOP_ESCALATE_OVERDUE_JOB,
        idempotencyKey: 'pharmacy.sop.escalateOverdue:2026-11-04T06:15:00.000Z',
      }),
    ]);
  });

  it('is idempotent: the same setting twice keeps one policy, one step and one sweep', async () => {
    const { db, policies, steps, jobs } = makeDb();
    const input = {
      organizationId: ORG,
      site: SITES[0]!,
      enabled: true,
      delayMinutes: 30,
      targetStaffProfileId: 'staff_mgr',
      now: at('2026-11-04T06:07:00Z'),
    };
    await setPharmacySopOverdueEscalation(db, input);
    const again = await setPharmacySopOverdueEscalation(db, input);
    expect(again.changed).toBe(false);
    expect(policies).toHaveLength(1);
    expect(steps).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });

  it('touches only its own branch', async () => {
    const { db } = makeDb();
    await setPharmacySopOverdueEscalation(db, {
      organizationId: ORG,
      site: SITES[0]!,
      enabled: true,
      targetStaffProfileId: 'staff_mgr',
      now: at('2026-11-04T06:07:00Z'),
    });
    expect((await pharmacySopOverdueEscalation(db, { site: SITES[0]! })).enabled).toBe(true);
    expect((await pharmacySopOverdueEscalation(db, { site: SITES[1]! })).enabled).toBe(false);
  });

  it('refuses a delay outside the bounds or without a manager, writing nothing', async () => {
    const { db, policies } = makeDb();
    for (const delayMinutes of [-1, 1441, 2.5]) {
      await expect(
        setPharmacySopOverdueEscalation(db, {
          organizationId: ORG,
          site: SITES[0]!,
          enabled: true,
          delayMinutes,
          targetStaffProfileId: 'staff_mgr',
          now: at('2026-11-04T06:07:00Z'),
        })
      ).rejects.toBeInstanceOf(PharmacySopEscalationError);
    }
    await expect(
      setPharmacySopOverdueEscalation(db, {
        organizationId: ORG,
        site: SITES[0]!,
        enabled: true,
        targetStaffProfileId: '',
        now: at('2026-11-04T06:07:00Z'),
      })
    ).rejects.toBeInstanceOf(PharmacySopEscalationError);
    expect(policies).toEqual([]);
  });
});

describe('the sweep and the shared handler, when ON', () => {
  async function turnOn(db: ScopedDb, now = '2026-11-04T06:00:00Z', delayMinutes = 30) {
    return setPharmacySopOverdueEscalation(db, {
      organizationId: ORG,
      site: SITES[0]!,
      enabled: true,
      delayMinutes,
      targetStaffProfileId: 'staff_mgr',
      now: at(now),
    });
  }

  it('hands only overdue, unsubmitted pharmacy work at the ON branch to the shared handler', async () => {
    const { db, jobs } = makeDb({
      occurrences: [
        overdue('occ_due'),
        overdue('occ_in_progress', { status: 'IN_PROGRESS' }),
        // Not yet overdue at 07:30.
        overdue('occ_open', { windowEndsAt: at('2026-11-04T08:00:00Z') }),
        // Submitted, sent back or done: never escalated.
        overdue('occ_submitted', { status: 'SUBMITTED', submittedAt: at('2026-11-04T07:05:00Z') }),
        overdue('occ_rejected', { status: 'REJECTED' }),
        overdue('occ_verified', { status: 'VERIFIED' }),
        // Overdue before escalation was turned on: never back-dated.
        overdue('occ_before', { windowEndsAt: at('2026-11-04T05:00:00Z') }),
        // A branch that is OFF.
        overdue('occ_other_branch', { branchId: 'sop_2' }),
        // Not a pharmacy procedure.
        overdue('occ_restaurant', { templateName: 'Kitchen opening' }),
      ],
    });
    await turnOn(db);
    jobs.length = 0;
    await pharmacySopEscalateOverdueHandler({
      db,
      job: claimed('2026-11-04T07:30:00.000Z', '2026-11-04T07:30:04Z'),
    });
    const escalations = jobs.filter((job) => job.type === SOP_ESCALATION_JOB);
    expect(escalations.map((job) => job.payload)).toEqual([
      { occurrenceId: 'occ_due', policyId: 'pol_1' },
      { occurrenceId: 'occ_in_progress', policyId: 'pol_1' },
    ]);
    expect(escalations.map((job) => job.idempotencyKey)).toEqual([
      pharmacySopEscalationRunKey('occ_due', 'pol_1', at('2026-11-04T07:30:00Z')),
      pharmacySopEscalationRunKey('occ_in_progress', 'pol_1', at('2026-11-04T07:30:00Z')),
    ]);
    // And the next sweep.
    expect(jobs.filter((job) => job.type === PHARMACY_SOP_ESCALATE_OVERDUE_JOB)).toEqual([
      expect.objectContaining({
        idempotencyKey: pharmacySopEscalationSweepKey(at('2026-11-04T07:45:00Z')),
      }),
    ]);
  });

  it('a repeated sweep of the same slot enqueues nothing new', async () => {
    const { db, jobs } = makeDb({ occurrences: [overdue('occ_due')] });
    await turnOn(db);
    const job = claimed('2026-11-04T07:30:00.000Z', '2026-11-04T07:30:04Z');
    await pharmacySopEscalateOverdueHandler({ db, job });
    const count = jobs.length;
    await pharmacySopEscalateOverdueHandler({ db, job });
    expect(jobs).toHaveLength(count);
  });

  it('notifies the manager once the delay elapses, then stops', async () => {
    const { db, jobs, events } = makeDb({ occurrences: [overdue('occ_due')] });
    await turnOn(db);

    // 07:15: 15 minutes overdue, delay 30 — the shared handler defers.
    await pharmacySopEscalateOverdueHandler({
      db,
      job: claimed('2026-11-04T07:15:00.000Z', '2026-11-04T07:15:02Z'),
    });
    await runEscalationJobs(db, jobs, '2026-11-04T07:15:02Z');
    expect(events).toEqual([]);
    expect(outbox.appendNotificationRequest).not.toHaveBeenCalled();

    // 07:30: the delay has elapsed — one in-app notification to the manager.
    jobs.length = 0;
    await pharmacySopEscalateOverdueHandler({
      db,
      job: claimed('2026-11-04T07:30:00.000Z', '2026-11-04T07:30:02Z'),
    });
    await runEscalationJobs(db, jobs, '2026-11-04T07:30:02Z');
    expect(outbox.appendNotificationRequest).toHaveBeenCalledTimes(1);
    expect(outbox.appendNotificationRequest).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        recipientStaffProfileIds: ['staff_mgr'],
        branchId: 'sop_1',
        category: 'sop.escalation',
        entityId: 'occ_due',
        channels: ['IN_APP'],
      })
    );
    expect(events.map((e) => e.kind)).toEqual(['FIRED']);

    // 07:45: the one-step chain is exhausted — the shared handler stops it,
    // and later sweeps no longer hand it over.
    jobs.length = 0;
    await pharmacySopEscalateOverdueHandler({
      db,
      job: claimed('2026-11-04T07:45:00.000Z', '2026-11-04T07:45:02Z'),
    });
    await runEscalationJobs(db, jobs, '2026-11-04T07:45:02Z');
    expect(events.map((e) => e.kind)).toEqual(['FIRED', 'STOPPED']);
    jobs.length = 0;
    await pharmacySopEscalateOverdueHandler({
      db,
      job: claimed('2026-11-04T08:00:00.000Z', '2026-11-04T08:00:02Z'),
    });
    expect(jobs.filter((job) => job.type === SOP_ESCALATION_JOB)).toEqual([]);
    expect(outbox.appendNotificationRequest).toHaveBeenCalledTimes(1);
  });

  it('turning OFF deactivates the policy: nothing fires and the sweep stops', async () => {
    const { db, jobs, events, policies } = makeDb({ occurrences: [overdue('occ_due')] });
    await turnOn(db);
    // A shared job already queued before the switch went off.
    await pharmacySopEscalateOverdueHandler({
      db,
      job: claimed('2026-11-04T07:30:00.000Z', '2026-11-04T07:30:02Z'),
    });
    const off = await setPharmacySopOverdueEscalation(db, {
      organizationId: ORG,
      site: SITES[0]!,
      enabled: false,
      targetStaffProfileId: 'staff_mgr',
      now: at('2026-11-04T07:31:00Z'),
    });
    expect(off).toMatchObject({ changed: true, nextRunAt: null, setting: { enabled: false } });
    expect(policies).toEqual([expect.objectContaining({ active: false })]);

    await runEscalationJobs(db, jobs, '2026-11-04T07:32:00Z');
    expect(events).toEqual([]);
    expect(outbox.appendNotificationRequest).not.toHaveBeenCalled();

    jobs.length = 0;
    await pharmacySopEscalateOverdueHandler({
      db,
      job: claimed('2026-11-04T07:45:00.000Z', '2026-11-04T07:45:02Z'),
    });
    expect(jobs).toEqual([]);
  });

  it('turning back ON reactivates the same policy and does not back-date', async () => {
    let now = at('2026-11-04T06:00:00Z');
    const clocked = makeDb({
      occurrences: [overdue('occ_old', { windowEndsAt: at('2026-11-04T07:10:00Z') })],
      clock: () => now,
    });
    await turnOn(clocked.db);
    now = at('2026-11-04T07:00:00Z');
    await setPharmacySopOverdueEscalation(clocked.db, {
      organizationId: ORG,
      site: SITES[0]!,
      enabled: false,
      targetStaffProfileId: 'staff_mgr',
      now,
    });
    now = at('2026-11-04T07:20:00Z');
    await turnOn(clocked.db, '2026-11-04T07:20:00Z');
    expect(clocked.policies).toHaveLength(1);
    expect(clocked.policies[0]!.active).toBe(true);
    clocked.jobs.length = 0;
    await pharmacySopEscalateOverdueHandler({
      db: clocked.db,
      job: claimed('2026-11-04T08:00:00.000Z', '2026-11-04T08:00:02Z'),
    });
    // occ_old went overdue (07:10) while escalation was OFF.
    expect(clocked.jobs.filter((job) => job.type === SOP_ESCALATION_JOB)).toEqual([]);
  });
});

describe('payloads and slots', () => {
  it('runs every 15 minutes and parses only an aligned slot', () => {
    expect(nextPharmacySopEscalationSlot(at('2026-11-04T06:14:59Z')).toISOString()).toBe(
      '2026-11-04T06:15:00.000Z'
    );
    expect(parsePharmacySopEscalationSweepPayload({ slot: '2026-11-04T06:15:00.000Z' })).toEqual({
      slot: '2026-11-04T06:15:00.000Z',
    });
    expect(() =>
      parsePharmacySopEscalationSweepPayload({ slot: '2026-11-04T06:16:00.000Z' })
    ).toThrow();
    expect(() =>
      parsePharmacySopEscalationSweepPayload({ slot: '2026-11-04T06:15:00.000Z', extra: 1 })
    ).toThrow();
  });
});
