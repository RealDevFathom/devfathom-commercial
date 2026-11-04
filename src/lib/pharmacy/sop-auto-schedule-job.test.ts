/**
 * DEV-751 — the pharmacy SOP automatic-scheduling jobs (hourly parent +
 * per-branch child). Runs the real scheduler `enqueue` (idempotency-key dedupe,
 * DUPLICATE_ENQUEUE race) and the real settings reads over an in-memory
 * org-scoped db; only the engine generator is mocked. Pins: deterministic slot
 * and branch keys, a per-organization slot lock that fails closed, strict
 * payloads, a parent that only reads settings and enqueues (next slot + one
 * child per ON branch, all on the handler's own `db`), a child that re-reads
 * its branch and generates for it alone, no back-dating, no job in an
 * organization with no SOP site (a restaurant), and idempotence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

const engine = vi.hoisted(() => ({ generateDueSopOccurrences: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/sop-occurrence-generation', () => ({
  generateDueSopOccurrences: engine.generateDueSopOccurrences,
}));

import type { ClaimedJob } from '@/lib/restaurant/scheduler';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB,
  PHARMACY_SOP_AUTO_GENERATE_CADENCE_MS,
  PHARMACY_SOP_AUTO_GENERATE_JOB,
  ensurePharmacySopAutoScheduleJob,
  nextPharmacySopAutoGenerateSlot,
  parsePharmacySopAutoGenerateBranchPayload,
  parsePharmacySopAutoGeneratePayload,
  pharmacySopAutoGenerateBranchHandler,
  pharmacySopAutoGenerateBranchJobKey,
  pharmacySopAutoGenerateHandler,
  pharmacySopAutoGenerateJobKey,
  pharmacySopAutoGenerateLockKey,
  pharmacySopAutoGenerateSlot,
  startPharmacySopAutoSchedule,
} from './sop-auto-schedule-job';

const ORG = 'org_a';

type JobRow = {
  id: string;
  type: string;
  payload: unknown;
  idempotencyKey: string | null;
  scheduledAt: Date;
  nextAttemptAt: Date;
  status: string;
};

type Site = { pharmacyBranchId: string; sopBranchId: string; active?: boolean };
type Setting = {
  id: string;
  pharmacyBranchId: string;
  autoScheduleEnabled: boolean;
  createdAt: Date;
};

function makeDb(opts: { sites?: Site[]; settings?: Setting[] } = {}) {
  const jobs: JobRow[] = [];
  const settings = [...(opts.settings ?? [])];
  const newestFirst = (a: Setting, b: Setting) =>
    b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
  const activeSites = () => (opts.sites ?? []).filter((site) => site.active !== false);
  /** When set, the next create loses a race to a concurrent enqueue of the same key. */
  let raceOnce: JobRow | null = null;
  const raw = {
    restaurantJob: {
      findFirst: vi.fn(async ({ where }: { where: { idempotencyKey: string } }) => {
        return jobs.find((job) => job.idempotencyKey === where.idempotencyKey) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Omit<JobRow, 'id'> }) => {
        if (raceOnce) {
          jobs.push(raceOnce);
          raceOnce = null;
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        if (jobs.some((job) => job.idempotencyKey === data.idempotencyKey)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const row = { ...data, id: `job_${jobs.length + 1}` };
        jobs.push(row);
        return row;
      }),
    },
    pharmacySopSite: {
      findMany: vi.fn(async () =>
        activeSites().map(({ pharmacyBranchId }) => ({ pharmacyBranchId }))
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { pharmacyBranchId: string } }) =>
          activeSites()
            .filter((site) => site.pharmacyBranchId === where.pharmacyBranchId)
            .map(({ pharmacyBranchId, sopBranchId }) => ({ pharmacyBranchId, sopBranchId }))[0] ??
          null
      ),
    },
    pharmacySopSiteSetting: {
      findMany: vi.fn(async ({ where }: { where: { pharmacyBranchId: { in: string[] } } }) =>
        settings
          .filter((row) => where.pharmacyBranchId.in.includes(row.pharmacyBranchId))
          .sort(newestFirst)
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { pharmacyBranchId: string } }) =>
          settings
            .filter((row) => row.pharmacyBranchId === where.pharmacyBranchId)
            .sort(newestFirst)[0] ?? null
      ),
    },
    restaurantSopEscalationPolicy: { create: vi.fn(), upsert: vi.fn() },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(),
  };
  raw.$transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(raw));
  return {
    db: raw as unknown as ScopedDb,
    raw,
    jobs,
    settings,
    loseNextRace(winner: JobRow) {
      raceOnce = winner;
    },
  };
}

const at = (iso: string) => new Date(iso);
/** The first raw query a mocked client ran (the slot lock). */
const firstQuery = (raw: { $queryRaw: { mock: { calls: unknown[][] } } }) =>
  raw.$queryRaw.mock.calls[0]![0];
const setting = (id: string, pharmacyBranchId: string, on: boolean, iso: string): Setting => ({
  id,
  pharmacyBranchId,
  autoScheduleEnabled: on,
  createdAt: at(iso),
});

function claimed(
  slot: string,
  startedAt: string,
  payload: unknown = { slot },
  type: string = PHARMACY_SOP_AUTO_GENERATE_JOB
): ClaimedJob {
  return {
    id: 'job_claimed',
    organizationId: 'org_a',
    type,
    payload: payload as ClaimedJob['payload'],
    attempts: 1,
    maxAttempts: 5,
    claimedBy: 'worker',
    claimToken: 'token',
    startedAt: at(startedAt),
  };
}

const SITES: Site[] = [
  { pharmacyBranchId: 'pb_1', sopBranchId: 'sop_1' },
  { pharmacyBranchId: 'pb_2', sopBranchId: 'sop_2' },
];

beforeEach(() => {
  vi.clearAllMocks();
  engine.generateDueSopOccurrences.mockResolvedValue({
    assignmentsProcessed: 2,
    created: 4,
    skipped: 0,
  });
});

describe('slots and keys', () => {
  it('is hourly', () => {
    expect(PHARMACY_SOP_AUTO_GENERATE_CADENCE_MS).toBe(3_600_000);
    expect(PHARMACY_SOP_AUTO_GENERATE_JOB).toBe('pharmacy.sop.autoGenerate');
  });

  it('floors to the hour and derives a deterministic key', () => {
    for (const iso of [
      '2026-11-04T06:00:00.000Z',
      '2026-11-04T06:29:13.120Z',
      '2026-11-04T06:59:59.999Z',
    ]) {
      expect(pharmacySopAutoGenerateSlot(at(iso)).toISOString()).toBe('2026-11-04T06:00:00.000Z');
      expect(nextPharmacySopAutoGenerateSlot(at(iso)).toISOString()).toBe(
        '2026-11-04T07:00:00.000Z'
      );
      expect(pharmacySopAutoGenerateJobKey(at(iso))).toBe(
        'pharmacy.sop.autoGenerate:2026-11-04T06:00:00.000Z'
      );
    }
    expect(nextPharmacySopAutoGenerateSlot(at('2026-12-31T23:30:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z'
    );
    expect(() => pharmacySopAutoGenerateSlot(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('pharmacySopAutoGenerateLockKey', () => {
  it('names the organization explicitly, so tenants never share a slot lock', () => {
    const slot = at('2026-11-04T07:00:00Z');
    expect(pharmacySopAutoGenerateLockKey('org_a', slot)).toBe(
      'pharmacy.sop.autoGenerate:org_a:2026-11-04T07:00:00.000Z'
    );
    expect(pharmacySopAutoGenerateLockKey('org_b', slot)).not.toBe(
      pharmacySopAutoGenerateLockKey('org_a', slot)
    );
    // Floored to the slot like the job key.
    expect(pharmacySopAutoGenerateLockKey('org_a', at('2026-11-04T07:42:00Z'))).toBe(
      pharmacySopAutoGenerateLockKey('org_a', slot)
    );
  });

  it('fails closed on a missing or malformed organization', () => {
    for (const bad of ['', 'ab', 'org a', 'org:a', `o${'x'.repeat(128)}`, undefined, null, 7]) {
      expect(() =>
        pharmacySopAutoGenerateLockKey(bad as unknown as string, at('2026-11-04T07:00:00Z'))
      ).toThrow(TypeError);
    }
  });
});

describe('ensurePharmacySopAutoScheduleJob', () => {
  it('enqueues the next slot, due at the slot, under a serializing lock', async () => {
    const { db, raw, jobs } = makeDb();
    const result = await ensurePharmacySopAutoScheduleJob(db, {
      organizationId: ORG,
      now: at('2026-11-04T06:30:00Z'),
    });
    expect(result.deduplicated).toBe(false);
    expect(result.slot.toISOString()).toBe('2026-11-04T07:00:00.000Z');
    expect(jobs).toEqual([
      expect.objectContaining({
        type: 'pharmacy.sop.autoGenerate',
        payload: { slot: '2026-11-04T07:00:00.000Z' },
        idempotencyKey: 'pharmacy.sop.autoGenerate:2026-11-04T07:00:00.000Z',
        scheduledAt: at('2026-11-04T07:00:00Z'),
        nextAttemptAt: at('2026-11-04T07:00:00Z'),
        status: 'QUEUED',
      }),
    ]);
    expect(raw.$queryRaw).toHaveBeenCalledTimes(1);
    // The lock is per organization and slot; the idempotency key is not.
    expect(firstQuery(raw)).toMatchObject({
      values: ['pharmacy.sop.autoGenerate:org_a:2026-11-04T07:00:00.000Z'],
    });
  });

  it('fails closed without an organization, before any lock or job', async () => {
    const { db, raw, jobs } = makeDb();
    for (const organizationId of ['', '   ', 'a', 'org a', 'org;drop', undefined, null]) {
      await expect(
        ensurePharmacySopAutoScheduleJob(db, {
          organizationId: organizationId as unknown as string,
          now: at('2026-11-04T06:30:00Z'),
        })
      ).rejects.toThrow(TypeError);
    }
    expect(raw.$queryRaw).not.toHaveBeenCalled();
    expect(raw.$transaction).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });

  it('never creates a second job for the same slot (repeated toggles)', async () => {
    const { db, jobs } = makeDb();
    for (const iso of ['2026-11-04T06:01:00Z', '2026-11-04T06:20:00Z', '2026-11-04T06:59:00Z']) {
      await ensurePharmacySopAutoScheduleJob(db, { organizationId: ORG, now: at(iso) });
    }
    expect(jobs).toHaveLength(1);
    const again = await ensurePharmacySopAutoScheduleJob(db, {
      organizationId: ORG,
      now: at('2026-11-04T06:45:00Z'),
    });
    expect(again.deduplicated).toBe(true);
    expect(again.job.id).toBe(jobs[0]!.id);
  });

  it('handles a lost DUPLICATE_ENQUEUE race by returning the winner', async () => {
    const { db, raw, jobs, loseNextRace } = makeDb();
    const winner: JobRow = {
      id: 'job_winner',
      type: PHARMACY_SOP_AUTO_GENERATE_JOB,
      payload: { slot: '2026-11-04T07:00:00.000Z' },
      idempotencyKey: 'pharmacy.sop.autoGenerate:2026-11-04T07:00:00.000Z',
      scheduledAt: at('2026-11-04T07:00:00Z'),
      nextAttemptAt: at('2026-11-04T07:00:00Z'),
      status: 'QUEUED',
    };
    loseNextRace(winner);
    const result = await ensurePharmacySopAutoScheduleJob(db, {
      organizationId: ORG,
      now: at('2026-11-04T06:30:00Z'),
    });
    expect(result).toMatchObject({ deduplicated: true, job: { id: 'job_winner' } });
    expect(jobs).toHaveLength(1);
    expect(raw.restaurantJob.create).toHaveBeenCalledTimes(1);
  });
});

describe('startPharmacySopAutoSchedule', () => {
  it('ensures the chain, then generates for that branch only, all on the given db', async () => {
    const { db, jobs } = makeDb({ sites: SITES });
    const now = at('2026-11-04T06:30:00Z');
    const result = await startPharmacySopAutoSchedule(db, {
      organizationId: ORG,
      sopBranchId: 'sop_1',
      now,
    });
    // From the current business date only: never back-dated to days it was OFF.
    expect(engine.generateDueSopOccurrences).toHaveBeenCalledExactlyOnceWith(db, {
      now,
      branchIds: ['sop_1'],
      lookbackDays: 0,
      skipDueBeforeAssignmentCreated: true,
    });
    expect(result.generated.created).toBe(4);
    expect(jobs).toHaveLength(1);
    expect(result.job.slot.toISOString()).toBe('2026-11-04T07:00:00.000Z');
  });

  it('with the time the branch turned ON, never creates work due before it', async () => {
    const { db } = makeDb({ sites: SITES });
    const now = at('2026-11-04T06:30:00Z');
    const enabledAt = at('2026-11-04T06:29:10Z');
    await startPharmacySopAutoSchedule(db, {
      organizationId: ORG,
      sopBranchId: 'sop_1',
      now,
      enabledAt,
    });
    expect(engine.generateDueSopOccurrences).toHaveBeenCalledExactlyOnceWith(db, {
      now,
      branchIds: ['sop_1'],
      lookbackDays: 0,
      skipDueBeforeAssignmentCreated: true,
      skipDueBefore: enabledAt,
    });
  });

  it('on a per-operation client, keeps the chain when creating today’s work fails', async () => {
    const { db, jobs } = makeDb({ sites: SITES });
    engine.generateDueSopOccurrences.mockRejectedValueOnce(new Error('engine down'));
    await expect(
      startPharmacySopAutoSchedule(db, {
        organizationId: ORG,
        sopBranchId: 'sop_1',
        now: at('2026-11-04T06:30:00Z'),
      })
    ).rejects.toThrow('engine down');
    expect(jobs).toHaveLength(1);
  });
});

describe('payloads', () => {
  it('the parent payload is strict and slot-aligned', () => {
    expect(parsePharmacySopAutoGeneratePayload({ slot: '2026-11-04T07:00:00.000Z' })).toEqual({
      slot: '2026-11-04T07:00:00.000Z',
    });
    for (const bad of [
      {},
      null,
      { slot: 'tomorrow' },
      { slot: '2026-11-04T07:30:00.000Z' },
      { slot: '2026-11-04T07:00:00.000Z', organizationId: 'org_b' },
      { slot: '2026-11-04T07:00:00.000Z', branchIds: ['sop_2'] },
      { slot: '2026-11-04T07:00:00.000Z', pharmacyBranchId: 'pb_1' },
      { slot: '2026-11-04T07:00:00.000Z', now: '2026-11-05T00:00:00.000Z' },
    ]) {
      expect(() => parsePharmacySopAutoGeneratePayload(bad)).toThrow();
    }
  });

  it('the child payload is strict: one slot-aligned slot and one pharmacy branch', () => {
    const good = { slot: '2026-11-04T07:00:00.000Z', pharmacyBranchId: 'pb_1' };
    expect(parsePharmacySopAutoGenerateBranchPayload(good)).toEqual(good);
    for (const bad of [
      {},
      null,
      { slot: '2026-11-04T07:00:00.000Z' },
      { pharmacyBranchId: 'pb_1' },
      { ...good, slot: '2026-11-04T07:30:00.000Z' },
      { ...good, pharmacyBranchId: '' },
      { ...good, pharmacyBranchId: 'pb 1' },
      { ...good, pharmacyBranchId: 'pb:1' },
      { ...good, pharmacyBranchId: 7 },
      { ...good, organizationId: 'org_b' },
      { ...good, sopBranchId: 'sop_2' },
      { ...good, now: '2026-11-05T00:00:00.000Z' },
    ]) {
      expect(() => parsePharmacySopAutoGenerateBranchPayload(bad)).toThrow();
    }
  });

  it('the child key names the branch and the floored slot, and fails closed', () => {
    expect(PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB).toBe('pharmacy.sop.autoGenerateBranch');
    expect(pharmacySopAutoGenerateBranchJobKey('pb_1', at('2026-11-04T07:42:00Z'))).toBe(
      'pharmacy.sop.autoGenerateBranch:pb_1:2026-11-04T07:00:00.000Z'
    );
    for (const bad of ['', 'pb 1', 'pb:1', undefined, null, 7]) {
      expect(() =>
        pharmacySopAutoGenerateBranchJobKey(bad as unknown as string, at('2026-11-04T07:00:00Z'))
      ).toThrow(TypeError);
    }
  });

  it('a bad payload fails either job before any work', async () => {
    const { db, jobs } = makeDb({
      sites: SITES,
      settings: [setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z')],
    });
    await expect(
      pharmacySopAutoGenerateHandler({
        db,
        job: claimed('2026-11-04T07:00:00.000Z', '2026-11-04T07:00:05Z', { slot: 'x', extra: 1 }),
      })
    ).rejects.toThrow();
    await expect(
      pharmacySopAutoGenerateBranchHandler({
        db,
        job: claimed(
          '2026-11-04T07:00:00.000Z',
          '2026-11-04T07:00:05Z',
          { slot: '2026-11-04T07:00:00.000Z', pharmacyBranchId: 'pb_1', branchIds: ['sop_2'] },
          PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB
        ),
      })
    ).rejects.toThrow();
    expect(engine.generateDueSopOccurrences).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });
});

const SLOT_07 = '2026-11-04T07:00:00.000Z';
const parentJob = (startedAt = '2026-11-04T07:00:05Z') => claimed(SLOT_07, startedAt);
const childJob = (pharmacyBranchId: string, startedAt = '2026-11-04T07:00:06Z') =>
  claimed(
    SLOT_07,
    startedAt,
    { slot: SLOT_07, pharmacyBranchId },
    PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB
  );

describe('pharmacySopAutoGenerateHandler (the hourly parent)', () => {
  it('ensures exactly the next slot and one child per ON branch, on its own db only', async () => {
    const { db, raw, jobs } = makeDb({
      sites: [...SITES, { pharmacyBranchId: 'pb_3', sopBranchId: 'sop_3' }],
      settings: [
        setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z'),
        setting('s2', 'pb_2', true, '2026-11-01T00:00:00Z'),
        setting('s3', 'pb_2', false, '2026-11-02T00:00:00Z'),
        setting('s4', 'pb_3', true, '2026-11-03T00:00:00Z'),
      ],
    });
    const job = parentJob();
    await pharmacySopAutoGenerateHandler({ db, job });
    expect(jobs).toEqual([
      expect.objectContaining({
        type: PHARMACY_SOP_AUTO_GENERATE_JOB,
        payload: { slot: '2026-11-04T08:00:00.000Z' },
        idempotencyKey: 'pharmacy.sop.autoGenerate:2026-11-04T08:00:00.000Z',
        scheduledAt: at('2026-11-04T08:00:00Z'),
      }),
      ...['pb_1', 'pb_3'].map((pharmacyBranchId) =>
        expect.objectContaining({
          type: PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB,
          payload: { slot: SLOT_07, pharmacyBranchId },
          idempotencyKey: `pharmacy.sop.autoGenerateBranch:${pharmacyBranchId}:${SLOT_07}`,
          // Due at the claim instant: the same drain picks them up.
          scheduledAt: job.startedAt,
          nextAttemptAt: job.startedAt,
          status: 'QUEUED',
        })
      ),
    ]);
    // Nothing heavy in the parent: it never generates.
    expect(engine.generateDueSopOccurrences).not.toHaveBeenCalled();
    // The slot lock is taken on the handler's own transaction.
    expect(firstQuery(raw)).toMatchObject({
      values: ['pharmacy.sop.autoGenerate:org_a:2026-11-04T08:00:00.000Z'],
    });
  });

  it('reads the settings, then ensures the next slot, then enqueues the children', async () => {
    const { db, raw } = makeDb({
      sites: SITES,
      settings: [setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z')],
    });
    await pharmacySopAutoGenerateHandler({ db, job: parentJob() });
    const read = raw.pharmacySopSiteSetting.findMany.mock.invocationCallOrder[0]!;
    const [ensured, child] = raw.restaurantJob.create.mock.invocationCallOrder;
    expect(read).toBeLessThan(ensured!);
    expect(ensured!).toBeLessThan(child!);
    expect(raw.restaurantJob.create.mock.calls.map(([arg]) => arg.data.type)).toEqual([
      PHARMACY_SOP_AUTO_GENERATE_JOB,
      PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB,
    ]);
  });

  it('a failing enqueue fails the parent (its writes roll back with it and it is retried)', async () => {
    const { db, raw } = makeDb({
      sites: SITES,
      settings: [setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z')],
    });
    raw.$queryRaw.mockRejectedValueOnce(new Error('lock timeout'));
    await expect(pharmacySopAutoGenerateHandler({ db, job: parentJob() })).rejects.toThrow(
      'lock timeout'
    );
    expect(raw.restaurantJob.create).not.toHaveBeenCalled();
  });

  it('is safe to run twice for the same slot: no second next slot or child', async () => {
    const { db, jobs } = makeDb({
      sites: SITES,
      settings: [
        setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z'),
        setting('s2', 'pb_2', true, '2026-11-01T00:00:00Z'),
      ],
    });
    await pharmacySopAutoGenerateHandler({ db, job: parentJob() });
    await pharmacySopAutoGenerateHandler({
      db,
      job: { ...parentJob('2026-11-04T07:10:00Z'), attempts: 2 },
    });
    expect(jobs.map((row) => row.idempotencyKey)).toEqual([
      'pharmacy.sop.autoGenerate:2026-11-04T08:00:00.000Z',
      `pharmacy.sop.autoGenerateBranch:pb_1:${SLOT_07}`,
      `pharmacy.sop.autoGenerateBranch:pb_2:${SLOT_07}`,
    ]);
  });

  it('a late worker schedules the slot after now, not every missed hour', async () => {
    const { db, jobs } = makeDb({
      sites: SITES,
      settings: [setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z')],
    });
    await pharmacySopAutoGenerateHandler({ db, job: parentJob('2026-11-05T13:17:00Z') });
    expect(jobs.map((row) => row.idempotencyKey)).toEqual([
      'pharmacy.sop.autoGenerate:2026-11-05T14:00:00.000Z',
      // The child keeps this job's own slot.
      `pharmacy.sop.autoGenerateBranch:pb_1:${SLOT_07}`,
    ]);
  });

  it('stops the chain when no branch is ON: nothing is enqueued', async () => {
    const { db, raw, jobs } = makeDb({
      sites: SITES,
      settings: [
        setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z'),
        setting('s2', 'pb_1', false, '2026-11-04T06:40:00Z'),
      ],
    });
    await pharmacySopAutoGenerateHandler({ db, job: parentJob() });
    expect(raw.$transaction).not.toHaveBeenCalled();
    expect(raw.$queryRaw).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });

  it('stops the chain for a branch that was never turned on (the default)', async () => {
    const { db, jobs } = makeDb({ sites: SITES });
    await pharmacySopAutoGenerateHandler({ db, job: parentJob() });
    expect(jobs).toHaveLength(0);
  });

  it('ignores an ON setting on an inactive pharmacy branch', async () => {
    const { db, jobs } = makeDb({
      sites: [{ pharmacyBranchId: 'pb_1', sopBranchId: 'sop_1', active: false }],
      settings: [setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z')],
    });
    await pharmacySopAutoGenerateHandler({ db, job: parentJob() });
    expect(jobs).toHaveLength(0);
  });

  it('is a no-op in an organization with no pharmacy SOP site (a restaurant)', async () => {
    const { db, raw, jobs } = makeDb({ sites: [] });
    await pharmacySopAutoGenerateHandler({ db, job: parentJob() });
    expect(raw.pharmacySopSiteSetting.findMany).not.toHaveBeenCalled();
    expect(raw.restaurantJob.findFirst).not.toHaveBeenCalled();
    expect(raw.$transaction).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });

  it('creates no escalation and enqueues only its own two job types', async () => {
    const { db, raw, jobs } = makeDb({
      sites: SITES,
      settings: [setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z')],
    });
    await pharmacySopAutoGenerateHandler({ db, job: parentJob() });
    expect(raw.restaurantSopEscalationPolicy.create).not.toHaveBeenCalled();
    expect(raw.restaurantSopEscalationPolicy.upsert).not.toHaveBeenCalled();
    expect(new Set(jobs.map((row) => row.type))).toEqual(
      new Set([PHARMACY_SOP_AUTO_GENERATE_JOB, PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB])
    );
  });
});

describe('pharmacySopAutoGenerateBranchHandler (one branch)', () => {
  it('generates that branch only, on its own db, as of the claim instant, never back-dated', async () => {
    const { db, jobs } = makeDb({
      sites: SITES,
      settings: [
        setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z'),
        setting('s2', 'pb_2', true, '2026-11-01T00:00:00Z'),
      ],
    });
    const job = childJob('pb_2');
    await pharmacySopAutoGenerateBranchHandler({ db, job });
    // Nothing due before a schedule existed, or before the branch turned ON.
    expect(engine.generateDueSopOccurrences).toHaveBeenCalledExactlyOnceWith(db, {
      now: job.startedAt,
      branchIds: ['sop_2'],
      lookbackDays: 0,
      skipDueBeforeAssignmentCreated: true,
      skipDueBefore: new Date('2026-11-01T00:00:00Z'),
    });
    // A child never enqueues anything.
    expect(jobs).toHaveLength(0);
  });

  it('a branch turned OFF since the parent ran: succeeds without generating', async () => {
    const { db } = makeDb({
      sites: SITES,
      settings: [
        setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z'),
        setting('s2', 'pb_1', false, '2026-11-04T07:00:01Z'),
      ],
    });
    await expect(
      pharmacySopAutoGenerateBranchHandler({ db, job: childJob('pb_1') })
    ).resolves.toBeUndefined();
    expect(engine.generateDueSopOccurrences).not.toHaveBeenCalled();
  });

  it('a missing (or other-organization) or inactive site: succeeds without generating', async () => {
    const { db } = makeDb({
      sites: [{ pharmacyBranchId: 'pb_2', sopBranchId: 'sop_2', active: false }],
      settings: [
        setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z'),
        setting('s2', 'pb_2', true, '2026-11-01T00:00:00Z'),
      ],
    });
    await pharmacySopAutoGenerateBranchHandler({ db, job: childJob('pb_1') });
    await pharmacySopAutoGenerateBranchHandler({ db, job: childJob('pb_2') });
    expect(engine.generateDueSopOccurrences).not.toHaveBeenCalled();
  });

  it('a failing generation fails the child (its branch alone is retried)', async () => {
    const { db, jobs } = makeDb({
      sites: SITES,
      settings: [setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z')],
    });
    engine.generateDueSopOccurrences.mockRejectedValueOnce(new Error('statement timeout'));
    await expect(
      pharmacySopAutoGenerateBranchHandler({ db, job: childJob('pb_1') })
    ).rejects.toThrow('statement timeout');
    expect(jobs).toHaveLength(0);
    // The retry runs the same branch again.
    await pharmacySopAutoGenerateBranchHandler({ db, job: { ...childJob('pb_1'), attempts: 2 } });
    expect(engine.generateDueSopOccurrences).toHaveBeenCalledTimes(2);
  });
});
