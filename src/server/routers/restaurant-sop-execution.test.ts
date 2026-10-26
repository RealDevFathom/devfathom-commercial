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
  recordTrpcAudit: vi.fn(),
  authenticateOperator: vi.fn(),
  staffHasCapability: vi.fn(async () => true),
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
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: mocks.recordTrpcAudit,
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  authenticateOperator: mocks.authenticateOperator,
}));
vi.mock('@/lib/restaurant/job-roles', () => ({
  staffHasCapability: mocks.staffHasCapability,
}));

import { restaurantSopExecutionRouter } from './restaurant-sop-execution';
import { packageByKey } from '@/lib/vertical-catalog';
import { router } from '../trpc';

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
    restaurantBranchAssignment: model(),
    restaurantBranch: Object.assign(model(), {
      findMany: vi.fn(async (args?: { where?: { id?: { in?: string[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({ id }))
      ),
    }),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as Record<string, Delegate> & { $transaction: ReturnType<typeof vi.fn> };
}

let db: ReturnType<typeof makeDb>;

beforeEach(() => {
  vi.clearAllMocks();
  db = makeDb();
  db.restaurantStaffProfile.findMany.mockResolvedValue([{ id: 'staff_a' }]);
  mocks.can.mockResolvedValue(true);
  mocks.annotateAudit.mockReset();
  mocks.authenticateOperator.mockResolvedValue({
    ok: true,
    credentialId: 'credential_1',
    staffProfileId: 'staff_b',
  });
  mocks.staffHasCapability.mockResolvedValue(true);
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
        approving: { staffProfileId: 'b', type: 'PIN', secret: '1234' },
        reason: 'r',
        extra: true,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('suppresses a waiver credential before malformed input can be audited', async () => {
    const context = {
      db: db as never,
      entitlements: { organizationId: 'org_1', ...FULL_ENTITLEMENTS },
      session: {
        expires: 'later',
        user: { id: 'user_1', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
      },
      organization: null,
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as never;
    const app = router({ restaurantSopExecution: restaurantSopExecutionRouter });
    const recognizableSecret = 'PIN-DO-NOT-AUDIT-819';

    await expect(
      app.createCaller(context).restaurantSopExecution.waive({
        occurrenceId: OCC_ID,
        approving: { staffProfileId: 'b', type: 'PIN', secret: recognizableSecret },
        reason: 'r',
        extra: true,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'restaurantSopExecution.waive',
        input: undefined,
        outcome: 'FAILURE',
      })
    );
    expect(JSON.stringify(mocks.recordTrpcAudit.mock.calls)).not.toContain(recognizableSecret);
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
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SCHEDULED' });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, startedAt: new Date() });

    const result = await caller().start({ occurrenceId: OCC_ID });
    expect(result.status).toBe('IN_PROGRESS');
    expect(mocks.annotateAudit).toHaveBeenCalled();
  });

  it('maps INVALID_STATE → CONFLICT', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SUBMITTED' });

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
      status: 'IN_PROGRESS',
      windowEndsAt: new Date(Date.now() + 3_600_000),
    });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, submittedAt: new Date() });

    const result = await caller().submit({ occurrenceId: OCC_ID });
    expect(result.status).toBe('SUBMITTED');
  });
});

// ── verify command ─────────────────────────────────────────────────────────────

describe('verify', () => {
  it('verifies a SUBMITTED occurrence', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SUBMITTED' });
    db.restaurantSopVerification.create.mockResolvedValue({ id: 'ver_1', createdAt: new Date() });

    const result = await caller().verify({ occurrenceId: OCC_ID });
    expect(result.action).toBe('VERIFY');
  });
});

// ── waive command ──────────────────────────────────────────────────────────────

describe('waive', () => {
  it('returns a refusal so an invalid credential attempt can commit its lockout update', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'SUBMITTED',
      branchId: 'branch_1',
    });
    mocks.authenticateOperator.mockResolvedValue({ ok: false, reason: 'INVALID' });

    await expect(
      caller().waive({
        occurrenceId: OCC_ID,
        approving: { staffProfileId: 'invented_staff', type: 'PIN', secret: '1234' },
        reason: 'test',
      })
    ).resolves.toEqual({ blocked: 'Waiver authorization failed.' });
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).toHaveBeenCalledWith(expect.anything(), { skipInput: true });
    expect(mocks.authenticateOperator).toHaveBeenCalledWith(db, {
      staffProfileId: 'invented_staff',
      type: 'PIN',
      secret: '1234',
      now: expect.any(Date),
    });
  });

  it('refuses same-person approval', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ branchId: 'branch_1' });
    mocks.authenticateOperator.mockResolvedValue({
      ok: true,
      credentialId: 'credential_1',
      staffProfileId: 'staff_a',
    });

    await expect(
      caller().waive({
        occurrenceId: OCC_ID,
        approving: { staffProfileId: 'staff_a', type: 'PIN', secret: '1234' },
        reason: 'test',
      })
    ).resolves.toHaveProperty('blocked');
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });

  it('refuses an approver without branch verification capability', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ branchId: 'branch_1' });
    mocks.staffHasCapability.mockResolvedValue(false);

    await expect(
      caller().waive({
        occurrenceId: OCC_ID,
        approving: { staffProfileId: 'staff_b', type: 'PIN', secret: '1234' },
        reason: 'test',
      })
    ).resolves.toHaveProperty('blocked');
    expect(mocks.staffHasCapability).toHaveBeenCalledWith(
      db,
      'staff_b',
      'branch_1',
      'sop:verify'
    );
  });

  it.each([[], [{ id: 'staff_a' }, { id: 'staff_duplicate' }]])(
    'refuses when the session user does not resolve to exactly one active staff profile',
    async (profiles) => {
      db.restaurantStaffProfile.findMany.mockResolvedValue(profiles);
      db.restaurantSopOccurrence.findUnique.mockResolvedValue({ branchId: 'branch_1' });

      await expect(
        caller().waive({
          occurrenceId: OCC_ID,
          approving: { staffProfileId: 'staff_b', type: 'PIN', secret: '1234' },
          reason: 'test',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.authenticateOperator).not.toHaveBeenCalled();
    }
  );

  it('refuses malformed credentials without invoking bcrypt authentication', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ branchId: 'branch_1' });

    await expect(
      caller().waive({
        occurrenceId: OCC_ID,
        approving: { staffProfileId: 'staff_b', type: 'PIN', secret: '12ab' },
        reason: 'test',
      })
    ).resolves.toEqual({ blocked: 'Waiver authorization failed.' });
    expect(mocks.authenticateOperator).not.toHaveBeenCalled();
  });

  it('waives with valid co-authorization', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({
      id: OCC_ID,
      status: 'MISSED',
      branchId: 'branch_1',
    });
    db.restaurantCoAuthorization.create.mockResolvedValue({ id: 'coauth_1' });
    db.restaurantSopVerification.create.mockResolvedValue({ id: 'ver_1', createdAt: new Date() });

    const result = await caller().waive({
      occurrenceId: OCC_ID,
      approving: { staffProfileId: 'staff_b', type: 'PIN', secret: '1234' },
      reason: 'Emergency',
    });
    expect(result.action).toBe('WAIVE');
    expect(db.restaurantSopVerification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorStaffProfileId: 'staff_a' }) })
    );
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
    approving: { staffProfileId: 'staff_b', type: 'PIN' as const, secret: '1234' },
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

      db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SCHEDULED' });
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
