/**
 * DEV-751 — pharmacy SOP scheduling is opt-in, branch-scoped and assumes no
 * time of day. Runs the real `pharmacySop` router (real tRPC middleware and
 * module gate) against an in-memory db; the adapter and the engine generator
 * are mocked, and the per-branch setting is stored in a mocked append-only
 * `pharmacySopSiteSetting` table.
 *
 * Pins:
 * - "Create today's work now" (`generate`) and `startOnDemand` hand the engine
 *   only this site's engine branch, never the whole tenant;
 * - automatic scheduling is OFF until a manager turns it on, per branch,
 *   through a gated, branch-scoped, strict and audited mutation;
 * - a schedule needs explicit times (no server-side default) and creates no
 *   escalation policy; nothing in pharmacy SOP code creates one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  granted: new Set<string>(),
  annotateAudit: vi.fn(),
  adapter: {
    resolvePharmacySopSite: vi.fn(),
    resolvePharmacySopActor: vi.fn(),
    ensurePharmacySopJobRoles: vi.fn(),
    pharmacySopRolesAt: vi.fn(),
  },
  engine: {
    createAssignment: vi.fn(),
    setAssignmentActive: vi.fn(),
    generateDueSopOccurrences: vi.fn(),
  },
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
vi.mock('@/lib/restaurant/sop-templates', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/sop-templates')>(
    '@/lib/restaurant/sop-templates'
  )),
  createAssignment: mocks.engine.createAssignment,
  setAssignmentActive: mocks.engine.setAssignmentActive,
}));
vi.mock('@/lib/restaurant/sop-occurrence-generation', () => ({
  generateDueSopOccurrences: mocks.engine.generateDueSopOccurrences,
}));

import { router } from '../trpc';
import { pharmacySopRouter } from './pharmacy-sop';
import { PharmacySopAccessError } from '@/lib/pharmacy/sop-adapter';
import { findPharmacySopPack } from '@/lib/pharmacy/sop-library';
import {
  generateAutoPharmacySopBranchOccurrences,
  pharmacySopAutoScheduledBranchIds,
} from '@/lib/pharmacy/sop-settings';

process.env.AUTH_SECRET = 'pharmacy-sop-schedules-test-secret';

const app = router({ pharmacySop: pharmacySopRouter });

const SITE = {
  pharmacyBranchId: 'pbranch_1',
  sopBranchId: 'sopbranch_1',
  timezone: 'Asia/Karachi',
  businessDayCutoff: '00:00',
};
const ACTOR = { staffProfileId: 'staff_me', displayName: 'Me', userId: 'user_1' };
const BRANCH_INPUT = { pharmacyBranchId: SITE.pharmacyBranchId };
const opening = findPharmacySopPack('opening')!;
const temperatureLog = findPharmacySopPack('temperature-log')!;
const receiving = findPharmacySopPack('receiving')!;

type SettingRow = {
  id: string;
  pharmacyBranchId: string;
  autoScheduleEnabled: boolean;
  changedByUserId: string;
  reason: string | null;
  createdAt: Date;
};

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

function makeDb() {
  const newestFirst = (a: SettingRow, b: SettingRow) =>
    b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
  const db = {
    restaurantSopOccurrence: model(),
    restaurantSopTemplate: model(),
    restaurantSopAssignment: model(),
    restaurantSopEscalationPolicy: model(),
    restaurantSopEscalationStep: model(),
    restaurantJob: model(),
    pharmacyBranchAssignment: model(),
    pharmacySopSite: model(),
    pharmacySopSiteSetting: {
      ...model(),
      findFirst: vi.fn(async ({ where }: { where: { pharmacyBranchId: string } }) => {
        const rows = settingRows.filter((row) => row.pharmacyBranchId === where.pharmacyBranchId);
        return rows.sort(newestFirst)[0] ?? null;
      }),
      findMany: vi.fn(async ({ where }: { where: { pharmacyBranchId: { in: string[] } } }) =>
        settingRows
          .filter((row) => where.pharmacyBranchId.in.includes(row.pharmacyBranchId))
          .sort(newestFirst)
      ),
      create: vi.fn(async ({ data }: { data: Omit<SettingRow, 'id' | 'createdAt'> }) => {
        const row: SettingRow = {
          ...data,
          id: `set_${settingRows.length + 1}`,
          createdAt: new Date(Date.parse('2026-11-04T09:00:00Z') + settingRows.length * 1000),
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

type Refusal = { code: string; message: string };
const noRefusal = (): Refusal => ({ code: 'RESOLVED', message: '' });
const asRefusal = (err: unknown): Refusal => err as Refusal;

function audited(action: string) {
  return mocks.annotateAudit.mock.calls
    .map(([, detail]) => detail as { action: string; metadata?: Record<string, unknown> })
    .filter((detail) => detail.action === action);
}

function noEscalationWrites() {
  for (const delegate of [db.restaurantSopEscalationPolicy, db.restaurantSopEscalationStep]) {
    expect(delegate.create).not.toHaveBeenCalled();
    expect(delegate.createMany).not.toHaveBeenCalled();
    expect(delegate.upsert).not.toHaveBeenCalled();
  }
  expect(db.restaurantJob.create).not.toHaveBeenCalled();
  expect(db.restaurantJob.createMany).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  settingRows = [];
  db = makeDb();
  mocks.granted = new Set(['sop:manage', 'sop:complete', 'sop:verify']);
  mocks.adapter.resolvePharmacySopSite.mockResolvedValue(SITE);
  mocks.adapter.resolvePharmacySopActor.mockResolvedValue(ACTOR);
  mocks.adapter.pharmacySopRolesAt.mockResolvedValue(['pharmacy-assistant']);
  mocks.adapter.ensurePharmacySopJobRoles.mockResolvedValue({
    'pharmacy-manager': 'role_mgr',
    'pharmacy-qualified-person': 'role_qp',
    'pharmacy-assistant': 'role_asst',
  });
  mocks.engine.createAssignment.mockResolvedValue({ id: 'asg_new' });
  mocks.engine.generateDueSopOccurrences.mockResolvedValue({
    assignmentsProcessed: 1,
    created: 1,
    skipped: 0,
  });
});

// ── Manual generation is branch-scoped ───────────────────────────────────────

describe('generate ("Create today\'s work now")', () => {
  it('hands the engine only this site’s engine branch', async () => {
    await caller().generate(BRANCH_INPUT);
    expect(mocks.engine.generateDueSopOccurrences).toHaveBeenCalledTimes(1);
    // A schedule created today starts at its next due time (never overdue on day one).
    expect(mocks.engine.generateDueSopOccurrences).toHaveBeenCalledWith(db, {
      branchIds: [SITE.sopBranchId],
      skipDueBeforeAssignmentCreated: true,
    });
    expect(audited('pharmacy.sop.generate')).toHaveLength(1);
  });

  it('stays available while automatic scheduling is off (the default)', async () => {
    expect(settingRows).toHaveLength(0);
    await expect(caller().generate(BRANCH_INPUT)).resolves.toMatchObject({ created: 1 });
  });

  it('touches nothing for a branch outside the caller’s scope', async () => {
    mocks.adapter.resolvePharmacySopSite.mockRejectedValueOnce(
      new PharmacySopAccessError('pbranch_2 is not yours', 'BRANCH_OUT_OF_SCOPE')
    );
    await expect(caller().generate({ pharmacyBranchId: 'pbranch_2' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.engine.generateDueSopOccurrences).not.toHaveBeenCalled();
  });
});

describe('startOnDemand', () => {
  it('generates the one-off run for this site’s engine branch only', async () => {
    expect(receiving.pharmacy.trigger).toBe('EVENT');
    db.restaurantSopTemplate.findUnique.mockResolvedValue({
      id: 'tpl_recv',
      name: receiving.name,
      isActive: true,
    });
    db.restaurantSopOccurrence.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'occ_new' });
    await expect(
      caller().startOnDemand({ ...BRANCH_INPUT, templateId: 'tpl_recv' })
    ).resolves.toEqual({ occurrenceId: 'occ_new', created: true });
    // Only the new one-off assignment: never the branch's other schedules.
    expect(mocks.engine.generateDueSopOccurrences).toHaveBeenCalledExactlyOnceWith(db, {
      now: expect.any(Date),
      branchIds: [SITE.sopBranchId],
      assignmentIds: ['asg_new'],
      skipDueBeforeAssignmentCreated: true,
    });
    noEscalationWrites();
  });
});

// ── Automatic scheduling setting ─────────────────────────────────────────────

describe('siteSettings', () => {
  it('is OFF for a branch nobody has changed', async () => {
    await expect(caller().siteSettings(BRANCH_INPUT)).resolves.toEqual({
      pharmacyBranchId: SITE.pharmacyBranchId,
      autoScheduleEnabled: false,
      changedAt: null,
      reason: null,
    });
  });

  it('needs sop:manage', async () => {
    mocks.granted = new Set(['sop:complete', 'sop:verify']);
    await expect(caller().siteSettings(BRANCH_INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('is branch-scoped through the adapter', async () => {
    await caller().siteSettings(BRANCH_INPUT);
    expect(mocks.adapter.resolvePharmacySopSite).toHaveBeenCalledWith(db, {
      organizationId: 'org_1',
      userId: 'user_1',
      pharmacyBranchId: SITE.pharmacyBranchId,
    });
    mocks.adapter.resolvePharmacySopSite.mockRejectedValueOnce(
      new PharmacySopAccessError('pbranch_2 is not yours', 'BRANCH_OUT_OF_SCOPE')
    );
    const refusal = await caller()
      .siteSettings({ pharmacyBranchId: 'pbranch_2' })
      .catch((err: unknown) => err as Error);
    expect(refusal).toMatchObject({ code: 'FORBIDDEN' });
    expect(String((refusal as Error).message)).not.toContain('pbranch_2');
  });

  it('rejects unknown input keys', async () => {
    await expect(
      caller().siteSettings({ ...BRANCH_INPUT, organizationId: 'org_2' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('setAutoSchedule', () => {
  it('needs sop:manage and writes nothing without it', async () => {
    mocks.granted = new Set(['sop:complete', 'sop:verify']);
    await expect(
      caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacySopSiteSetting.create).not.toHaveBeenCalled();
  });

  it('refuses a branch outside the caller’s scope before any write', async () => {
    mocks.adapter.resolvePharmacySopSite.mockRejectedValueOnce(
      new PharmacySopAccessError('pbranch_2 is not yours', 'BRANCH_OUT_OF_SCOPE')
    );
    await expect(
      caller().setAutoSchedule({ pharmacyBranchId: 'pbranch_2', enabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacySopSiteSetting.create).not.toHaveBeenCalled();
    expect(audited('pharmacy.sop.setAutoSchedule')).toHaveLength(0);
  });

  it('is strict: no actor, user, organization or extra key in the input', async () => {
    for (const extra of [
      { changedByUserId: 'user_2' },
      { userId: 'user_2' },
      { organizationId: 'org_2' },
      { sopBranchId: 'sopbranch_2' },
    ]) {
      await expect(
        caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: true, ...extra } as never)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(
      caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: 'yes' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: true, reason: 'x'.repeat(501) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacySopSiteSetting.create).not.toHaveBeenCalled();
  });

  it('appends one row for the session user, audits it, and is idempotent', async () => {
    await expect(
      caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: true, reason: 'Team agreed' })
    ).resolves.toMatchObject({ autoScheduleEnabled: true, changed: true, reason: 'Team agreed' });
    expect(db.pharmacySopSiteSetting.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          pharmacyBranchId: SITE.pharmacyBranchId,
          autoScheduleEnabled: true,
          changedByUserId: 'user_1',
          reason: 'Team agreed',
        },
      })
    );
    expect(audited('pharmacy.sop.setAutoSchedule')).toEqual([
      expect.objectContaining({
        targetType: 'PharmacySopSite',
        targetId: SITE.pharmacyBranchId,
        metadata: expect.objectContaining({
          pharmacyBranchId: SITE.pharmacyBranchId,
          enabled: true,
          changed: true,
        }),
      }),
    ]);
    await expect(caller().siteSettings(BRANCH_INPUT)).resolves.toMatchObject({
      autoScheduleEnabled: true,
    });

    // Same value again: no new row, still audited as an unchanged request.
    await expect(
      caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: true })
    ).resolves.toMatchObject({ changed: false });
    expect(db.pharmacySopSiteSetting.create).toHaveBeenCalledTimes(1);
    expect(audited('pharmacy.sop.setAutoSchedule').at(-1)).toMatchObject({
      metadata: expect.objectContaining({ changed: false }),
    });
  });

  it('turning it off changes only the setting: no generation, escalation or job', async () => {
    // Turning it ON starts the hourly job: see pharmacy-sop.auto-schedule.test.ts.
    await caller().setAutoSchedule({ ...BRANCH_INPUT, enabled: false });
    expect(mocks.engine.generateDueSopOccurrences).not.toHaveBeenCalled();
    noEscalationWrites();
  });
});

// ── Automatic generation ─────────────────────────────────────────────────────

describe('automatic generation after setAutoSchedule', () => {
  it('reaches the engine only for a branch whose latest setting is ON', async () => {
    const sites = [
      { pharmacyBranchId: 'pbranch_1', sopBranchId: 'sopbranch_1' },
      { pharmacyBranchId: 'pbranch_2', sopBranchId: 'sopbranch_2' },
    ];
    db.pharmacySopSite.findMany.mockResolvedValue(sites);
    db.pharmacySopSite.findFirst.mockImplementation(
      async ({ where }: { where: { pharmacyBranchId: string } }) =>
        sites.find((site) => site.pharmacyBranchId === where.pharmacyBranchId) ?? null
    );
    const now = new Date('2026-11-04T06:00:00Z');
    expect(await pharmacySopAutoScheduledBranchIds(db as never)).toEqual([]);
    expect(
      await generateAutoPharmacySopBranchOccurrences(db as never, {
        pharmacyBranchId: 'pbranch_2',
        now,
      })
    ).toBeNull();
    expect(mocks.engine.generateDueSopOccurrences).not.toHaveBeenCalled();

    mocks.adapter.resolvePharmacySopSite.mockResolvedValueOnce({
      ...SITE,
      pharmacyBranchId: 'pbranch_2',
      sopBranchId: 'sopbranch_2',
    });
    await caller().setAutoSchedule({ pharmacyBranchId: 'pbranch_2', enabled: true });
    // Turning it ON also starts the hourly job and creates that branch's work now
    // (pharmacy-sop.auto-schedule.test.ts); only the automatic pass is pinned here.
    mocks.engine.generateDueSopOccurrences.mockClear();
    db.restaurantJob.create.mockClear();
    expect(await pharmacySopAutoScheduledBranchIds(db as never)).toEqual(['pbranch_2']);
    await generateAutoPharmacySopBranchOccurrences(db as never, {
      pharmacyBranchId: 'pbranch_2',
      now,
    });
    expect(mocks.engine.generateDueSopOccurrences).toHaveBeenCalledExactlyOnceWith(db, {
      now,
      branchIds: ['sopbranch_2'],
      lookbackDays: 0,
      skipDueBeforeAssignmentCreated: true,
      skipDueBefore: expect.any(Date),
    });
    noEscalationWrites();
  });
});

// ── Schedules need explicit times and create no escalation ───────────────────

describe('createAssignment times', () => {
  const base = {
    ...BRANCH_INPUT,
    templateId: 'tpl_open',
    target: { type: 'ROLE' as const, roleKey: 'pharmacy-qualified-person' as const },
    startDate: '2026-11-04',
  };

  beforeEach(() => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({
      id: 'tpl_open',
      name: opening.name,
      isActive: true,
    });
  });

  it.each(['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY'] as const)(
    'refuses a %s schedule with no due time, with a plain message',
    async (frequency) => {
      const extra =
        frequency === 'WEEKLY'
          ? { daysOfWeek: [1] }
          : frequency === 'MONTHLY'
            ? { monthDay: 1 }
            : {};
      for (const dueTimeMinutes of [undefined, null]) {
        const refusal = await caller()
          .createAssignment({ ...base, frequency, ...extra, dueTimeMinutes })
          .then(noRefusal, asRefusal);
        expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
        expect(refusal.message).toContain('Choose the time this procedure is due.');
      }
      expect(mocks.engine.createAssignment).not.toHaveBeenCalled();
    }
  );

  it('refuses a repeating schedule with no first or last time', async () => {
    db.restaurantSopTemplate.findUnique.mockResolvedValue({
      id: 'tpl_temp',
      name: temperatureLog.name,
      isActive: true,
    });
    const interval = {
      ...base,
      templateId: 'tpl_temp',
      target: { type: 'ROLE' as const, roleKey: 'pharmacy-assistant' as const },
      frequency: 'INTERVAL' as const,
      interval: 240,
      daysOfWeek: [1, 2, 3],
    };
    const noStart = await caller()
      .createAssignment({ ...interval, intervalEndTimeMinutes: 17 * 60 })
      .then(noRefusal, asRefusal);
    expect(noStart).toMatchObject({ code: 'BAD_REQUEST' });
    expect(noStart.message).toContain('Choose the time the first check is due.');

    const noEnd = await caller()
      .createAssignment({ ...interval, dueTimeMinutes: 9 * 60 })
      .then(noRefusal, asRefusal);
    expect(noEnd).toMatchObject({ code: 'BAD_REQUEST' });
    expect(noEnd.message).toContain('Choose the time the last check is due.');
    expect(mocks.engine.createAssignment).not.toHaveBeenCalled();

    await caller().createAssignment({
      ...interval,
      dueTimeMinutes: 9 * 60,
      intervalEndTimeMinutes: 17 * 60,
    });
    expect(mocks.engine.createAssignment).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        frequency: 'INTERVAL',
        dueTimeMinutes: 540,
        intervalEndTimeMinutes: 1020,
      })
    );
  });

  it('passes the chosen time through unchanged and creates no escalation policy', async () => {
    await caller().createAssignment({
      ...base,
      frequency: 'DAILY',
      dueTimeMinutes: 7 * 60 + 45,
      intervalEndTimeMinutes: 20 * 60,
    });
    expect(mocks.engine.createAssignment).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        branchId: SITE.sopBranchId,
        frequency: 'DAILY',
        dueTimeMinutes: 465,
        // Only a repeating schedule has an end time; nothing else carries one.
        intervalEndTimeMinutes: null,
      })
    );
    noEscalationWrites();
    expect(mocks.engine.generateDueSopOccurrences).not.toHaveBeenCalled();
  });
});

describe('no default escalation', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
  const PHARMACY_SOP_SOURCES = [
    'src/server/routers/pharmacy-sop.ts',
    'src/lib/pharmacy/sop-adapter.ts',
    'src/lib/pharmacy/sop-library.ts',
    'src/lib/pharmacy/sop-settings.ts',
    'src/lib/pharmacy/sop-shared.ts',
  ];

  it('pharmacy SOP code never creates an escalation policy or step', () => {
    for (const path of PHARMACY_SOP_SOURCES) {
      const source = read(path);
      expect(source, path).not.toMatch(/createEscalationPolicy|sop-escalation/);
      expect(source, path).not.toMatch(
        /restaurantSopEscalation(Policy|Step)\s*\.\s*(create|upsert)/
      );
    }
  });
});
