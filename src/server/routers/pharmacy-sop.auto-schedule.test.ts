/**
 * DEV-751 — turning automatic scheduling on and off starts and stops real work.
 * Runs the real `pharmacySop` router (real tRPC middleware and module gate) and
 * the real scheduler `enqueue` against an in-memory db; the adapter and the
 * engine generator are mocked, the per-branch setting lives in a mocked
 * append-only `pharmacySopSiteSetting` table and jobs in a mocked
 * `restaurantJob` table with the scheduler's per-organization key dedupe.
 *
 * Pins:
 * - ON appends the setting, ensures exactly one hourly job for the next slot
 *   and creates this branch's due procedures now (engine branch-scoped);
 * - OFF appends the setting only: no generation and no new job;
 * - toggling repeatedly never creates a second job for a slot;
 * - the gates (sop:manage, branch scope, strict input) still hold, and nothing
 *   creates an escalation policy or step.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

const mocks = vi.hoisted(() => ({
  granted: new Set<string>(),
  annotateAudit: vi.fn(),
  adapter: {
    resolvePharmacySopSite: vi.fn(),
    resolvePharmacySopActor: vi.fn(),
  },
  engine: { generateDueSopOccurrences: vi.fn() },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: { enabledModules: string[] }, key: string) =>
    entitlements.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async (_subject, action: string) => mocks.granted.has(action)) };
});
vi.mock('@/lib/pharmacy/sop-adapter', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/sop-adapter')>(
    '@/lib/pharmacy/sop-adapter'
  )),
  ...mocks.adapter,
}));
vi.mock('@/lib/restaurant/sop-occurrence-generation', () => ({
  generateDueSopOccurrences: mocks.engine.generateDueSopOccurrences,
}));

import { router } from '../trpc';
import { pharmacySopRouter } from './pharmacy-sop';
import { PharmacySopAccessError } from '@/lib/pharmacy/sop-adapter';
import { PHARMACY_SOP_AUTO_GENERATE_JOB } from '@/lib/pharmacy/sop-auto-schedule-job';

process.env.AUTH_SECRET = 'pharmacy-sop-auto-schedule-test-secret';

const app = router({ pharmacySop: pharmacySopRouter });

const SITE = {
  pharmacyBranchId: 'pbranch_1',
  sopBranchId: 'sopbranch_1',
  timezone: 'Asia/Karachi',
  businessDayCutoff: '00:00',
};
const BRANCH_INPUT = { pharmacyBranchId: SITE.pharmacyBranchId };
const NOW = new Date('2026-11-04T06:30:00.000Z');

type SettingRow = {
  id: string;
  pharmacyBranchId: string;
  autoScheduleEnabled: boolean;
  changedByUserId: string;
  reason: string | null;
  createdAt: Date;
};
type JobRow = { id: string; type: string; idempotencyKey: string | null; scheduledAt: Date };
type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    createMany: vi.fn(),
    upsert: vi.fn(),
  };
}

let settingRows: SettingRow[];
let jobRows: JobRow[];

function makeDb() {
  const newestFirst = (a: SettingRow, b: SettingRow) =>
    b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
  const db = {
    restaurantSopEscalationPolicy: model(),
    restaurantSopEscalationStep: model(),
    pharmacySopSite: model(),
    restaurantJob: {
      ...model(),
      findFirst: vi.fn(
        async ({ where }: { where: { idempotencyKey: string } }) =>
          jobRows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Omit<JobRow, 'id'> }) => {
        if (jobRows.some((row) => row.idempotencyKey === data.idempotencyKey)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const row = { ...data, id: `job_${jobRows.length + 1}` };
        jobRows.push(row);
        return row;
      }),
    },
    pharmacySopSiteSetting: {
      ...model(),
      findFirst: vi.fn(async ({ where }: { where: { pharmacyBranchId: string } }) => {
        const rows = settingRows.filter((row) => row.pharmacyBranchId === where.pharmacyBranchId);
        return rows.sort(newestFirst)[0] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Omit<SettingRow, 'id' | 'createdAt'> }) => {
        const row: SettingRow = {
          ...data,
          id: `set_${settingRows.length + 1}`,
          createdAt: new Date(NOW.getTime() + settingRows.length * 1000),
        };
        settingRows.push(row);
        return row;
      }),
    },
  };
  const typed = db as unknown as Record<keyof typeof db, Delegate> & {
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  typed.$transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(typed));
  typed.$queryRaw = vi.fn().mockResolvedValue([]);
  return typed;
}

let db: ReturnType<typeof makeDb>;

function caller() {
  return app.createCaller({
    db: db as never,
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['pharmacy-core', 'pharmacy-safety'],
      modules: [],
      limits: {},
      activeSeats: 1,
      seatLimit: 10,
    },
    session: {
      expires: 'later',
      user: {
        id: 'user_1',
        organizationId: 'org_1',
        role: 'EMPLOYEE',
        department: 'OPERATIONS',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never).pharmacySop;
}

function audited() {
  return mocks.annotateAudit.mock.calls
    .map(([, detail]) => detail as { action: string; metadata?: Record<string, unknown> })
    .filter((detail) => detail.action === 'pharmacy.sop.setAutoSchedule');
}

function noEscalationWrites() {
  for (const delegate of [db.restaurantSopEscalationPolicy, db.restaurantSopEscalationStep]) {
    expect(delegate.create).not.toHaveBeenCalled();
    expect(delegate.createMany).not.toHaveBeenCalled();
    expect(delegate.upsert).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  settingRows = [];
  jobRows = [];
  db = makeDb();
  mocks.granted = new Set(['sop:manage', 'sop:complete', 'sop:verify']);
  mocks.adapter.resolvePharmacySopSite.mockResolvedValue(SITE);
  mocks.engine.generateDueSopOccurrences.mockResolvedValue({
    assignmentsProcessed: 2,
    created: 4,
    skipped: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('setAutoSchedule ON', () => {
  it('ensures the next hourly job and creates this branch’s due work now', async () => {
    await expect(caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: true })).resolves.toEqual({
      pharmacyBranchId: SITE.pharmacyBranchId,
      autoScheduleEnabled: true,
      changedAt: expect.any(Date),
      reason: null,
      changed: true,
      generated: 4,
      nextRunAt: new Date('2026-11-04T07:00:00.000Z'),
    });
    // From the current business date only: never back-dated to days it was OFF,
    // and nothing due before a schedule existed or before this switch ON.
    expect(mocks.engine.generateDueSopOccurrences).toHaveBeenCalledExactlyOnceWith(db, {
      now: NOW,
      branchIds: [SITE.sopBranchId],
      lookbackDays: 0,
      skipDueBeforeAssignmentCreated: true,
      skipDueBefore: settingRows[0]!.createdAt,
    });
    // The slot lock names the session's organization explicitly.
    expect(
      db.$queryRaw.mock.calls.map(([query]) => (query as { values: unknown[] }).values)
    ).toContainEqual(['pharmacy.sop.autoGenerate:org_1:2026-11-04T07:00:00.000Z']);
    expect(jobRows).toEqual([
      expect.objectContaining({
        type: PHARMACY_SOP_AUTO_GENERATE_JOB,
        idempotencyKey: 'pharmacy.sop.autoGenerate:2026-11-04T07:00:00.000Z',
        scheduledAt: new Date('2026-11-04T07:00:00.000Z'),
      }),
    ]);
    // The setting row is appended before any work.
    expect(db.pharmacySopSiteSetting.create.mock.invocationCallOrder[0]).toBeLessThan(
      db.restaurantJob.create.mock.invocationCallOrder[0]!
    );
    expect(audited().at(-1)).toMatchObject({
      metadata: expect.objectContaining({
        enabled: true,
        changed: true,
        generated: 4,
        nextRunAt: '2026-11-04T07:00:00.000Z',
      }),
    });
    noEscalationWrites();
  });

  it('toggling repeatedly never creates a second job for the slot', async () => {
    for (const enabled of [true, false, true, true, false, true]) {
      await caller().setAutoSchedule({ ...BRANCH_INPUT, enabled });
    }
    expect(jobRows).toHaveLength(1);
    expect(db.restaurantJob.create).toHaveBeenCalledTimes(1);
    // A new row per change only: on, off, on, off, on.
    expect(settingRows.map((row) => row.autoScheduleEnabled)).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
    // Every ON call (four) re-ensured the job and created this branch's work.
    expect(mocks.engine.generateDueSopOccurrences).toHaveBeenCalledTimes(4);
    // Each floored at the time of the ON row then in force (the latest switch ON).
    const onRows = settingRows.filter((row) => row.autoScheduleEnabled);
    const floors = [onRows[0], onRows[1], onRows[1], onRows[2]].map((row) => row!.createdAt);
    for (const [
      index,
      [, options],
    ] of mocks.engine.generateDueSopOccurrences.mock.calls.entries()) {
      expect(options).toEqual({
        now: NOW,
        branchIds: [SITE.sopBranchId],
        lookbackDays: 0,
        skipDueBeforeAssignmentCreated: true,
        skipDueBefore: floors[index],
      });
    }
  });

  // This context db commits each operation on its own. Over HTTP the route's
  // single request transaction rolls the setting and the job back with it.
  it('on a per-operation context db, keeps the job when creating today’s work fails', async () => {
    mocks.engine.generateDueSopOccurrences.mockRejectedValueOnce(new Error('engine down'));
    await expect(caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: true })).rejects.toThrow();
    expect(settingRows).toHaveLength(1);
    expect(jobRows).toHaveLength(1);
  });
});

describe('setAutoSchedule OFF', () => {
  it('appends the setting only: no generation and no new job', async () => {
    await caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: true });
    vi.clearAllMocks();
    await expect(
      caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: false, reason: 'Pause' })
    ).resolves.toMatchObject({
      autoScheduleEnabled: false,
      changed: true,
      generated: null,
      nextRunAt: null,
    });
    expect(mocks.engine.generateDueSopOccurrences).not.toHaveBeenCalled();
    expect(db.restaurantJob.create).not.toHaveBeenCalled();
    expect(db.restaurantJob.findFirst).not.toHaveBeenCalled();
    expect(settingRows.at(-1)).toMatchObject({ autoScheduleEnabled: false, reason: 'Pause' });
    noEscalationWrites();
  });

  it('by default (never turned on) nothing exists and OFF creates nothing', async () => {
    await expect(
      caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: false })
    ).resolves.toMatchObject({ changed: false, generated: null });
    expect(settingRows).toHaveLength(0);
    expect(jobRows).toHaveLength(0);
    expect(mocks.engine.generateDueSopOccurrences).not.toHaveBeenCalled();
  });
});

describe('gates still hold', () => {
  it('needs sop:manage and starts nothing without it', async () => {
    mocks.granted = new Set(['sop:complete', 'sop:verify']);
    await expect(
      caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacySopSiteSetting.create).not.toHaveBeenCalled();
    expect(jobRows).toHaveLength(0);
    expect(mocks.engine.generateDueSopOccurrences).not.toHaveBeenCalled();
  });

  it('refuses a branch outside the caller’s scope before any write or job', async () => {
    mocks.adapter.resolvePharmacySopSite.mockRejectedValueOnce(
      new PharmacySopAccessError('pbranch_2 is not yours', 'BRANCH_OUT_OF_SCOPE')
    );
    await expect(
      caller().setAutoSchedule({ pharmacyBranchId: 'pbranch_2', enabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacySopSiteSetting.create).not.toHaveBeenCalled();
    expect(jobRows).toHaveLength(0);
    expect(mocks.engine.generateDueSopOccurrences).not.toHaveBeenCalled();
  });

  it('is strict: no branch, slot, time or job detail can be passed in', async () => {
    for (const extra of [
      { sopBranchId: 'sopbranch_2' },
      { organizationId: 'org_2' },
      { now: '2026-12-01T00:00:00Z' },
      { slot: '2026-12-01T00:00:00Z' },
      { idempotencyKey: 'x' },
    ]) {
      await expect(
        caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: true, ...extra } as never)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(db.pharmacySopSiteSetting.create).not.toHaveBeenCalled();
    expect(jobRows).toHaveLength(0);
  });
});

describe('no escalation in the automatic-scheduling path', () => {
  it('the job module never creates an escalation or another job type', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/pharmacy/sop-auto-schedule-job.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/createEscalationPolicy|sop-escalation|sop-late-missed/);
    expect(source).not.toMatch(/restaurantSopEscalation(Policy|Step)\s*\.\s*(create|upsert)/);
    expect(source).not.toMatch(/SOP_(GENERATE_OCCURRENCES|ESCALATION|LATE_MISSED)_JOB/);
    // Two enqueue calls: the next slot and the per-branch child, of its own types.
    expect(source.match(/\benqueue\s*\(/g)).toHaveLength(2);
    expect(source).toMatch(/type: PHARMACY_SOP_AUTO_GENERATE_JOB,/);
    expect(source).toMatch(/type: PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB,/);
  });
});
