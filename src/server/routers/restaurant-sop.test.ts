/**
 * M7-L3 router tests — capability-gated SOP authoring console. Runs the REAL
 * router against a hand-rolled in-memory db; ABAC, entitlements, and audit are
 * mocked. Covers: `sop.templates.max` from entitlements, publish-immutability
 * error mapping, strict-zod rejection of unknown keys, recurrence validation
 * mapping, and the DST-correct schedule preview.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  annotateAudit: vi.fn(),
  resolveStaffBranchAuthorization: vi.fn(async () => ({
    actorStaffProfileId: 'staff_1',
    organizationWide: false,
    branchIds: ['branch_1'],
  })),
  claimSopOccurrence: vi.fn(),
  listClaimablePoolOccurrences: vi.fn(),
  listStaffSopOccurrences: vi.fn(),
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

vi.mock('@/lib/restaurant/sop-assignment', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/sop-assignment')>(
    '@/lib/restaurant/sop-assignment'
  );
  return {
    ...actual,
    claimSopOccurrence: mocks.claimSopOccurrence,
    listClaimablePoolOccurrences: mocks.listClaimablePoolOccurrences,
    listStaffSopOccurrences: mocks.listStaffSopOccurrences,
  };
});

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
    restaurantBranch: Object.assign(model(), {
      findMany: vi.fn(async (args?: { where?: { id?: { in?: string[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({ id }))
      ),
    }),
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
      organizationId: 'org_1',
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
  it('rejects INTERVAL cadences below 15 minutes or without selected weekdays', async () => {
    const base = {
      branchId: 'b1',
      templateId: 't1',
      frequency: 'INTERVAL' as const,
      startDate: '2026-05-10',
      dueTimeMinutes: 600,
      intervalEndTimeMinutes: 1380,
      assigneeTarget: { type: 'role' as const, jobRoleId: 'jr1' },
    };
    await expect(
      caller().createAssignment({ ...base, interval: 14, daysOfWeek: [0] })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().createAssignment({ ...base, interval: 60, daysOfWeek: [] })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

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

describe('updateAssignment — effective-dated successor', () => {
  const assignment = (overrides: Record<string, unknown> = {}) => ({
    id: 'assignment_1',
    branchId: 'b1',
    templateId: 't1',
    frequency: 'DAILY',
    interval: 1,
    daysOfWeek: [],
    monthDay: null,
    startDate: new Date('2026-05-01T00:00:00.000Z'),
    endDate: null,
    dueTimeMinutes: 600,
    intervalEndTimeMinutes: null,
    windowMinutes: 60,
    graceMinutes: 15,
    active: true,
    assigneeTargetType: 'ROLE',
    assigneeStaffProfileId: null,
    assigneeJobRoleId: 'jr1',
    ...overrides,
  });

  it('keeps the predecessor schedulable until a future successor becomes effective', async () => {
    db.restaurantSopAssignment.findUnique.mockResolvedValue(assignment());

    const successor = await caller().updateAssignment({
      id: 'assignment_1',
      effectiveDate: '2026-06-01',
      frequency: 'INTERVAL',
      interval: 60,
      daysOfWeek: [1, 3, 5],
      dueTimeMinutes: 600,
      intervalEndTimeMinutes: 1380,
    });

    expect(successor).toMatchObject({ supersedesAssignmentId: 'assignment_1' });
    expect(db.restaurantSopAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          startDate: new Date('2026-06-01T00:00:00.000Z'),
          supersedesAssignmentId: 'assignment_1',
        }),
      })
    );
    expect(db.restaurantSopAssignment.update).toHaveBeenCalledWith({
      where: { id: 'assignment_1' },
      data: {
        active: true,
        endDate: new Date('2026-05-31T00:00:00.000Z'),
        supersededAt: expect.any(Date),
      },
    });
    expect(db.restaurantSopOccurrence.findMany).not.toHaveBeenCalled();
  });

  it('preserves an earlier predecessor end date when the successor extends the schedule', async () => {
    db.restaurantSopAssignment.findUnique.mockResolvedValue(
      assignment({
        endDate: new Date('2026-05-15T00:00:00.000Z'),
      })
    );

    await caller().updateAssignment({
      id: 'assignment_1',
      effectiveDate: '2026-06-01',
      endDate: '2026-06-30',
    });

    expect(db.restaurantSopAssignment.update).toHaveBeenCalledWith({
      where: { id: 'assignment_1' },
      data: {
        active: true,
        endDate: new Date('2026-05-15T00:00:00.000Z'),
        supersededAt: expect.any(Date),
      },
    });
  });

  it('clips a later predecessor end date at the successor boundary', async () => {
    db.restaurantSopAssignment.findUnique.mockResolvedValue(
      assignment({
        endDate: new Date('2026-06-30T00:00:00.000Z'),
      })
    );

    await caller().updateAssignment({ id: 'assignment_1', effectiveDate: '2026-06-01' });

    expect(db.restaurantSopAssignment.update).toHaveBeenCalledWith({
      where: { id: 'assignment_1' },
      data: {
        active: true,
        endDate: new Date('2026-05-31T00:00:00.000Z'),
        supersededAt: expect.any(Date),
      },
    });
  });

  it('keeps a paused assignment and its successor inactive', async () => {
    db.restaurantSopAssignment.findUnique.mockResolvedValue(assignment({ active: false }));

    await caller().updateAssignment({ id: 'assignment_1', effectiveDate: '2026-06-01' });

    expect(db.restaurantSopAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ active: false }) })
    );
    expect(db.restaurantSopAssignment.update).toHaveBeenCalledWith({
      where: { id: 'assignment_1' },
      data: {
        active: false,
        endDate: new Date('2026-05-31T00:00:00.000Z'),
        supersededAt: expect.any(Date),
      },
    });
  });

  it('deactivates a same-day predecessor without replacing its valid end date', async () => {
    db.restaurantSopAssignment.findUnique.mockResolvedValue(
      assignment({ endDate: new Date('2026-05-20T00:00:00.000Z') })
    );

    await caller().updateAssignment({ id: 'assignment_1', effectiveDate: '2026-05-01' });

    expect(db.restaurantSopAssignment.update).toHaveBeenCalledWith({
      where: { id: 'assignment_1' },
      data: {
        active: false,
        endDate: new Date('2026-05-20T00:00:00.000Z'),
        supersededAt: expect.any(Date),
      },
    });
  });

  it('keeps an open-ended same-day predecessor valid while deactivating it', async () => {
    db.restaurantSopAssignment.findUnique.mockResolvedValue(assignment());

    await caller().updateAssignment({ id: 'assignment_1', effectiveDate: '2026-05-01' });

    expect(db.restaurantSopAssignment.update).toHaveBeenCalledWith({
      where: { id: 'assignment_1' },
      data: {
        active: false,
        endDate: null,
        supersededAt: expect.any(Date),
      },
    });
  });

  describe('pause/resume with a pending revision', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-05-15T12:00:00.000Z'));
    });

    afterEach(() => vi.useRealTimers());

    async function revise(effectiveDate = '2026-06-01', endDate: Date | null = null) {
      const predecessor = assignment({
        endDate,
        branch: { timezone: 'America/New_York', businessDayCutoff: '02:00' },
      });
      db.restaurantSopAssignment.findUnique.mockResolvedValue(predecessor);
      db.restaurantSopAssignment.update.mockImplementation(async ({ data }) =>
        Object.assign(predecessor, data)
      );
      const successor = await caller().updateAssignment({
        id: predecessor.id,
        effectiveDate,
        endDate: null,
      });
      Object.assign(predecessor, { supersededBy: successor });
      return { predecessor, successor };
    }

    it('resumes a paused predecessor before its future successor takes effect', async () => {
      const { predecessor, successor } = await revise();
      await caller().setAssignmentActive({ id: predecessor.id, active: false });
      expect(predecessor.active).toBe(false);

      await expect(
        caller().setAssignmentActive({ id: predecessor.id, active: true })
      ).resolves.toMatchObject({ active: true, endDate: new Date('2026-05-31T00:00:00Z') });
      expect(successor).toMatchObject({
        active: true,
        startDate: new Date('2026-06-01T00:00:00Z'),
      });
    });

    it('allows resuming through the last business day, including after local midnight', async () => {
      const { predecessor } = await revise();
      await caller().setAssignmentActive({ id: predecessor.id, active: false });
      vi.setSystemTime(new Date('2026-06-01T05:59:59.000Z'));
      await expect(
        caller().setAssignmentActive({ id: predecessor.id, active: true })
      ).resolves.toMatchObject({ active: true });
    });

    it('rejects resuming at the successor business-day cutoff', async () => {
      const { predecessor } = await revise();
      await caller().setAssignmentActive({ id: predecessor.id, active: false });
      vi.setSystemTime(new Date('2026-06-01T06:00:00.000Z'));
      await expect(
        caller().setAssignmentActive({ id: predecessor.id, active: true })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(predecessor.active).toBe(false);
    });

    it.each([null, new Date('2026-05-20T00:00:00Z')])(
      'rejects resuming a same-start-date predecessor with endDate %s',
      async (endDate) => {
        vi.setSystemTime(new Date('2026-04-15T12:00:00Z'));
        const { predecessor } = await revise('2026-05-01', endDate);
        await expect(
          caller().setAssignmentActive({ id: predecessor.id, active: true })
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(predecessor.active).toBe(false);
      }
    );

    it('rejects resuming after an earlier end date even while the successor is pending', async () => {
      const { predecessor } = await revise('2026-06-01', new Date('2026-05-15T00:00:00Z'));
      await caller().setAssignmentActive({ id: predecessor.id, active: false });
      vi.setSystemTime(new Date('2026-05-16T12:00:00Z'));
      await expect(
        caller().setAssignmentActive({ id: predecessor.id, active: true })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(predecessor.active).toBe(false);
    });
  });
});

describe('previewSchedule — DST-correct, no persistence', () => {
  it('previews every interval slot in the branch timezone', async () => {
    db.restaurantBranch.findUnique.mockResolvedValue({ timezone: 'Asia/Karachi' });
    const preview = await caller().previewSchedule({
      branchId: 'b1',
      from: '2026-03-08',
      to: '2026-03-08',
      frequency: 'INTERVAL',
      interval: 30,
      daysOfWeek: [0],
      startDate: '2026-03-08',
      endDate: '2026-03-08',
      dueTimeMinutes: 9 * 60,
      intervalEndTimeMinutes: 10 * 60,
    });
    expect(preview?.map((item) => item.dueAt.toISOString())).toEqual([
      '2026-03-08T04:00:00.000Z',
      '2026-03-08T04:30:00.000Z',
      '2026-03-08T05:00:00.000Z',
    ]);
  });

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

// ── H5: assignment-pool identity comes from the session ──────────────────────

describe('assignment pools bind the staff profile to the session', () => {
  beforeEach(() => {
    db.restaurantStaffProfile.findMany.mockResolvedValue([{ id: 'staff_session' }]);
    mocks.claimSopOccurrence.mockResolvedValue({
      status: 'CLAIMED',
      claimedByStaffProfileId: 'staff_session',
      claimedAt: new Date(),
    });
    mocks.listClaimablePoolOccurrences.mockResolvedValue([]);
    mocks.listStaffSopOccurrences.mockResolvedValue([]);
  });

  it('claims as the session staff profile, ignoring a supplied staffProfileId', async () => {
    await caller().claimOccurrence({ occurrenceId: 'occ_1', staffProfileId: 'victim' });
    expect(mocks.claimSopOccurrence).toHaveBeenCalledWith(db, 'occ_1', 'staff_session');
    expect(db.restaurantStaffProfile.findMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', organizationId: 'org_1', status: 'ACTIVE' },
      select: { id: true },
      take: 2,
    });
  });

  it('claims without a staffProfileId in the input', async () => {
    await caller().claimOccurrence({ occurrenceId: 'occ_1' });
    expect(mocks.claimSopOccurrence).toHaveBeenCalledWith(db, 'occ_1', 'staff_session');
  });

  it("reads only the caller's own pool and queue", async () => {
    await caller().listClaimablePool({ staffProfileId: 'victim', branchId: 'branch_1' });
    await caller().listMySopOccurrences({ staffProfileId: 'victim', branchId: 'branch_1' });
    expect(mocks.listClaimablePoolOccurrences).toHaveBeenCalledWith(db, 'staff_session', {
      branchId: 'branch_1',
    });
    expect(mocks.listStaffSopOccurrences).toHaveBeenCalledWith(db, 'staff_session', {
      branchId: 'branch_1',
    });
  });

  it.each([{ profiles: [] }, { profiles: [{ id: 'a' }, { id: 'b' }] }])(
    'fails closed without a unique active session staff profile',
    async ({ profiles }) => {
      db.restaurantStaffProfile.findMany.mockResolvedValue(profiles);
      await expect(
        caller().claimOccurrence({ occurrenceId: 'occ_1', staffProfileId: 'victim' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.claimSopOccurrence).not.toHaveBeenCalled();
    }
  );
});
