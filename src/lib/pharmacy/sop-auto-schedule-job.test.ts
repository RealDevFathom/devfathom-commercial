/**
 * DEV-751 — the hourly pharmacy SOP automatic-scheduling job. Runs the real
 * scheduler `enqueue` (idempotency-key dedupe, DUPLICATE_ENQUEUE race) and the
 * real `generateAutoPharmacySopOccurrences` over an in-memory org-scoped db;
 * only the engine generator is mocked. Pins: deterministic slot keys, strict
 * payload, re-enqueue only while a branch is ON, no job in an organization with
 * no SOP site (a restaurant), and idempotence when a slot runs twice.
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
  PHARMACY_SOP_AUTO_GENERATE_CADENCE_MS,
  PHARMACY_SOP_AUTO_GENERATE_JOB,
  ensurePharmacySopAutoScheduleJob,
  nextPharmacySopAutoGenerateSlot,
  parsePharmacySopAutoGeneratePayload,
  pharmacySopAutoGenerateHandler,
  pharmacySopAutoGenerateJobKey,
  pharmacySopAutoGenerateSlot,
  startPharmacySopAutoSchedule,
} from './sop-auto-schedule-job';

type JobRow = {
  id: string;
  type: string;
  payload: unknown;
  idempotencyKey: string | null;
  scheduledAt: Date;
  nextAttemptAt: Date;
  status: string;
};

type Site = { pharmacyBranchId: string; sopBranchId: string };
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
    pharmacySopSite: { findMany: vi.fn(async () => opts.sites ?? []) },
    pharmacySopSiteSetting: {
      findMany: vi.fn(async ({ where }: { where: { pharmacyBranchId: { in: string[] } } }) =>
        settings
          .filter((row) => where.pharmacyBranchId.in.includes(row.pharmacyBranchId))
          .sort(newestFirst)
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
const setting = (id: string, pharmacyBranchId: string, on: boolean, iso: string): Setting => ({
  id,
  pharmacyBranchId,
  autoScheduleEnabled: on,
  createdAt: at(iso),
});

function claimed(slot: string, startedAt: string, payload: unknown = { slot }): ClaimedJob {
  return {
    id: 'job_claimed',
    organizationId: 'org_a',
    type: PHARMACY_SOP_AUTO_GENERATE_JOB,
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

describe('ensurePharmacySopAutoScheduleJob', () => {
  it('enqueues the next slot, due at the slot, under a serializing lock', async () => {
    const { db, raw, jobs } = makeDb();
    const result = await ensurePharmacySopAutoScheduleJob(db, {
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
  });

  it('never creates a second job for the same slot (repeated toggles)', async () => {
    const { db, jobs } = makeDb();
    for (const iso of ['2026-11-04T06:01:00Z', '2026-11-04T06:20:00Z', '2026-11-04T06:59:00Z']) {
      await ensurePharmacySopAutoScheduleJob(db, { now: at(iso) });
    }
    expect(jobs).toHaveLength(1);
    const again = await ensurePharmacySopAutoScheduleJob(db, { now: at('2026-11-04T06:45:00Z') });
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
      now: at('2026-11-04T06:30:00Z'),
    });
    expect(result).toMatchObject({ deduplicated: true, job: { id: 'job_winner' } });
    expect(jobs).toHaveLength(1);
    expect(raw.restaurantJob.create).toHaveBeenCalledTimes(1);
  });
});

describe('startPharmacySopAutoSchedule', () => {
  it('ensures the chain, then generates for that branch only', async () => {
    const { db, jobs } = makeDb({ sites: SITES });
    const now = at('2026-11-04T06:30:00Z');
    const result = await startPharmacySopAutoSchedule(db, { sopBranchId: 'sop_1', now });
    expect(engine.generateDueSopOccurrences).toHaveBeenCalledExactlyOnceWith(db, {
      now,
      branchIds: ['sop_1'],
    });
    expect(result.generated.created).toBe(4);
    expect(jobs).toHaveLength(1);
    expect(result.job.slot.toISOString()).toBe('2026-11-04T07:00:00.000Z');
  });

  it('keeps the chain when creating today’s work fails', async () => {
    const { db, jobs } = makeDb({ sites: SITES });
    engine.generateDueSopOccurrences.mockRejectedValueOnce(new Error('engine down'));
    await expect(
      startPharmacySopAutoSchedule(db, { sopBranchId: 'sop_1', now: at('2026-11-04T06:30:00Z') })
    ).rejects.toThrow('engine down');
    expect(jobs).toHaveLength(1);
  });
});

describe('payload', () => {
  it('is strict and slot-aligned', () => {
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
      { slot: '2026-11-04T07:00:00.000Z', now: '2026-11-05T00:00:00.000Z' },
    ]) {
      expect(() => parsePharmacySopAutoGeneratePayload(bad)).toThrow();
    }
  });

  it('a bad payload fails the job before any work', async () => {
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
    expect(engine.generateDueSopOccurrences).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });
});

describe('pharmacySopAutoGenerateHandler', () => {
  it('generates for ON branches as of the claim instant and ensures exactly the next slot', async () => {
    const { db, jobs } = makeDb({
      sites: SITES,
      settings: [
        setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z'),
        setting('s2', 'pb_2', true, '2026-11-01T00:00:00Z'),
        setting('s3', 'pb_2', false, '2026-11-02T00:00:00Z'),
      ],
    });
    const job = claimed('2026-11-04T07:00:00.000Z', '2026-11-04T07:00:05Z');
    await pharmacySopAutoGenerateHandler({ db, job });
    expect(engine.generateDueSopOccurrences).toHaveBeenCalledExactlyOnceWith(db, {
      now: job.startedAt,
      branchIds: ['sop_1'],
    });
    expect(jobs.map((row) => row.idempotencyKey)).toEqual([
      'pharmacy.sop.autoGenerate:2026-11-04T08:00:00.000Z',
    ]);
  });

  it('is safe to run twice for the same slot', async () => {
    const { db, jobs } = makeDb({
      sites: SITES,
      settings: [setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z')],
    });
    const job = claimed('2026-11-04T07:00:00.000Z', '2026-11-04T07:00:05Z');
    await pharmacySopAutoGenerateHandler({ db, job });
    engine.generateDueSopOccurrences.mockResolvedValueOnce({
      assignmentsProcessed: 2,
      created: 0,
      skipped: 0,
    });
    await pharmacySopAutoGenerateHandler({ db, job: { ...job, attempts: 2 } });
    expect(jobs).toHaveLength(1);
  });

  it('a late worker schedules the slot after now, not every missed hour', async () => {
    const { db, jobs } = makeDb({
      sites: SITES,
      settings: [setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z')],
    });
    await pharmacySopAutoGenerateHandler({
      db,
      job: claimed('2026-11-04T07:00:00.000Z', '2026-11-05T13:17:00Z'),
    });
    expect(jobs.map((row) => row.idempotencyKey)).toEqual([
      'pharmacy.sop.autoGenerate:2026-11-05T14:00:00.000Z',
    ]);
  });

  it('stops the chain when no branch is ON', async () => {
    const { db, jobs } = makeDb({
      sites: SITES,
      settings: [
        setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z'),
        setting('s2', 'pb_1', false, '2026-11-04T06:40:00Z'),
      ],
    });
    await pharmacySopAutoGenerateHandler({
      db,
      job: claimed('2026-11-04T07:00:00.000Z', '2026-11-04T07:00:05Z'),
    });
    expect(engine.generateDueSopOccurrences).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });

  it('stops the chain for a branch that was never turned on (the default)', async () => {
    const { db, jobs } = makeDb({ sites: SITES });
    await pharmacySopAutoGenerateHandler({
      db,
      job: claimed('2026-11-04T07:00:00.000Z', '2026-11-04T07:00:05Z'),
    });
    expect(engine.generateDueSopOccurrences).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });

  it('is a no-op in an organization with no pharmacy SOP site (a restaurant)', async () => {
    const { db, raw, jobs } = makeDb({ sites: [] });
    await pharmacySopAutoGenerateHandler({
      db,
      job: claimed('2026-11-04T07:00:00.000Z', '2026-11-04T07:00:05Z'),
    });
    expect(raw.pharmacySopSiteSetting.findMany).not.toHaveBeenCalled();
    expect(engine.generateDueSopOccurrences).not.toHaveBeenCalled();
    expect(raw.restaurantJob.findFirst).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });

  it('creates no escalation and enqueues no other job type', async () => {
    const { db, raw, jobs } = makeDb({
      sites: SITES,
      settings: [setting('s1', 'pb_1', true, '2026-11-01T00:00:00Z')],
    });
    await pharmacySopAutoGenerateHandler({
      db,
      job: claimed('2026-11-04T07:00:00.000Z', '2026-11-04T07:00:05Z'),
    });
    expect(raw.restaurantSopEscalationPolicy.create).not.toHaveBeenCalled();
    expect(raw.restaurantSopEscalationPolicy.upsert).not.toHaveBeenCalled();
    expect(new Set(jobs.map((row) => row.type))).toEqual(new Set([PHARMACY_SOP_AUTO_GENERATE_JOB]));
  });
});
