/**
 * DEV-751 — opt-in overdue escalation through the real `pharmacySop` router
 * (real tRPC middleware and module gate). The adapter is mocked; the shared
 * escalation model and the job queue are in-memory.
 *
 * Pins:
 * - OFF by default: the setting reads OFF and the board marks nothing escalated;
 * - ON (sop:manage, own branch) stores the shared BRANCH policy whose one step
 *   notifies the session's own staff profile, never one from input, and starts
 *   the sweep; it is audited;
 * - OFF deactivates it; the gates (capability, branch scope, strict input) hold.
 */
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
import { PHARMACY_SOP_ESCALATE_OVERDUE_JOB } from '@/lib/pharmacy/sop-overdue-escalation';

process.env.AUTH_SECRET = 'pharmacy-sop-escalation-test-secret';

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

type PolicyRow = {
  id: string;
  name: string;
  scope: string;
  branchId: string | null;
  active: boolean;
  stopOnAcknowledged: boolean;
  stopOnVerified: boolean;
  quietHoursStartMinutes: number | null;
  quietHoursEndMinutes: number | null;
  createdAt: Date;
  updatedAt: Date;
};
type StepRow = {
  id: string;
  policyId: string;
  stepOrder: number;
  delayMinutes: number;
  target: string;
  channel: string;
};

let policyRows: PolicyRow[];
let stepRows: StepRow[];

/** The shared escalation model, in memory. */
function withEscalationModel(target: ReturnType<typeof makeDb>) {
  const stepsOf = (policyId: string) =>
    stepRows.filter((row) => row.policyId === policyId).sort((a, b) => a.stepOrder - b.stepOrder);
  const shaped = (row: PolicyRow) => ({ ...row, steps: stepsOf(row.id) });
  target.restaurantSopEscalationPolicy.findFirst = vi.fn(
    async ({ where }: { where: { branchId: string; name: string; scope: string } }) => {
      const row = policyRows.find(
        (policy) =>
          policy.branchId === where.branchId &&
          policy.name === where.name &&
          policy.scope === where.scope
      );
      return row ? shaped(row) : null;
    }
  );
  target.restaurantSopEscalationPolicy.findUnique = vi.fn(
    async ({ where }: { where: { id: string } }) => {
      const row = policyRows.find((policy) => policy.id === where.id);
      return row ? shaped(row) : null;
    }
  );
  target.restaurantSopEscalationPolicy.create = vi.fn(
    async ({ data }: { data: Partial<PolicyRow> }) => {
      const row = {
        quietHoursStartMinutes: null,
        quietHoursEndMinutes: null,
        ...data,
        id: `pol_${policyRows.length + 1}`,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as PolicyRow;
      policyRows.push(row);
      return shaped(row);
    }
  );
  target.restaurantSopEscalationPolicy.update = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<PolicyRow> }) => {
      const row = policyRows.find((policy) => policy.id === where.id)!;
      Object.assign(row, data, { updatedAt: new Date() });
      return shaped(row);
    }
  );
  target.restaurantSopEscalationStep.upsert = vi.fn(
    async ({
      where,
      create,
      update,
    }: {
      where: { policyId_stepOrder: { policyId: string; stepOrder: number } };
      create: Omit<StepRow, 'id'>;
      update: Partial<StepRow>;
    }) => {
      const { policyId, stepOrder } = where.policyId_stepOrder;
      const existing = stepRows.find(
        (row) => row.policyId === policyId && row.stepOrder === stepOrder
      );
      if (existing) return Object.assign(existing, update);
      const row = { ...create, id: `step_${stepRows.length + 1}` };
      stepRows.push(row);
      return row;
    }
  );
  return target;
}

function audited() {
  return mocks.annotateAudit.mock.calls
    .map(([, detail]) => detail as { action: string; metadata?: Record<string, unknown> })
    .filter((detail) => detail.action === 'pharmacy.sop.setOverdueEscalation');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  settingRows = [];
  jobRows = [];
  policyRows = [];
  stepRows = [];
  db = withEscalationModel(makeDb());
  mocks.granted = new Set(['sop:manage', 'sop:complete', 'sop:verify']);
  mocks.adapter.resolvePharmacySopSite.mockResolvedValue(SITE);
  mocks.adapter.resolvePharmacySopActor.mockResolvedValue({
    staffProfileId: 'staff_manager',
    displayName: 'Manager',
    userId: 'user_1',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('overdue escalation is OFF by default', () => {
  it('reads OFF for a branch that never turned it on, and writes nothing', async () => {
    await expect(caller().overdueEscalation(BRANCH_INPUT)).resolves.toEqual({
      pharmacyBranchId: SITE.pharmacyBranchId,
      enabled: false,
      delayMinutes: 30,
      changedAt: null,
    });
    expect(db.restaurantSopEscalationPolicy.create).not.toHaveBeenCalled();
    expect(db.restaurantSopEscalationStep.upsert).not.toHaveBeenCalled();
    expect(jobRows).toEqual([]);
  });
});

describe('setOverdueEscalation', () => {
  it('ON notifies the session’s own staff profile through the shared policy, and is audited', async () => {
    await expect(
      caller().setOverdueEscalation({ ...BRANCH_INPUT, enabled: true, delayMinutes: 20 })
    ).resolves.toEqual({
      pharmacyBranchId: SITE.pharmacyBranchId,
      enabled: true,
      delayMinutes: 20,
      changedAt: NOW,
      changed: true,
      nextRunAt: new Date('2026-11-04T06:45:00.000Z'),
    });
    expect(mocks.adapter.resolvePharmacySopSite).toHaveBeenCalledWith(db, {
      organizationId: 'org_1',
      userId: 'user_1',
      pharmacyBranchId: SITE.pharmacyBranchId,
    });
    expect(policyRows).toEqual([
      expect.objectContaining({ scope: 'BRANCH', branchId: SITE.sopBranchId, active: true }),
    ]);
    expect(stepRows).toEqual([
      expect.objectContaining({
        stepOrder: 1,
        delayMinutes: 20,
        target: 'staff_manager',
        channel: 'IN_APP',
      }),
    ]);
    expect(jobRows).toEqual([
      expect.objectContaining({
        type: PHARMACY_SOP_ESCALATE_OVERDUE_JOB,
        scheduledAt: new Date('2026-11-04T06:45:00.000Z'),
      }),
    ]);
    expect(audited().at(-1)).toMatchObject({
      targetId: SITE.pharmacyBranchId,
      metadata: expect.objectContaining({
        enabled: true,
        changed: true,
        delayMinutes: 20,
        notifyStaffProfileId: 'staff_manager',
      }),
    });
    await expect(caller().overdueEscalation(BRANCH_INPUT)).resolves.toMatchObject({
      enabled: true,
      delayMinutes: 20,
    });
  });

  it('OFF deactivates the policy and starts nothing', async () => {
    await caller().setOverdueEscalation({ ...BRANCH_INPUT, enabled: true });
    jobRows = [];
    await expect(
      caller().setOverdueEscalation({ ...BRANCH_INPUT, enabled: false })
    ).resolves.toMatchObject({ enabled: false, changed: true, nextRunAt: null });
    expect(policyRows).toEqual([expect.objectContaining({ active: false })]);
    expect(jobRows).toEqual([]);
    expect(audited().at(-1)).toMatchObject({
      metadata: expect.objectContaining({ enabled: false, changed: true }),
    });
  });

  it('rejects a staff id, an actor or another field in the input', async () => {
    for (const extra of [
      { targetStaffProfileId: 'staff_other' },
      { staffProfileId: 'staff_other' },
      { userId: 'user_2' },
    ]) {
      await expect(
        caller().setOverdueEscalation({ ...BRANCH_INPUT, enabled: true, ...extra } as never)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(policyRows).toEqual([]);
  });

  it('rejects a delay outside the bounds', async () => {
    for (const delayMinutes of [-1, 1441, 1.5]) {
      await expect(
        caller().setOverdueEscalation({ ...BRANCH_INPUT, enabled: true, delayMinutes })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(policyRows).toEqual([]);
  });

  it('requires sop:manage', async () => {
    mocks.granted = new Set(['sop:complete', 'sop:verify']);
    await expect(
      caller().setOverdueEscalation({ ...BRANCH_INPUT, enabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().overdueEscalation(BRANCH_INPUT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(policyRows).toEqual([]);
  });

  it('refuses a branch outside the session’s scope without writing', async () => {
    mocks.adapter.resolvePharmacySopSite.mockRejectedValue(
      new PharmacySopAccessError('pbranch_2 is not yours', 'BRANCH_OUT_OF_SCOPE')
    );
    await expect(
      caller().setOverdueEscalation({ ...BRANCH_INPUT, enabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(policyRows).toEqual([]);
    expect(jobRows).toEqual([]);
  });
});
