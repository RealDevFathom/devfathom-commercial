/**
 * M7-L3 router tests — capability-gated SOP authoring console. Runs the REAL
 * router against a hand-rolled in-memory db; ABAC, entitlements, and audit are
 * mocked. Covers: `sop.templates.max` from entitlements, publish-immutability
 * error mapping, strict-zod rejection of unknown keys, recurrence validation
 * mapping, and the DST-correct schedule preview.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  annotateAudit: vi.fn(),
  resolveStaffBranchAuthorization: vi.fn(async () => ({
    actorStaffProfileId: 'staff_1',
    organizationWide: false,
    branchIds: ['branch_1'],
  })),
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
vi.mock('@/lib/restaurant/staff-branch-authorization', () => ({
  resolveStaffBranchAuthorization: mocks.resolveStaffBranchAuthorization,
}));

import { restaurantSopRouter } from './restaurant-sop';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'generated_id',
      ...data,
    })),
    update: vi
      .fn()
      .mockImplementation(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: where.id,
          ...data,
        })
      ),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    delete: vi.fn().mockResolvedValue({}),
  };
}

function makeDb() {
  const db: Record<string, Delegate | unknown> = {
    restaurantSopTemplate: model(),
    restaurantSopTemplateVersion: model(),
    restaurantSopTemplateStep: model(),
    restaurantSopAssignment: model(),
    restaurantBranch: model(),
    // SOP-1: createAssignment now resolves an assignee target before persisting.
    restaurantJobRole: model(),
    restaurantStaffProfile: model(),
    restaurantSopOccurrence: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  (db as Record<string, unknown>).$transaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn(db)
  );
  return db as Record<string, Delegate> & { $transaction: ReturnType<typeof vi.fn> };
}

let db: ReturnType<typeof makeDb>;

beforeEach(() => {
  db = makeDb();
  mocks.can.mockResolvedValue(true);
  mocks.annotateAudit.mockReset();
});

describe('oversight occurrence directory', () => {
  it('lists only recent occurrences in the effective branch scope with human labels', async () => {
    db.restaurantSopOccurrence.findMany.mockResolvedValue([
      {
        id: 'occurrence_1',
        businessDate: new Date('2026-08-30T00:00:00Z'),
        status: 'SCHEDULED',
        branch: { name: 'Downtown' },
        templateVersion: { template: { name: 'Opening checklist' } },
      },
    ]);
    const result = await caller().listRecentOccurrences();
    expect(result[0]).toMatchObject({
      branch: { name: 'Downtown' },
      templateVersion: { template: { name: 'Opening checklist' } },
    });
    expect(db.restaurantSopOccurrence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { branchId: { in: ['branch_1'] } }, take: 100 })
    );
  });

  it('returns the same unavailable response for foreign and inaccessible occurrences', async () => {
    db.restaurantSopOccurrence.findFirst.mockResolvedValue(null);
    await expect(
      caller().occurrenceAuditTrail({ occurrenceId: 'arbitrary_value' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Occurrence unavailable.' });
  });
});

function caller(limits: Record<string, number> = { 'sop.templates.max': 25 }) {
  return restaurantSopRouter.createCaller({
    db: db as never,
    entitlements: {
      enabledModules: ['restaurant-sop'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits,
    },
    session: {
      expires: 'later',
      user: { id: 'user_1', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

describe('createTemplate — entitlement-driven sop.templates.max', () => {
  it('fails loudly when neither supported key is configured', async () => {
    await expect(caller({}).createTemplate({ name: 'Opening' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('sop.templates.max'),
    });
    expect(db.restaurantSopTemplate.create).not.toHaveBeenCalled();
  });

  it('uses the bootstrapped compatibility key', async () => {
    db.restaurantSopTemplate.count.mockResolvedValue(1);
    await expect(
      caller({ 'restaurant-core.sop.templates.max': 5 }).createTemplate({ name: 'Opening' })
    ).resolves.toMatchObject({ name: 'Opening' });
  });

  it('creates when under the cap and annotates the audit', async () => {
    db.restaurantSopTemplate.count.mockResolvedValue(1);
    const created = await caller({ 'sop.templates.max': 5 }).createTemplate({ name: 'Opening' });
    expect(created.name).toBe('Opening');
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetType: 'RestaurantSopTemplate' })
    );
  });

  it('maps the cap to a CONFLICT', async () => {
    db.restaurantSopTemplate.count.mockResolvedValue(5);
    await expect(
      caller({ 'sop.templates.max': 5 }).createTemplate({ name: 'Too many' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('strict-zod boundary', () => {
  it('rejects an unknown key on createTemplate with BAD_REQUEST', async () => {
    await expect(
      caller().createTemplate({ name: 'x', sneaky: true } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects an unknown key on createAssignment with BAD_REQUEST', async () => {
    await expect(
      caller().createAssignment({
        branchId: 'b1',
        templateId: 't1',
        frequency: 'DAILY',
        startDate: '2026-01-01',
        branchOverride: 'nope',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('publish immutability mapping', () => {
  it('maps a step mutation on a PUBLISHED version to CONFLICT', async () => {
    db.restaurantSopTemplateVersion.findUnique.mockResolvedValue({
      id: 'v1',
      templateId: 't1',
      versionNumber: 1,
      status: 'PUBLISHED',
    });
    await expect(
      caller().addStep({ templateVersionId: 'v1', title: 'late edit' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps publishing an empty draft to BAD_REQUEST', async () => {
    db.restaurantSopTemplateVersion.findUnique.mockResolvedValue({
      id: 'v1',
      templateId: 't1',
      versionNumber: 1,
      status: 'DRAFT',
    });
    db.restaurantSopTemplateStep.count.mockResolvedValue(0);
    await expect(caller().publishVersion({ versionId: 'v1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('createAssignment — recurrence validation mapping', () => {
  it('maps an end-before-start rule to BAD_REQUEST', async () => {
    await expect(
      caller().createAssignment({
        branchId: 'b1',
        templateId: 't1',
        frequency: 'DAILY',
        startDate: '2026-05-10',
        endDate: '2026-05-01',
        assigneeTarget: { type: 'role', jobRoleId: 'jr1' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('creates when the branch, template, and rule are valid', async () => {
    db.restaurantBranch.findUnique.mockResolvedValue({ id: 'b1' });
    db.restaurantSopTemplate.findUnique.mockResolvedValue({ id: 't1' });
    db.restaurantJobRole.findUnique.mockResolvedValue({ id: 'jr1', key: 'barista', active: true });
    const created = await caller().createAssignment({
      branchId: 'b1',
      templateId: 't1',
      frequency: 'WEEKLY',
      interval: 1,
      daysOfWeek: [1, 3, 5],
      startDate: '2026-05-01',
      dueTimeMinutes: 360,
      assigneeTarget: { type: 'role', jobRoleId: 'jr1' },
    });
    expect(created.branchId).toBe('b1');
    expect(db.restaurantSopAssignment.create).toHaveBeenCalledTimes(1);
  });
});

describe('previewSchedule — DST-correct, no persistence', () => {
  it('returns the next-valid instant across a NY spring-forward gap', async () => {
    db.restaurantBranch.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
    const preview = await caller().previewSchedule({
      branchId: 'b1',
      from: '2026-03-08',
      to: '2026-03-08',
      frequency: 'DAILY',
      startDate: '2026-03-01',
      dueTimeMinutes: 2 * 60 + 30, // 02:30 — inside the gap
    });
    expect(preview).toHaveLength(1);
    expect(preview![0]!.dueAt.toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(preview![0]!.adjustment).toBe('spring-forward');
    // Preview must not write.
    expect(db.restaurantSopOccurrence?.create).toBeUndefined();
  });

  it('maps a missing branch to NOT_FOUND', async () => {
    db.restaurantBranch.findUnique.mockResolvedValue(null);
    await expect(
      caller().previewSchedule({
        branchId: 'missing',
        from: '2026-03-08',
        to: '2026-03-08',
        frequency: 'DAILY',
        startDate: '2026-03-01',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
