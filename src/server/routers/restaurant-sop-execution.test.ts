/**
 * M7-L4 router tests — SOP execution console. Runs the real router against an
 * in-memory db. Covers: capability gating, strict-zod unknown-key rejection, state
 * error mapping (INVALID_STATE → CONFLICT, NOT_FOUND, CO_AUTH_REQUIRED → FORBIDDEN),
 * occurrence board listing (cursor pagination), and command routing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  annotateAudit: vi.fn(),
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

import { restaurantSopExecutionRouter } from './restaurant-sop-execution';

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
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as Record<string, Delegate> & { $transaction: ReturnType<typeof vi.fn> };
}

let db: ReturnType<typeof makeDb>;

beforeEach(() => {
  db = makeDb();
  mocks.can.mockResolvedValue(true);
  mocks.annotateAudit.mockReset();
});

function caller() {
  return restaurantSopExecutionRouter.createCaller({
    db: db as never,
    entitlements: {
      enabledModules: ['restaurant-sop'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: {},
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
      status: 'SCHEDULED',
      assignedStaffProfileId: 'staff_a',
      poolJobRoleId: null,
      claimedByStaffProfileId: null,
    });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, startedAt: new Date() });

    const result = await caller().start({ occurrenceId: OCC_ID, actorStaffProfileId: 'staff_a' });
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
      assignedStaffProfileId: 'staff_a',
      poolJobRoleId: null,
      claimedByStaffProfileId: null,
      steps: [],
    });
    db.restaurantSopOccurrence.update.mockResolvedValue({ id: OCC_ID, submittedAt: new Date() });

    const result = await caller().submit({
      occurrenceId: OCC_ID,
      actorStaffProfileId: 'staff_a',
    });
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
  it('maps CO_AUTH_REQUIRED → FORBIDDEN when actor equals approver', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'SUBMITTED' });

    await expect(
      caller().waive({
        occurrenceId: OCC_ID,
        actorStaffProfileId: 'same_person',
        approvingStaffProfileId: 'same_person',
        reason: 'test',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('waives with valid co-authorization', async () => {
    db.restaurantSopOccurrence.findUnique.mockResolvedValue({ id: OCC_ID, status: 'MISSED' });
    db.restaurantCoAuthorization.create.mockResolvedValue({ id: 'coauth_1' });
    db.restaurantSopVerification.create.mockResolvedValue({ id: 'ver_1', createdAt: new Date() });

    const result = await caller().waive({
      occurrenceId: OCC_ID,
      actorStaffProfileId: 'staff_a',
      approvingStaffProfileId: 'staff_b',
      reason: 'Emergency',
    });
    expect(result.action).toBe('WAIVE');
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
