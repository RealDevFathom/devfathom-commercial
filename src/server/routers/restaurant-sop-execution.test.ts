/**
 * M7-L4 router tests — SOP execution console. Runs the real router against an
 * in-memory db. Covers: capability gating, strict-zod unknown-key rejection, state
 * error mapping (INVALID_STATE → CONFLICT, NOT_FOUND, CO_AUTH_REQUIRED → FORBIDDEN),
 * occurrence board listing (cursor pagination), and command routing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async (...args: unknown[]) => {
    void args;
    return true;
  }),
  annotateAudit: vi.fn(),
  authenticateOperator: vi.fn(),
  operatorHasCapability: vi.fn(),
}));

// DEV-879: these fixtures model an approver with no approval authenticator, so the PIN is
// checked exactly as before. approval-authenticator.test.ts covers the authenticator path.
vi.mock('@/lib/approval-authenticator', async () => {
  const { verifyOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
  return {
    verifyApprovalSecret: async (
      _db: unknown,
      input: { secret: string; credentialHash: string }
    ) =>
      (await verifyOperatorCredential('PIN', input.secret, input.credentialHash)) ? 'PIN' : null,
  };
});
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  authenticateOperator: mocks.authenticateOperator,
}));
vi.mock('@/lib/restaurant/checkout-routes', () => ({
  operatorHasCapability: mocks.operatorHasCapability,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  withTenantDb: vi.fn(async (_org, fn) => fn(db)),
}));
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

import { restaurantSopExecutionRouter } from './restaurant-sop-execution';
import { packageByKey } from '@/lib/vertical-catalog';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'new_id',
      createdAt: new Date(),
      ...data,
    })),
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
    update: vi
      .fn()
      .mockImplementation(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: where.id,
          ...data,
        })
      ),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
}

function makeDb() {
  const db: Record<string, unknown> = {
    restaurantSopOccurrence: model(),
    restaurantSopOccurrenceStep: model(),
    restaurantSopEvidence: model(),
    restaurantSopVerification: model(),
    restaurantSopEscalationEvent: model(),
    restaurantCoAuthorization: model(),
    restaurantNotification: model(),
    restaurantNotificationDelivery: model(),
    restaurantStaffProfile: model(),
    restaurantStaffJobRole: model(),
    restaurantBranchAssignment: model(),
    restaurantBranch: Object.assign(model(), {
      findMany: vi.fn(async (args?: { where?: { id?: { in?: string[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({ id }))
      ),
    }),
  };
  db.$queryRawUnsafe = vi.fn().mockResolvedValue([]);
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as Record<string, Delegate> & { $transaction: ReturnType<typeof vi.fn> };
}

let db: ReturnType<typeof makeDb>;

beforeEach(() => {
  vi.clearAllMocks();
  db = makeDb();
  db.restaurantStaffProfile.findMany.mockResolvedValue([{ id: 'staff_a' }]);
  mocks.authenticateOperator.mockResolvedValue({ ok: true, staffProfileId: 'staff_b' });
  mocks.operatorHasCapability.mockResolvedValue(true);
  mocks.can.mockResolvedValue(true);
  mocks.annotateAudit.mockReset();
});

/**
 * WHA-264 — an entitlement view as `resolveOrganizationEntitlements` would build
 * it for an organization holding exactly one commercial package. Derived from
 * the catalog so the fixtures move with a repricing instead of restating module
 * keys and limit values here.
 */
function entitlementsForPackage(packageKey: string) {
  const pkg = packageByKey(packageKey);
  if (!pkg) throw new Error(`Unknown package ${packageKey}`);
  return {
    enabledModules: [...pkg.moduleKeys],
    activeSeats: 1,
    seatLimit: 50,
    modules: [],
    limits: { ...pkg.defaultLimits } as Record<string, number>,
  };
}

/** The deepest tier — the default for every pre-existing behavioural test. */
const FULL_ENTITLEMENTS = entitlementsForPackage('restaurant-enterprise');

function caller(entitlements: ReturnType<typeof entitlementsForPackage> = FULL_ENTITLEMENTS) {
  return restaurantSopExecutionRouter.createCaller({
    db: db as never,
    entitlements: { organizationId: 'org_1', ...entitlements },
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

const OCC_ID = 'occ_1';

// ── strict-zod boundary ────────────────────────────────────────────────────────

describe('strict-zod boundary', () => {
  it('rejects unknown key on start', async () => {
    await expect(
      caller().start({ occurrenceId: OCC_ID, unknownKey: true } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects unknown key on verify', async () => {
    await expect(
      caller().verify({ occurrenceId: OCC_ID, sneaky: 'yes' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects unknown key on waive', async () => {
    await expect(
      caller().waive({
        occurrenceId: OCC_ID,
        actorStaffProfileId: 'a',
        approvingStaffProfileId: 'b',
        reason: 'r',
        extra: true,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects unknown key on listOccurrences', async () => {
    await expect(
      caller().listOccurrences({ branchId: 'b1', badField: true } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// ── listOccurrences ────────────────────────────────────────────────────────────

describe('listOccurrences', () => {
  it('returns paged items and null nextCursor when under limit', async () => {
    const occs = [
      {
        id: 'o1',
        status: 'LATE',
        businessDate: new Date(),
        dueAt: new Date(),
        windowEndsAt: new Date(),
        startedAt: null,
        submittedAt: null,
        resolvedAt: null,
        assignment: { id: 'a1', template: { id: 't1', name: 'Open Check', category: null } },
        steps: [],
      },
    ];
    db.restaurantSopOccurrence.findMany.mockResolvedValue(occs);

    const result = await caller().listOccurrences({ branchId: 'branch_1' });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it('returns nextCursor when result exceeds limit', async () => {
    // Return limit+1 items
    const occs = Array.from({ length: 51 }, (_, i) => ({
      id: `o${i}`,
      status: 'LATE',
      businessDate: new Date(),
      dueAt: new Date(),
      windowEndsAt: new Date(),
      startedAt: null,
      submittedAt: null,
      resolvedAt: null,
      assignment: { id: 'a1', template: { id: 't1', name: 'x', category: null } },
      steps: [],
    }));
    db.restaurantSopOccurrence.findMany.mockResolvedValue(occs);

    const result = await caller().listOccurrences({ branchId: 'branch_1' });
    expect(result.items).toHaveLength(50);
    expect(result.nextCursor).toBe('o49');
  });

  it('denies a branch outside the caller branch scope before reading occurrences', async () => {
    mocks.can.mockImplementation(async (...args) => args[1] === 'sop:complete');

    await expect(caller().listOccurrences({ branchId: 'branch_2' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.restaurantSopOccurrence.findMany).not.toHaveBeenCalled();
  });

  it('limits a branch operator to direct, claimed, and eligible unclaimed pool work', async () => {
    mocks.can.mockImplementation(async (...args) => args[1] === 'sop:complete');
    db.restaurantStaffProfile.findFirst.mockResolvedValue({
      id: 'staff_1',
      jobRoles: [{ jobRoleId: 'role_1' }],
    });
    db.restaurantSopOccurrence.findMany.mockResolvedValue([]);

    await caller().listOccurrences({ branchId: 'branch_1' });

    expect(db.restaurantSopOccurrence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branchId: 'branch_1',
          OR: [
            { assignedStaffProfileId: 'staff_1' },
            { claimedByStaffProfileId: 'staff_1' },
            { poolJobRoleId: { in: ['role_1'] }, claimedByStaffProfileId: null },
          ],
        }),
      })
    );
  });

  it('does not grant pool visibility or claims through an inactive role', async () => {
    mocks.can.mockImplementation(async (...args) => args[1] === 'sop:complete');
    db.restaurantStaffProfile.findFirst.mockImplementation(async ({ select }) => ({
      id: 'staff_1',
      jobRoles: select.jobRoles?.where.jobRole?.active ? [] : [{ jobRoleId: 'inactive_role' }],
    }));

    await caller().listOccurrences({ branchId: 'branch_1' });
    expect(db.restaurantSopOccurrence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ assignedStaffProfileId: 'staff_1' }, { claimedByStaffProfileId: 'staff_1' }],
        }),
      })
    );

    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      branchId: 'branch_1',
      status: 'SCHEDULED',
      assignedStaffProfileId: null,
      claimedByStaffProfileId: null,
      poolJobRoleId: 'inactive_role',
    });
    await expect(caller().getOccurrence({ id: OCC_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller().claim({ occurrenceId: OCC_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.restaurantSopOccurrence.updateMany).not.toHaveBeenCalled();
  });
});

describe('claim', () => {
  it.each(['SCHEDULED', 'REJECTED'])(
    'binds an atomic %s role-pool claim to the authenticated active staff profile',
    async (status) => {
      db.restaurantSopOccurrence.findUnique
        .mockResolvedValueOnce({ branchId: 'branch_1', status, poolJobRoleId: 'role_1' })
        .mockResolvedValueOnce({
          id: OCC_ID,
          branchId: 'branch_1',
          status,
          poolJobRoleId: 'role_1',
          claimedByStaffProfileId: null,
          claimedAt: null,
        });
      db.restaurantStaffProfile.findFirst.mockResolvedValue({
        id: 'staff_1',
        jobRoles: [{ jobRoleId: 'role_1' }],
      });
      db.restaurantStaffJobRole.findMany.mockResolvedValue([
        { staffProfileId: 'staff_1', staffProfile: { id: 'staff_1', status: 'ACTIVE' } },
      ]);
      db.restaurantSopOccurrence.updateMany.mockResolvedValue({ count: 1 });

      await expect(caller().claim({ occurrenceId: OCC_ID })).resolves.toMatchObject({
        status: 'CLAIMED',
        claimedByStaffProfileId: 'staff_1',
      });
      expect(db.restaurantSopOccurrence.updateMany).toHaveBeenCalledWith({
        where: {
          id: OCC_ID,
          claimedByStaffProfileId: null,
          status: { in: ['SCHEDULED', 'REJECTED'] },
        },
        data: { claimedByStaffProfileId: 'staff_1', claimedAt: expect.any(Date) },
      });
    }
  );

  it.each(['before reload', 'before write'])(
    'does not claim an occurrence closed %s',
    async (closedAt) => {
      db.restaurantSopOccurrence.findUnique
        .mockResolvedValueOnce({
          branchId: 'branch_1',
          status: 'SCHEDULED',
          poolJobRoleId: 'role_1',
        })
        .mockResolvedValueOnce({
          id: OCC_ID,
          branchId: 'branch_1',
          status: closedAt === 'before reload' ? 'MISSED' : 'SCHEDULED',
          poolJobRoleId: 'role_1',
          claimedByStaffProfileId: null,
          claimedAt: null,
        })
        .mockResolvedValueOnce({
          status: 'MISSED',
          claimedByStaffProfileId: null,
          claimedAt: null,
        });
      db.restaurantStaffProfile.findFirst.mockResolvedValue({
        id: 'staff_1',
        jobRoles: [{ jobRoleId: 'role_1' }],
      });
      db.restaurantStaffJobRole.findMany.mockResolvedValue([
        { staffProfileId: 'staff_1', staffProfile: { id: 'staff_1', status: 'ACTIVE' } },
      ]);
      // The scheduler commits MISSED after the last read. PostgreSQL evaluates
      // the conditional write against that state, so a status guard must reject it.
      db.restaurantSopOccurrence.updateMany.mockImplementation(async ({ where }) => ({
        count: where.status && !where.status.in.includes('MISSED') ? 0 : 1,
      }));

      await expect(caller().claim({ occurrenceId: OCC_ID })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      if (closedAt === 'before reload') {
        expect(db.restaurantSopOccurrence.updateMany).not.toHaveBeenCalled();
      }
      expect(mocks.annotateAudit).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['staff_1', 'ALREADY_CLAIMED_BY_CALLER'],
    ['staff_2', 'CLAIMED_BY_OTHER'],
  ])('reports the settled claim by %s even if work has since started', async (winner, status) => {
    db.restaurantSopOccurrence.findUnique
      .mockResolvedValueOnce({ branchId: 'branch_1', status: 'SCHEDULED', poolJobRoleId: 'role_1' })
      .mockResolvedValueOnce({
        id: OCC_ID,
        branchId: 'branch_1',
        status: 'SCHEDULED',
        poolJobRoleId: 'role_1',
        claimedByStaffProfileId: null,
        claimedAt: null,
      })
      .mockResolvedValueOnce({
        status: 'IN_PROGRESS',
        claimedByStaffProfileId: winner,
        claimedAt: new Date(),
      });
    db.restaurantStaffProfile.findFirst.mockResolvedValue({
      id: 'staff_1',
      jobRoles: [{ jobRoleId: 'role_1' }],
    });
    db.restaurantStaffJobRole.findMany.mockResolvedValue([
      { staffProfileId: 'staff_1', staffProfile: { id: 'staff_1', status: 'ACTIVE' } },
    ]);

    await expect(caller().claim({ occurrenceId: OCC_ID })).resolves.toMatchObject({
      status,
      claimedByStaffProfileId: winner,
    });
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });
});

describe('SOP reporting', () => {
  it('lists every active branch for restaurant configurators', async () => {
    db.restaurantBranch.findMany.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);

    await expect(caller().reportBranches()).resolves.toEqual([{ id: 'branch_1', name: 'Main' }]);
    expect(db.restaurantBranch.findMany).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true },
    });
  });

  it('lists only assigned branches for a report-capable non-configurator', async () => {
    mocks.can.mockImplementation(async (...args) => args[1] === 'reports:operational');

    await caller().reportBranches();

    expect(db.restaurantBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          active: true,
          OR: [
            { staffProfiles: { some: { userId: 'user_1', status: 'ACTIVE' } } },
            { assignments: { some: { userId: 'user_1' } } },
          ],
        },
      })
    );
  });

  it('composes date, branch and department filters and reconciles the fixture', async () => {
    db.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'staff_1' });
    db.restaurantSopOccurrence.findMany.mockResolvedValue([
      {
        id: 'verified',
        status: 'VERIFIED',
        dueAt: new Date('2026-08-20T09:00:00Z'),
        windowEndsAt: new Date('2026-08-20T10:00:00Z'),
        submittedAt: new Date('2026-08-20T09:30:00Z'),
        resolvedAt: new Date('2026-08-20T09:45:00Z'),
        assignedStaff: {
          id: 'staff_1',
          displayName: 'Alex',
          user: { department: 'QUALITY' },
        },
        claimedBy: null,
        steps: [],
        evidence: [{ id: 'proof' }],
        verifications: [{ action: 'VERIFY' }],
        escalationEvents: [],
      },
    ]);

    const result = await caller().report({
      branchId: 'branch_1',
      from: '2026-08-20',
      to: '2026-08-20',
      department: 'QUALITY',
    });

    expect(result).toMatchObject({ total: 1, onTime: 1, verified: 1, performanceScore: 100 });
    expect(db.restaurantSopOccurrence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ branchId: 'branch_1', OR: expect.any(Array) }),
      })
    );
  });

  it('denies a report-capable user without branch proof', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(
      caller().report({ branchId: 'other_branch', from: '2026-08-20', to: '2026-08-20' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.restaurantSopOccurrence.findMany).not.toHaveBeenCalled();
  });

  it('rejects inverted ranges and unknown report input', async () => {
    await expect(
      caller().report({
        branchId: 'branch_1',
        from: '2026-08-21',
        to: '2026-08-20',
        extra: true,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// ── getOccurrence ──────────────────────────────────────────────────────────────

describe('getOccurrence', () => {
  it('throws NOT_FOUND when occurrence does not exist', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue(null);

    await expect(caller().getOccurrence({ id: OCC_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

// ── start command ──────────────────────────────────────────────────────────────

describe('start', () => {
  it('starts a SCHEDULED occurrence and annotates the audit', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      assignedStaffProfileId: 'staff_a',
      poolJobRoleId: null,
      claimedByStaffProfileId: null,
      branchId: 'branch_1',
      status: 'SCHEDULED',
    });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, startedAt: new Date() });

    const result = await caller().start({ occurrenceId: OCC_ID });
    expect(result.status).toBe('IN_PROGRESS');
    expect(mocks.annotateAudit).toHaveBeenCalled();
  });

  it('maps INVALID_STATE → CONFLICT', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      assignedStaffProfileId: 'staff_a',
      poolJobRoleId: null,
      claimedByStaffProfileId: null,
      branchId: 'branch_1',
      status: 'SUBMITTED',
    });

    await expect(caller().start({ occurrenceId: OCC_ID })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('maps NOT_FOUND → NOT_FOUND', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue(null);

    await expect(caller().start({ occurrenceId: OCC_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

// ── submit command ─────────────────────────────────────────────────────────────

describe('submit', () => {
  it('submits an IN_PROGRESS occurrence', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      assignedStaffProfileId: 'staff_a',
      poolJobRoleId: null,
      claimedByStaffProfileId: null,
      branchId: 'branch_1',
      status: 'IN_PROGRESS',
      windowEndsAt: new Date(Date.now() + 3_600_000),
      steps: [],
    });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, submittedAt: new Date() });

    const result = await caller().submit({ occurrenceId: OCC_ID });
    expect(result.status).toBe('SUBMITTED');
  });
});

// ── verify command ─────────────────────────────────────────────────────────────

describe('verify', () => {
  it('verifies a SUBMITTED occurrence', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      assignedStaffProfileId: 'staff_a',
      poolJobRoleId: null,
      claimedByStaffProfileId: null,
      branchId: 'branch_1',
      status: 'SUBMITTED',
    });
    db.restaurantSopVerification.create.mockResolvedValue({ id: 'ver_1', createdAt: new Date() });

    const result = await caller().verify({ occurrenceId: OCC_ID });
    expect(result.action).toBe('VERIFY');
  });
});

// ── waive command ──────────────────────────────────────────────────────────────

describe('waive', () => {
  it('maps CO_AUTH_REQUIRED → FORBIDDEN when actor equals approver', async () => {
    // `isSoloOwner` selects the user's role and job roles; the session staff
    // here is the only active profile but is not an owner, so self-approval fails.
    db.restaurantStaffProfile.findMany.mockImplementation(
      async (args: { select?: { user?: unknown } }) =>
        args?.select?.user ? [{ id: 'staff_a', user: null, jobRoles: [] }] : [{ id: 'staff_a' }]
    );
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      assignedStaffProfileId: 'staff_a',
      poolJobRoleId: null,
      claimedByStaffProfileId: null,
      branchId: 'branch_1',
      status: 'SUBMITTED',
    });

    await expect(
      caller().waive({
        occurrenceId: OCC_ID,
        actorStaffProfileId: 'same_person',
        approvingStaffProfileId: 'staff_a',
        approvingType: 'PIN',
        approvingSecret: '4821',
        reason: 'test',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });

  it('waives with valid co-authorization', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      assignedStaffProfileId: 'staff_a',
      poolJobRoleId: null,
      claimedByStaffProfileId: null,
      branchId: 'branch_1',
      status: 'MISSED',
    });
    db.restaurantCoAuthorization.create.mockResolvedValue({ id: 'coauth_1' });
    db.restaurantSopVerification.create.mockResolvedValue({ id: 'ver_1', createdAt: new Date() });

    const result = await caller().waive({
      occurrenceId: OCC_ID,
      actorStaffProfileId: 'staff_a',
      approvingStaffProfileId: 'staff_b',
      approvingType: 'PIN' as const,
      approvingSecret: '4821',
      reason: 'Emergency',
    });
    expect(result.action).toBe('WAIVE');
  });

  describe('sole-owner self-approval', () => {
    const owner = { id: 'staff_a', user: { organizationRole: { key: 'owner' } }, jobRoles: [] };
    const selfWaiver = {
      occurrenceId: OCC_ID,
      approvingStaffProfileId: 'staff_a',
      approvingType: 'PIN' as const,
      approvingSecret: '4821',
      reason: 'Closed for the day',
    };
    function staffRoster(roster: unknown[]) {
      db.restaurantStaffProfile.findMany.mockImplementation(
        async (args: { select?: { user?: unknown } }) =>
          // `isSoloOwner` selects the user's role; the session lookup selects ids.
          args?.select?.user ? roster : [{ id: 'staff_a' }]
      );
    }

    beforeEach(() => {
      db.restaurantSopOccurrence.findUnique.mockResolvedValue({
        id: OCC_ID,
        branchId: 'branch_1',
        status: 'MISSED',
      });
      db.restaurantCoAuthorization.create.mockResolvedValue({ id: 'coauth_solo' });
      db.restaurantSopVerification.create.mockResolvedValue({ id: 'ver_1', createdAt: new Date() });
      mocks.authenticateOperator.mockResolvedValue({ ok: true, staffProfileId: 'staff_a' });
    });

    it('lets the only active staff member, an owner, waive after a fresh PIN', async () => {
      staffRoster([owner]);
      await expect(caller().waive(selfWaiver)).resolves.toMatchObject({ action: 'WAIVE' });
      expect(mocks.authenticateOperator).toHaveBeenCalledWith(db, {
        staffProfileId: 'staff_a',
        type: 'PIN',
        secret: '4821',
        now: expect.any(Date),
        approval: {
          action: 'restaurant.backOfficeApproval.sop:verify',
          requestedByStaffProfileId: 'staff_a',
        },
      });
      expect(db.restaurantCoAuthorization.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actingStaffProfileId: 'staff_a',
            approvingStaffProfileId: 'staff_a',
            reason: 'Closed for the day [Owner PIN reauthentication]',
          }),
        })
      );
      expect(mocks.annotateAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ metadata: { approvalMode: 'OWNER_PIN_REAUTHENTICATION' } })
      );
    });

    it('refuses a solo owner whose PIN is wrong, without writing the waiver', async () => {
      staffRoster([owner]);
      mocks.authenticateOperator.mockResolvedValue({ ok: false, reason: 'INVALID' });
      await expect(
        caller().waive({ ...selfWaiver, approvingSecret: '0000' })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Approving credential is invalid or locked.',
      });
      expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
      expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
    });

    it('refuses self-approval when a second active staff member exists', async () => {
      staffRoster([owner, { id: 'staff_b', user: null, jobRoles: [] }]);
      await expect(caller().waive(selfWaiver)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
      expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
    });

    it('refuses self-approval by badge (a PIN re-entry is required)', async () => {
      staffRoster([owner]);
      await expect(
        caller().waive({ ...selfWaiver, approvingType: 'BADGE', approvingSecret: 'badge-1' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.authenticateOperator).not.toHaveBeenCalled();
      expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
    });
  });
});

// ── acknowledge command ────────────────────────────────────────────────────────

describe('acknowledge', () => {
  it('records an ACKNOWLEDGED escalation event', async () => {
    db.restaurantSopEscalationEvent.findFirst.mockResolvedValue(null);
    db.restaurantSopEscalationEvent.create.mockResolvedValue({ id: 'evt_1' });

    const result = await caller().acknowledge({ occurrenceId: OCC_ID });
    expect(result.occurrenceId).toBe(OCC_ID);
  });
});

// ── WHA-264: SOP depth entitlement gating ─────────────────────────────────────

describe('SOP depth entitlement gating', () => {
  const ESSENTIALS = entitlementsForPackage('restaurant-essentials');
  const OPERATIONS = entitlementsForPackage('restaurant-operations');
  const ENTERPRISE = entitlementsForPackage('restaurant-enterprise');

  /** Put every command on a state where only the entitlement gate can refuse. */
  function primeHappyPath() {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      assignedStaffProfileId: 'staff_a',
      poolJobRoleId: null,
      claimedByStaffProfileId: null,
      branchId: 'branch_1',
      status: 'SUBMITTED',
      windowEndsAt: new Date(Date.now() + 3_600_000),
    });
    db.restaurantSopVerification.create.mockResolvedValue({ id: 'ver_1', createdAt: new Date() });
    db.restaurantCoAuthorization.create.mockResolvedValue({ id: 'coauth_1' });
    db.restaurantSopEvidence.createMany.mockResolvedValue({ count: 1 });
    db.restaurantSopEvidence.findFirst.mockResolvedValue({
      id: 'ev_1',
      contentHash: EVIDENCE_INPUT.contentHashHex,
      createdAt: new Date(),
    });
    db.restaurantSopEscalationEvent.findFirst.mockResolvedValue(null);
    db.restaurantSopEscalationEvent.create.mockResolvedValue({ id: 'evt_1' });
  }

  const EVIDENCE_INPUT = {
    occurrenceId: OCC_ID,
    contentHashHex: 'a'.repeat(64),
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
  };
  const WAIVE_INPUT = {
    occurrenceId: OCC_ID,
    actorStaffProfileId: 'staff_a',
    approvingStaffProfileId: 'staff_b',
    approvingType: 'PIN' as const,
    approvingSecret: '4821',
    reason: 'Emergency',
  };

  beforeEach(primeHappyPath);

  // ── Entry tier: execution only ──────────────────────────────────────────────

  describe('an organization licensed for execution only', () => {
    it('may read the branch board and run an occurrence', async () => {
      db.restaurantSopOccurrence.findMany.mockResolvedValue([]);
      await expect(caller(ESSENTIALS).listOccurrences({ branchId: 'branch_1' })).resolves.toEqual({
        items: [],
        nextCursor: null,
      });

      db.restaurantSopOccurrence.findUnique.mockResolvedValue({
        id: OCC_ID,
        assignedStaffProfileId: 'staff_a',
        poolJobRoleId: null,
        claimedByStaffProfileId: null,
        branchId: 'branch_1',
        status: 'SCHEDULED',
      });
      await expect(caller(ESSENTIALS).start({ occurrenceId: OCC_ID })).resolves.toMatchObject({
        status: 'IN_PROGRESS',
      });
    });

    it('is refused evidence capture', async () => {
      await expect(caller(ESSENTIALS).attachEvidence(EVIDENCE_INPUT)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it.each([['verify'], ['reject']] as const)('is refused %s', async (command) => {
      await expect(caller(ESSENTIALS)[command]({ occurrenceId: OCC_ID })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('is refused a co-authorized waiver', async () => {
      await expect(caller(ESSENTIALS).waive(WAIVE_INPUT)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('is refused escalation acknowledgement', async () => {
      await expect(caller(ESSENTIALS).acknowledge({ occurrenceId: OCC_ID })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('refuses BEFORE touching the database', async () => {
      db.restaurantSopVerification.create.mockClear();
      await expect(caller(ESSENTIALS).verify({ occurrenceId: OCC_ID })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(db.restaurantSopVerification.create).not.toHaveBeenCalled();
      expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
    });

    it('explains the denial with catalog keys and never a package name', async () => {
      let message = '';
      try {
        await caller(ESSENTIALS).acknowledge({ occurrenceId: OCC_ID });
        throw new Error('Expected the entitlement gate to refuse.');
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('restaurant-integrations');
      expect(message).toContain('integrations.connections.max');
      expect(message).not.toContain('essentials');
      expect(message).not.toContain('Essentials');
      expect(message).not.toContain('Operations');
      expect(message).not.toContain('Enterprise');
    });
  });

  // ── Adjacent tier: the proof/verification family ────────────────────────────

  describe('the adjacent tier that adds proof and verification', () => {
    it('may capture evidence', async () => {
      await expect(caller(OPERATIONS).attachEvidence(EVIDENCE_INPUT)).resolves.toMatchObject({
        evidenceId: 'ev_1',
        created: true,
      });
      expect(db.restaurantSopEvidence.createMany).toHaveBeenCalledWith({
        data: expect.objectContaining({
          occurrenceId: OCC_ID,
          contentHash: EVIDENCE_INPUT.contentHashHex,
        }),
        skipDuplicates: true,
      });
    });

    it('may verify, reject and waive', async () => {
      await expect(caller(OPERATIONS).verify({ occurrenceId: OCC_ID })).resolves.toMatchObject({
        action: 'VERIFY',
      });
      await expect(caller(OPERATIONS).reject({ occurrenceId: OCC_ID })).resolves.toMatchObject({
        action: 'REJECT',
      });
      await expect(caller(OPERATIONS).waive(WAIVE_INPUT)).resolves.toMatchObject({
        action: 'WAIVE',
      });
    });

    it('may acknowledge an escalation', async () => {
      await expect(caller(OPERATIONS).acknowledge({ occurrenceId: OCC_ID })).resolves.toMatchObject(
        { occurrenceId: OCC_ID }
      );
    });
  });

  // ── Deepest tier keeps everything the tier below has ────────────────────────

  it('the deepest tier retains every command the tier below holds', async () => {
    await expect(caller(ENTERPRISE).attachEvidence(EVIDENCE_INPUT)).resolves.toBeTruthy();
    await expect(caller(ENTERPRISE).verify({ occurrenceId: OCC_ID })).resolves.toBeTruthy();
    await expect(caller(ENTERPRISE).waive(WAIVE_INPUT)).resolves.toBeTruthy();
    await expect(caller(ENTERPRISE).acknowledge({ occurrenceId: OCC_ID })).resolves.toBeTruthy();
  });

  // ── Module boundary ─────────────────────────────────────────────────────────

  it('refuses even bare execution when the SOP module is disabled', async () => {
    const withoutSop = {
      ...ENTERPRISE,
      enabledModules: ENTERPRISE.enabledModules.filter((key) => key !== 'restaurant-sop'),
    };
    db.restaurantSopOccurrence.findMany.mockResolvedValue([]);
    await expect(
      caller(withoutSop).listOccurrences({ branchId: 'branch_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(withoutSop).start({ occurrenceId: OCC_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  // ── Tenant boundary ─────────────────────────────────────────────────────────

  it('decides from the calling organization own entitlements, not another tenant', async () => {
    // Same process, same db, two organizations on different licensing. Neither
    // caller can borrow the other's depth.
    const deepTenant = caller(ENTERPRISE);
    const shallowTenant = caller(ESSENTIALS);

    await expect(deepTenant.verify({ occurrenceId: OCC_ID })).resolves.toMatchObject({
      action: 'VERIFY',
    });
    await expect(shallowTenant.verify({ occurrenceId: OCC_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // …and the deep tenant acting again is still allowed: the shallow tenant's
    // denial did not leak into shared state.
    await expect(deepTenant.verify({ occurrenceId: OCC_ID })).resolves.toMatchObject({
      action: 'VERIFY',
    });
  });

  // ── Entitlement and authorization are independent gates ─────────────────────

  it('still requires the capability when the organization is fully entitled', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller(ENTERPRISE).verify({ occurrenceId: OCC_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('still requires the entitlement when the caller holds the capability', async () => {
    mocks.can.mockResolvedValue(true);
    await expect(caller(ESSENTIALS).verify({ occurrenceId: OCC_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('authenticated SOP identity boundary', () => {
  function occurrence(status = 'IN_PROGRESS') {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status,
      assignedStaffProfileId: 'staff_a',
      poolJobRoleId: null,
      claimedByStaffProfileId: null,
      branchId: 'branch_1',
      windowEndsAt: new Date(Date.now() + 3600000),
    });
  }

  it('cannot start another operator occurrence by supplying its owner ID', async () => {
    occurrence('SCHEDULED');
    db.restaurantStaffProfile.findMany.mockResolvedValue([{ id: 'attacker' }]);
    await expect(
      caller().start({ occurrenceId: OCC_ID, actorStaffProfileId: 'staff_a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
    expect(db.restaurantStaffProfile.findMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', organizationId: 'org_1', status: 'ACTIVE' },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        primaryBranchId: true,
        jobRoles: {
          where: { branchId: 'branch_1', jobRole: { active: true } },
          select: { jobRoleId: true },
        },
      },
    });
  });

  it("acts as a multi-branch employee's profile at the occurrence branch", async () => {
    occurrence('SCHEDULED');
    db.restaurantStaffProfile.findMany.mockResolvedValue([
      { id: 'staff_0_other_branch', primaryBranchId: 'branch_2', jobRoles: [] },
      { id: 'staff_a', primaryBranchId: 'branch_1', jobRoles: [] },
    ]);
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, startedAt: new Date() });
    await expect(caller().start({ occurrenceId: OCC_ID })).resolves.toMatchObject({
      status: 'IN_PROGRESS',
    });
  });

  it('records a multi-branch verifier as their profile at the occurrence branch', async () => {
    occurrence('SUBMITTED');
    db.restaurantStaffProfile.findMany.mockResolvedValue([
      { id: 'staff_0_other_branch', primaryBranchId: 'branch_2', jobRoles: [] },
      { id: 'staff_here', primaryBranchId: null, jobRoles: [{ jobRoleId: 'role_1' }] },
    ]);
    await caller().verify({ occurrenceId: OCC_ID });
    expect(db.restaurantSopVerification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actorStaffProfileId: 'staff_here' }),
      })
    );
  });

  it.each(['completeStep', 'submit'] as const)(
    'cannot %s another operator work with a forged actor',
    async (command) => {
      occurrence();
      db.restaurantStaffProfile.findMany.mockResolvedValue([{ id: 'attacker' }]);
      const input = {
        occurrenceId: OCC_ID,
        actorStaffProfileId: 'staff_a',
        templateStepId: 'step',
      };
      await expect(
        command === 'completeStep'
          ? caller().completeStep(input)
          : caller().submit({ occurrenceId: OCC_ID, actorStaffProfileId: 'staff_a' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
      expect(db.restaurantSopOccurrenceStep.update).not.toHaveBeenCalled();
    }
  );

  it.each(['verify', 'reject', 'acknowledge'] as const)(
    'attributes %s to the session despite forged actor input',
    async (command) => {
      occurrence('SUBMITTED');
      await caller()[command]({ occurrenceId: OCC_ID, actorStaffProfileId: 'victim' });
      const delegate =
        command === 'acknowledge' ? db.restaurantSopEscalationEvent : db.restaurantSopVerification;
      expect(delegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actorStaffProfileId: 'staff_a' }),
        })
      );
    }
  );

  it('attributes evidence to the session despite a forged uploader', async () => {
    occurrence();
    db.restaurantSopEvidence.findFirst.mockResolvedValue({
      id: 'proof',
      contentHash: 'a'.repeat(64),
      createdAt: new Date(),
    });
    await caller().attachEvidence({
      occurrenceId: OCC_ID,
      uploaderStaffProfileId: 'victim',
      contentHashHex: 'a'.repeat(64),
      mimeType: 'image/jpeg',
      sizeBytes: 1,
    });
    expect(db.restaurantSopEvidence.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ uploaderStaffProfileId: 'staff_a' }),
      })
    );
  });

  it('DEV-837: stores procedure-supplied proof metadata as not server-captured', async () => {
    occurrence();
    db.restaurantSopEvidence.findFirst.mockResolvedValue({
      id: 'claim',
      contentHash: 'a'.repeat(64),
      createdAt: new Date(),
      serverCaptured: false,
    });
    await caller().attachEvidence({
      occurrenceId: OCC_ID,
      contentHashHex: 'a'.repeat(64),
      mimeType: 'image/jpeg; evidence=signature',
      sizeBytes: 0,
      storageRef: '/api/files/company-logo.png',
    });
    expect(db.restaurantSopEvidence.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          serverCaptured: false,
          storageRef: '/api/files/company-logo.png',
        }),
      })
    );
  });

  it('DEV-837: refuses a caller claim that its proof was server-captured', async () => {
    occurrence();
    await expect(
      caller().attachEvidence({
        occurrenceId: OCC_ID,
        contentHashHex: 'a'.repeat(64),
        mimeType: 'image/jpeg; evidence=photo',
        sizeBytes: 10,
        storageRef: '/api/files/sop-forged.jpg',
        serverCaptured: true,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.restaurantSopEvidence.createMany).not.toHaveBeenCalled();
  });

  it.each([{ profiles: [] }, { profiles: [{ id: 'a' }, { id: 'b' }] }])(
    'fails closed without a unique active session staff profile',
    async ({ profiles }) => {
      occurrence('SCHEDULED');
      db.restaurantStaffProfile.findMany.mockResolvedValue(profiles);
      await expect(
        caller().start({ occurrenceId: OCC_ID, actorStaffProfileId: 'staff_a' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
    }
  );

  const waiver = {
    occurrenceId: OCC_ID,
    actorStaffProfileId: 'victim',
    approvingStaffProfileId: 'staff_b',
    approvingType: 'PIN' as const,
    approvingSecret: '4821',
    reason: 'Emergency',
  };

  it.each(['INVALID', 'LOCKED', 'REVOKED'])(
    'does not persist waiver on %s credential',
    async (reason) => {
      occurrence('MISSED');
      mocks.authenticateOperator.mockResolvedValue({ ok: false, reason });
      await expect(caller().waive(waiver)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Approving credential is invalid or locked.',
      });
      expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
      expect(db.restaurantSopVerification.create).not.toHaveBeenCalled();
      expect(mocks.annotateAudit).toHaveBeenCalledWith(expect.anything(), { skipInput: true });
    }
  );

  it('requires branch-specific approver permission after credential verification', async () => {
    occurrence('MISSED');
    mocks.operatorHasCapability.mockResolvedValue(false);
    await expect(caller().waive(waiver)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.operatorHasCapability).toHaveBeenCalledWith(
      db,
      'staff_b',
      'sop:verify',
      expect.any(Date),
      'branch_1'
    );
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });

  it('locks credential rows before checking approval in an independent tenant transaction', async () => {
    occurrence('MISSED');
    await caller().waive(waiver);
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      'staff_b',
      'PIN'
    );
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
    expect(withTenantDb).toHaveBeenCalledWith('org_1', expect.any(Function));
  });

  it('records the session actor and credential-verified approving identity', async () => {
    occurrence('MISSED');
    await caller().waive(waiver);
    expect(mocks.authenticateOperator).toHaveBeenCalledWith(db, {
      staffProfileId: 'staff_b',
      type: 'PIN',
      secret: '4821',
      now: expect.any(Date),
      approval: {
        action: 'restaurant.backOfficeApproval.sop:verify',
        requestedByStaffProfileId: 'staff_a',
      },
    });
    expect(db.restaurantCoAuthorization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actingStaffProfileId: 'staff_a',
          approvingStaffProfileId: 'staff_b',
        }),
      })
    );
  });

  it('rejects ID-only approval without credential proof', async () => {
    const { approvingSecret, ...withoutSecret } = waiver;
    void approvingSecret;
    await expect(caller().waive(withoutSecret as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });
});

describe('authenticated SOP identities', () => {
  it.each(['start', 'completeStep', 'submit', 'attachEvidence'] as const)(
    '%s cannot impersonate the occurrence owner',
    async (command) => {
      db.restaurantSopOccurrence.findUnique.mockResolvedValue({
        id: OCC_ID,
        branchId: 'branch_1',
        status: 'IN_PROGRESS',
        assignedStaffProfileId: 'victim',
        claimedByStaffProfileId: null,
        poolJobRoleId: null,
      });
      const input = {
        occurrenceId: OCC_ID,
        actorStaffProfileId: 'victim',
        templateStepId: 'step',
        contentHashHex: 'a'.repeat(64),
        mimeType: 'image/jpeg',
        sizeBytes: 1,
      };
      const payload =
        command === 'completeStep'
          ? { occurrenceId: OCC_ID, templateStepId: 'step', actorStaffProfileId: 'victim' }
          : command === 'attachEvidence'
            ? {
                occurrenceId: OCC_ID,
                contentHashHex: input.contentHashHex,
                mimeType: input.mimeType,
                sizeBytes: 1,
                uploaderStaffProfileId: 'victim',
              }
            : { occurrenceId: OCC_ID, actorStaffProfileId: 'victim' };
      await expect(caller()[command](payload as never)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
      expect(db.restaurantSopEvidence.createMany).not.toHaveBeenCalled();
    }
  );

  it.each([{ profiles: [] }, { profiles: [{ id: 'one' }, { id: 'two' }] }])(
    'rejects absent or ambiguous session staff: %j',
    async ({ profiles }) => {
      db.restaurantSopOccurrence.findUnique.mockResolvedValue({
        id: OCC_ID,
        branchId: 'branch_1',
        status: 'SCHEDULED',
        assignedStaffProfileId: 'victim',
        claimedByStaffProfileId: null,
        poolJobRoleId: null,
      });
      db.restaurantStaffProfile.findMany.mockResolvedValue(profiles);
      await expect(
        caller().start({ occurrenceId: OCC_ID, actorStaffProfileId: 'victim' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
    }
  );

  it.each(['verify', 'reject', 'acknowledge'] as const)(
    '%s records the session staff, ignoring forged identity',
    async (command) => {
      db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SUBMITTED' });
      await caller()[command]({ occurrenceId: OCC_ID, actorStaffProfileId: 'victim' });
      const delegate =
        command === 'acknowledge' ? db.restaurantSopEscalationEvent : db.restaurantSopVerification;
      expect(delegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actorStaffProfileId: 'staff_a' }),
        })
      );
      expect(db.restaurantStaffProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user_1', organizationId: 'org_1', status: 'ACTIVE' },
          take: 2,
        })
      );
    }
  );

  const waiver = {
    occurrenceId: OCC_ID,
    actorStaffProfileId: 'victim',
    approvingStaffProfileId: 'staff_b',
    approvingType: 'PIN' as const,
    approvingSecret: 'test-pin',
    reason: 'Emergency',
  };

  it('refuses ID-only approval', async () => {
    const input: Partial<typeof waiver> = { ...waiver };
    delete input.approvingSecret;
    await expect(caller().waive(input as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });

  it.each(['INVALID', 'LOCKED'] as const)(
    'refuses %s credentials without waiver writes',
    async (reason) => {
      db.restaurantSopOccurrence.findUnique.mockResolvedValue({
        id: OCC_ID,
        status: 'MISSED',
        branchId: 'branch_1',
      });
      mocks.authenticateOperator.mockResolvedValue({ ok: false, reason });
      await expect(caller().waive(waiver)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Approving credential is invalid or locked.',
      });
      expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
      expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
    }
  );

  it('requires approver capability at the occurrence branch', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'MISSED',
      branchId: 'branch_1',
    });
    mocks.operatorHasCapability.mockResolvedValue(false);
    await expect(caller().waive(waiver)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.operatorHasCapability).toHaveBeenCalledWith(
      db,
      'staff_b',
      'sop:verify',
      expect.any(Date),
      'branch_1'
    );
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });

  it('preserves waiver with credential-proven approval and session attribution', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'MISSED',
      branchId: 'branch_1',
    });
    await caller().waive(waiver);
    expect(mocks.authenticateOperator).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        staffProfileId: 'staff_b',
        type: 'PIN',
        secret: 'test-pin',
        now: expect.any(Date),
      })
    );
    expect(db.restaurantCoAuthorization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actingStaffProfileId: 'staff_a',
          approvingStaffProfileId: 'staff_b',
        }),
      })
    );
    expect(mocks.annotateAudit).toHaveBeenCalledWith(expect.anything(), { skipInput: true });
  });
});

// ── PR #289 review: cursor, mutation scope, profile resolution ────────────────

describe('execution scoping hardening', () => {
  const operatorOnly = async (...args: unknown[]) => args[1] === 'sop:complete';

  it('a cursor never overrides the deny-all filter for a caller without a staff profile', async () => {
    mocks.can.mockImplementation(operatorOnly);
    // Branch-assigned (in scope) but no active staff profile.
    db.restaurantBranchAssignment.findFirst.mockResolvedValue({ id: 'assign_1' });
    db.restaurantStaffProfile.findFirst.mockResolvedValue(null);

    await caller().listOccurrences({ branchId: 'branch_1', cursor: '0' });

    const args = db.restaurantSopOccurrence.findMany.mock.calls[0][0];
    expect(args.where.id).toEqual({ in: [] });
    expect(args.cursor).toEqual({ id: '0' });
    expect(args.skip).toBe(1);
  });

  it('paginates with a Prisma cursor so (dueAt, id) ordering is respected', async () => {
    await caller().listOccurrences({ branchId: 'branch_1', cursor: 'o49' });
    const args = db.restaurantSopOccurrence.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ dueAt: 'asc' }, { id: 'asc' }]);
    expect(args.cursor).toEqual({ id: 'o49' });
    expect(args.where).not.toHaveProperty('id');
  });

  it('prefers the active staff profile whose primary branch is the requested branch', async () => {
    mocks.can.mockImplementation(operatorOnly);
    db.restaurantStaffProfile.findFirst.mockImplementation(async ({ where }) =>
      where.primaryBranchId === 'branch_1'
        ? { id: 'staff_here', jobRoles: [{ jobRoleId: 'role_1' }] }
        : { id: 'staff_elsewhere', jobRoles: [] }
    );

    await caller().listOccurrences({ branchId: 'branch_1' });
    expect(db.restaurantSopOccurrence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { assignedStaffProfileId: 'staff_here' },
            { claimedByStaffProfileId: 'staff_here' },
            { poolJobRoleId: { in: ['role_1'] }, claimedByStaffProfileId: null },
          ],
        }),
      })
    );
  });

  it('marks only pool rows for a role the caller holds as claimable', async () => {
    mocks.can.mockImplementation(operatorOnly);
    db.restaurantStaffProfile.findFirst.mockResolvedValue({
      id: 'staff_1',
      jobRoles: [{ jobRoleId: 'role_1' }],
    });
    const base = {
      businessDate: new Date(),
      dueAt: new Date(),
      windowEndsAt: new Date(),
      startedAt: null,
      submittedAt: null,
      resolvedAt: null,
      assignedStaffProfileId: null,
      claimedByStaffProfileId: null,
      assignment: { id: 'a1', template: { id: 't1', name: 'x', category: null } },
      steps: [],
    };
    db.restaurantSopOccurrence.findMany.mockResolvedValue([
      { ...base, id: 'mine', status: 'SCHEDULED', poolJobRoleId: 'role_1' },
      { ...base, id: 'other', status: 'SCHEDULED', poolJobRoleId: 'role_2' },
      { ...base, id: 'started', status: 'IN_PROGRESS', poolJobRoleId: 'role_1' },
    ]);

    const result = await caller().listOccurrences({ branchId: 'branch_1' });
    expect(result.items.map((item) => [item.id, item.canClaim])).toEqual([
      ['mine', true],
      ['other', false],
      ['started', false],
    ]);
  });

  it('refuses an operator acting as another staff profile', async () => {
    mocks.can.mockImplementation(operatorOnly);
    db.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'staff_b', jobRoles: [] });
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      branchId: 'branch_1',
      status: 'IN_PROGRESS',
      assignedStaffProfileId: null,
      claimedByStaffProfileId: 'staff_b',
      poolJobRoleId: 'role_1',
      windowEndsAt: new Date(Date.now() + 3_600_000),
      steps: [],
    });

    await expect(
      caller().submit({ occurrenceId: OCC_ID, actorStaffProfileId: 'staff_a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
  });

  it.each(['start', 'completeStep', 'submit', 'attachEvidence'] as const)(
    'hides an occurrence the operator cannot see from %s',
    async (command) => {
      mocks.can.mockImplementation(operatorOnly);
      db.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'staff_b', jobRoles: [] });
      db.restaurantSopOccurrence.findUnique.mockResolvedValue({
        id: OCC_ID,
        branchId: 'branch_1',
        status: 'SCHEDULED',
        assignedStaffProfileId: null,
        claimedByStaffProfileId: 'staff_a',
        poolJobRoleId: 'role_1',
      });
      const inputs = {
        start: { occurrenceId: OCC_ID, actorStaffProfileId: 'staff_a' },
        completeStep: {
          occurrenceId: OCC_ID,
          templateStepId: 'step_1',
          actorStaffProfileId: 'staff_a',
        },
        submit: { occurrenceId: OCC_ID, actorStaffProfileId: 'staff_a' },
        attachEvidence: {
          occurrenceId: OCC_ID,
          contentHashHex: 'a'.repeat(64),
          mimeType: 'image/jpeg',
          sizeBytes: 1,
          uploaderStaffProfileId: 'staff_a',
        },
      };

      await expect(
        (caller()[command] as unknown as (input: unknown) => Promise<unknown>)(inputs[command])
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
      expect(db.restaurantSopEvidence.createMany).not.toHaveBeenCalled();
    }
  );

  it('returns NOT_FOUND (not FORBIDDEN) for an out-of-branch mutation or read', async () => {
    mocks.can.mockImplementation(operatorOnly);
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      branchId: 'branch_2',
      status: 'SCHEDULED',
      assignedStaffProfileId: 'staff_a',
      claimedByStaffProfileId: null,
      poolJobRoleId: null,
    });

    await expect(caller().getOccurrence({ id: OCC_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      caller().start({ occurrenceId: OCC_ID, actorStaffProfileId: 'staff_a' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.restaurantSopOccurrence.update).not.toHaveBeenCalled();
  });

  it('binds the actor to the session staff profile when none is supplied', async () => {
    mocks.can.mockImplementation(operatorOnly);
    db.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'staff_a', jobRoles: [] });
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      branchId: 'branch_1',
      status: 'SCHEDULED',
      assignedStaffProfileId: 'staff_a',
      claimedByStaffProfileId: null,
      poolJobRoleId: null,
    });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, startedAt: new Date() });

    await expect(caller().start({ occurrenceId: OCC_ID })).resolves.toMatchObject({
      status: 'IN_PROGRESS',
    });
  });
});
