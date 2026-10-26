import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Router coverage for all 15 `restaurantShifts` procedures.
 *
 * Roster CRUD (`list/create/update/cancel`) mocks the already-tested shifts lib
 * and asserts the router's own guarantees: capability + branch scope, the roster
 * advisory lock, the append-only shift event, and the error mapping. Workforce
 * procedures run the REAL `@/lib/restaurant/workforce` against an in-memory
 * fake that evaluates the where-clauses it is given, so idempotent replays,
 * attendance status and the payroll CSV are exercised end to end through tRPC.
 * RLS/tenant isolation needs real PostgreSQL and is out of scope here.
 */

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  annotateAudit: vi.fn(),
  listShifts: vi.fn(),
  createShift: vi.fn(),
  updateShift: vi.fn(),
  cancelShift: vi.fn(),
  resolveStaffCapabilities: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn((entitlements: { enabledModules: string[] }, key: string) =>
    entitlements.enabledModules.includes(key)
  ),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/restaurant/job-roles', () => ({
  resolveStaffCapabilities: mocks.resolveStaffCapabilities,
}));
vi.mock('@/lib/restaurant/shifts', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/restaurant/shifts')>('@/lib/restaurant/shifts');
  return {
    ...actual,
    listShifts: mocks.listShifts,
    createShift: mocks.createShift,
    updateShift: mocks.updateShift,
    cancelShift: mocks.cancelShift,
  };
});

import { ShiftError } from '@/lib/restaurant/shifts';
import type { TRPCContext } from '../trpc';
import { restaurantShiftsRouter } from './restaurant-shifts';

// ---------------------------------------------------------------------------
// Actors. OWNER holds restaurant:configure (organization-wide); MANAGER holds
// staff:manage only through a job role in branch_1; EMPLOYEE holds neither.
// ---------------------------------------------------------------------------

type Actor = 'OWNER' | 'MANAGER' | 'EMPLOYEE' | 'OTHER_EMPLOYEE' | 'NO_PROFILE';

const USERS: Record<Actor, string> = {
  OWNER: 'user_owner',
  MANAGER: 'user_mgr',
  EMPLOYEE: 'user_emp',
  OTHER_EMPLOYEE: 'user_other',
  NO_PROFILE: 'user_ghost',
};

const POLICY: Record<string, Set<string>> = {
  user_owner: new Set(['restaurant:configure', 'staff:manage']),
  user_mgr: new Set(['staff:manage']),
};

type Profile = {
  id: string;
  userId: string;
  organizationId: string;
  displayName: string;
  status: 'ACTIVE' | 'SUSPENDED';
  primaryBranchId: string | null;
  jobRoles: { branchId: string }[];
  directCapabilityGrants: { branchId: string }[];
};

type ShiftRow = {
  id: string;
  version: number;
  organizationId: string;
  branchId: string;
  staffProfileId: string;
  businessDate: Date;
  startAt: Date;
  endAt: Date;
  role: string | null;
  notes: string | null;
  status: 'SCHEDULED' | 'CANCELLED';
  cancelledAt: Date | null;
  cancelReason: string | null;
  clockedInAt: Date | null;
  clockedOutAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type Comparator = { lt?: Date; lte?: Date; gt?: Date; gte?: Date };

const BRANCHES = {
  branch_1: { id: 'branch_1', name: 'Gulberg Main', timezone: 'Asia/Karachi' },
  branch_2: { id: 'branch_2', name: 'DHA Phase 6', timezone: 'Asia/Karachi' },
} as const;

function at(iso: string) {
  return new Date(iso);
}

function matchesComparator(value: Date | null, comparator: Comparator) {
  if (!value) return false;
  const t = value.getTime();
  if (comparator.lt && !(t < comparator.lt.getTime())) return false;
  if (comparator.lte && !(t <= comparator.lte.getTime())) return false;
  if (comparator.gt && !(t > comparator.gt.getTime())) return false;
  if (comparator.gte && !(t >= comparator.gte.getTime())) return false;
  return true;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}) {
  return Object.entries(where).every(([field, condition]) => {
    if (condition === undefined) return true;
    if (condition === null) return row[field] === null || row[field] === undefined;
    if (condition instanceof Date) return (row[field] as Date)?.getTime() === condition.getTime();
    if (typeof condition === 'object') {
      const c = condition as Record<string, unknown>;
      if ('not' in c) return row[field] !== c.not;
      return matchesComparator(row[field] as Date | null, c as Comparator);
    }
    return row[field] === condition;
  });
}

function makeState() {
  const profiles: Profile[] = [
    {
      id: 'staff_owner',
      userId: USERS.OWNER,
      organizationId: 'org_a',
      displayName: 'Owner',
      status: 'ACTIVE',
      primaryBranchId: 'branch_1',
      jobRoles: [],
      directCapabilityGrants: [],
    },
    {
      id: 'staff_mgr',
      userId: USERS.MANAGER,
      organizationId: 'org_a',
      displayName: 'Maryam Manager',
      status: 'ACTIVE',
      primaryBranchId: 'branch_1',
      jobRoles: [{ branchId: 'branch_1' }],
      directCapabilityGrants: [],
    },
    {
      id: 'staff_emp',
      userId: USERS.EMPLOYEE,
      organizationId: 'org_a',
      displayName: 'Ayesha',
      status: 'ACTIVE',
      primaryBranchId: 'branch_1',
      jobRoles: [],
      directCapabilityGrants: [],
    },
    {
      id: 'staff_other',
      userId: USERS.OTHER_EMPLOYEE,
      organizationId: 'org_a',
      displayName: 'Bilal',
      status: 'ACTIVE',
      primaryBranchId: 'branch_1',
      jobRoles: [],
      directCapabilityGrants: [],
    },
    {
      id: 'staff_far',
      userId: 'user_far',
      organizationId: 'org_a',
      displayName: 'Zara (DHA)',
      status: 'ACTIVE',
      primaryBranchId: 'branch_2',
      jobRoles: [],
      directCapabilityGrants: [],
    },
    {
      id: 'staff_gone',
      userId: 'user_gone',
      organizationId: 'org_a',
      displayName: 'Suspended Sam',
      status: 'SUSPENDED',
      primaryBranchId: 'branch_1',
      jobRoles: [],
      directCapabilityGrants: [],
    },
  ];
  const base = {
    organizationId: 'org_a',
    version: 1,
    role: 'Line cook',
    notes: null,
    status: 'SCHEDULED' as const,
    cancelledAt: null,
    cancelReason: null,
    clockedInAt: null,
    clockedOutAt: null,
    createdAt: at('2026-09-01T00:00:00Z'),
    updatedAt: at('2026-09-01T00:00:00Z'),
  };
  const shifts: ShiftRow[] = [
    {
      ...base,
      id: 'shift_emp',
      branchId: 'branch_1',
      staffProfileId: 'staff_emp',
      businessDate: at('2026-09-20T00:00:00Z'),
      startAt: at('2026-09-20T09:00:00Z'),
      endAt: at('2026-09-20T17:00:00Z'),
    },
    {
      ...base,
      id: 'shift_other',
      branchId: 'branch_1',
      staffProfileId: 'staff_other',
      businessDate: at('2026-09-20T00:00:00Z'),
      startAt: at('2026-09-20T12:00:00Z'),
      endAt: at('2026-09-20T20:00:00Z'),
    },
    {
      ...base,
      id: 'shift_cancelled',
      branchId: 'branch_1',
      staffProfileId: 'staff_emp',
      businessDate: at('2026-09-21T00:00:00Z'),
      startAt: at('2026-09-21T09:00:00Z'),
      endAt: at('2026-09-21T17:00:00Z'),
      status: 'CANCELLED',
      cancelledAt: at('2026-09-19T10:00:00Z'),
      cancelReason: 'Closed for maintenance',
    },
    {
      ...base,
      id: 'shift_dha',
      branchId: 'branch_2',
      staffProfileId: 'staff_far',
      businessDate: at('2026-09-20T00:00:00Z'),
      startAt: at('2026-09-20T09:00:00Z'),
      endAt: at('2026-09-20T17:00:00Z'),
    },
  ];
  return {
    profiles,
    shifts,
    breaks: [] as { id: string; shiftId: string; startedAt: Date; endedAt: Date | null }[],
    adjustments: [] as {
      id: string;
      shiftId: string;
      breakId: string | null;
      kind: string;
      originalAt: Date;
      correctedAt: Date;
      reason: string;
      createdAt: Date;
    }[],
    commands: [] as {
      idempotencyKey: string;
      kind: string;
      shiftId: string;
      breakId?: string;
      swapRequestId?: string;
    }[],
    swapRequests: [] as {
      id: string;
      shiftId: string;
      requestedByStaffProfileId: string;
      replacementStaffProfileId: string;
      note: string | null;
      createdAt: Date;
    }[],
    decisions: [] as {
      id: string;
      requestId: string;
      decision: string;
      reason: string | null;
      decidedAt: Date;
      decidedByUserId: string;
      decidedByStaffProfileId: string | null;
    }[],
    events: [] as Record<string, unknown>[],
    rawSql: [] as string[],
    seq: 0,
  };
}

let state = makeState();

function nextId(prefix: string) {
  state.seq += 1;
  return `${prefix}_${state.seq}`;
}

function hydrate(row: ShiftRow) {
  const profile = state.profiles.find((p) => p.id === row.staffProfileId)!;
  return {
    ...row,
    branch: BRANCHES[row.branchId as keyof typeof BRANCHES],
    staffProfile: { id: profile.id, displayName: profile.displayName },
    breaks: state.breaks
      .filter((b) => b.shiftId === row.id)
      .map(({ id, startedAt, endedAt }) => ({ id, startedAt, endedAt })),
    adjustments: state.adjustments
      .filter((a) => a.shiftId === row.id)
      .map(({ id, breakId, kind, correctedAt, createdAt }) => ({
        id,
        breakId,
        kind,
        correctedAt,
        createdAt,
      })),
    swapRequests: [],
  };
}

function makeDb() {
  const db: Record<string, unknown> = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    $queryRaw: vi.fn(async (sql: { strings: readonly string[]; values: unknown[] }) => {
      const text = sql.strings.join('?');
      state.rawSql.push(text);
      if (text.includes('pg_advisory_xact_lock')) return [];
      if (text.includes('restaurant_shift_swap_requests')) {
        const [requestId, branchId] = sql.values as string[];
        const request = state.swapRequests.find((r) => r.id === requestId);
        const shift = request && state.shifts.find((s) => s.id === request.shiftId);
        return shift && shift.branchId === branchId ? [{ shiftId: shift.id }] : [];
      }
      if (text.includes('FOR UPDATE')) {
        const shift = state.shifts.find((s) => s.id === sql.values[0]);
        return shift ? [{ id: shift.id }] : [];
      }
      if (text.includes('"staffProfileId", "version"')) {
        const [id, organizationId] = sql.values as string[];
        const shift = state.shifts.find((s) => s.id === id && s.organizationId === organizationId);
        return shift ? [{ staffProfileId: shift.staffProfileId, version: shift.version }] : [];
      }
      throw new Error(`Unexpected raw SQL: ${text}`);
    }),
    restaurantBranch: {
      findMany: vi.fn(async () => Object.values(BRANCHES).map(({ id }) => ({ id }))),
    },
    restaurantStaffProfile: {
      findMany: vi.fn(
        async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
          const rows = state.profiles
            .filter((p) => matches(p, where))
            .sort((a, b) =>
              where.userId ? a.id.localeCompare(b.id) : a.displayName.localeCompare(b.displayName)
            );
          return take ? rows.slice(0, take) : rows;
        }
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          state.profiles.find((p) => matches(p, where)) ?? null
      ),
    },
    restaurantShift: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = state.shifts.find((s) => s.id === where.id);
        return row ? hydrate(row) : null;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = state.shifts.find((s) => matches(s, where));
        return row ? { id: row.id } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.shifts
          .filter((s) => matches(s, where))
          .sort(
            (a, b) =>
              a.businessDate.getTime() - b.businessDate.getTime() ||
              a.startAt.getTime() - b.startAt.getTime()
          )
          .map(hydrate)
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<ShiftRow> }) => {
        const row = state.shifts.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    restaurantShiftEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.events.push(data);
        return { id: nextId('event'), ...data };
      }),
    },
    restaurantWorkforceCommand: {
      findFirst: vi.fn(
        async ({ where }: { where: { idempotencyKey: string } }) =>
          state.commands.find((c) => c.idempotencyKey === where.idempotencyKey) ?? null
      ),
      create: vi.fn(async ({ data }: { data: (typeof state.commands)[number] }) => {
        if (state.commands.some((c) => c.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        state.commands.push(data);
        return data;
      }),
    },
    restaurantShiftBreak: {
      create: vi.fn(async ({ data }: { data: { shiftId: string; startedAt: Date } }) => {
        const row = { id: nextId('break'), endedAt: null, ...data };
        state.breaks.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { endedAt: Date } }) => {
        const row = state.breaks.find((b) => b.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    restaurantShiftSwapRequest: {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          state.swapRequests.find((r) => {
            if ('decision' in where) {
              const decided = state.decisions.some((d) => d.requestId === r.id);
              if (decided !== (where.decision !== null)) return false;
            }
            const rest = { ...where };
            delete rest.decision;
            return matches(r, rest);
          }) ?? null
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const request = state.swapRequests.find((r) => r.id === where.id);
        if (!request) return null;
        const shift = state.shifts.find((s) => s.id === request.shiftId)!;
        return {
          ...request,
          decision: state.decisions.find((d) => d.requestId === request.id) ?? null,
          shift: {
            ...shift,
            breaks: state.breaks
              .filter((row) => row.shiftId === shift.id)
              .map(({ id }) => ({ id })),
          },
          replacement: state.profiles.find((p) => p.id === request.replacementStaffProfileId)!,
        };
      }),
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<(typeof state.swapRequests)[number], 'id' | 'createdAt'>;
        }) => {
          const row = { id: nextId('swap'), createdAt: new Date(), ...data };
          state.swapRequests.push(row);
          return row;
        }
      ),
    },
    restaurantShiftSwapDecision: {
      findUnique: vi.fn(
        async ({ where }: { where: { requestId: string } }) =>
          state.decisions.find((d) => d.requestId === where.requestId) ?? null
      ),
      create: vi.fn(
        async ({ data }: { data: Omit<(typeof state.decisions)[number], 'id' | 'decidedAt'> }) => {
          const row = { id: nextId('decision'), decidedAt: new Date(), ...data };
          state.decisions.push(row);
          return row;
        }
      ),
    },
    restaurantTimeAdjustment: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<(typeof state.adjustments)[number], 'id' | 'createdAt'>;
        }) => {
          const row = {
            id: nextId('adjustment'),
            createdAt: new Date(),
            ...data,
            breakId: data.breakId ?? null,
          };
          state.adjustments.push(row);
          return row;
        }
      ),
    },
  };
  return db;
}

let db = makeDb();

function caller(actor: Actor, modules: string[] = ['restaurant-core', 'restaurant-workforce']) {
  return restaurantShiftsRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: modules,
      activeSeats: 1,
      seatLimit: 5,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: {
        id: USERS[actor],
        organizationId: 'org_a',
        role: actor === 'OWNER' ? 'ADMIN' : 'MEMBER',
        department: 'OPERATIONS',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

function eventsOf(kind: string) {
  return state.events.filter((e) => e.kind === kind);
}

beforeEach(() => {
  state = makeState();
  db = makeDb();
  vi.clearAllMocks();
  mocks.can.mockImplementation(async (subject: { id?: string; userId?: string }, action: string) =>
    Boolean(POLICY[subject.id ?? subject.userId ?? '']?.has(action))
  );
  mocks.resolveStaffCapabilities.mockImplementation(
    async (_db: unknown, staffId: string, branchId: string) =>
      staffId === 'staff_mgr' && branchId === 'branch_1' ? new Set(['staff:manage']) : new Set()
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at('2026-09-20T09:02:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const RANGE = { fromBusinessDate: '2026-09-20', toBusinessDate: '2026-09-21' };

// ---------------------------------------------------------------------------
// Roster administration (staff:manage + branch scope)
// ---------------------------------------------------------------------------

describe('restaurantShifts.list', () => {
  it('denies an employee without staff:manage before touching the roster', async () => {
    await expect(caller('EMPLOYEE').list({ branchId: 'branch_1', ...RANGE })).rejects.toMatchObject(
      { code: 'FORBIDDEN' }
    );
    expect(mocks.listShifts).not.toHaveBeenCalled();
  });

  it('lets a branch manager list their branch, rejects other branches and over-long ranges', async () => {
    mocks.listShifts.mockResolvedValue([{ id: 'shift_emp' }]);
    await expect(caller('MANAGER').list({ branchId: 'branch_1', ...RANGE })).resolves.toEqual([
      { id: 'shift_emp' },
    ]);
    expect(mocks.listShifts).toHaveBeenCalledWith(db, { branchId: 'branch_1', ...RANGE });

    await expect(caller('MANAGER').list({ branchId: 'branch_2', ...RANGE })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller('OWNER').list({
        branchId: 'branch_1',
        fromBusinessDate: '2026-09-01',
        toBusinessDate: '2026-10-02',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller('OWNER').list({
        branchId: 'branch_1',
        fromBusinessDate: '2026-09-21',
        toBusinessDate: '2026-09-20',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.listShifts).toHaveBeenCalledTimes(1);
  });
});

describe('restaurantShifts.create', () => {
  const input = {
    branchId: 'branch_1',
    staffProfileId: 'staff_emp',
    startAt: '2026-09-22T09:00:00Z' as unknown as Date,
    endAt: '2026-09-22T17:00:00Z' as unknown as Date,
    role: 'Line cook',
  };

  it('locks the operator roster, writes a PUBLISHED event and audits the schedule', async () => {
    mocks.createShift.mockImplementation(async (_tx, value) => ({
      id: 'shift_new',
      ...value,
      status: 'SCHEDULED',
    }));
    const shift = await caller('MANAGER').create(input);

    expect(shift).toMatchObject({ id: 'shift_new', staffProfileId: 'staff_emp' });
    const [, createInput] = mocks.createShift.mock.calls[0]!;
    expect(createInput.startAt).toEqual(at('2026-09-22T09:00:00Z'));
    expect(state.rawSql.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(eventsOf('PUBLISHED')).toEqual([
      expect.objectContaining({
        shiftId: 'shift_new',
        actorUserId: USERS.MANAGER,
        toStaffProfileId: 'staff_emp',
      }),
    ]);
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetType: 'RestaurantShift', targetId: 'shift_new' })
    );
  });

  it('maps an overlap (ShiftError or the 23P01 exclusion constraint) to CONFLICT and never schedules outside scope', async () => {
    mocks.createShift.mockRejectedValueOnce(new ShiftError('Overlaps', 'OVERLAP'));
    await expect(caller('MANAGER').create(input)).rejects.toMatchObject({ code: 'CONFLICT' });

    mocks.createShift.mockRejectedValueOnce({ cause: { code: '23P01' } });
    await expect(caller('MANAGER').create(input)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('overlapping shift'),
    });

    mocks.createShift.mockClear();
    await expect(
      caller('MANAGER').create({ ...input, branchId: 'branch_2' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('EMPLOYEE').create(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.createShift).not.toHaveBeenCalled();
    expect(state.events).toHaveLength(0);
  });
});

describe('restaurantShifts.update', () => {
  it('passes the tenant CAS to the lib and records an UPDATED event', async () => {
    mocks.updateShift.mockImplementation(async (_tx, id, patch) => ({
      ...state.shifts.find((s) => s.id === id)!,
      ...patch,
      version: 2,
    }));
    const updated = await caller('MANAGER').update({
      id: 'shift_emp',
      expectedVersion: 1,
      notes: 'Cover the tandoor',
    });

    expect(updated).toMatchObject({ id: 'shift_emp', version: 2, notes: 'Cover the tandoor' });
    expect(mocks.updateShift).toHaveBeenCalledWith(
      db,
      'shift_emp',
      { notes: 'Cover the tandoor' },
      { organizationId: 'org_a', expectedVersion: 1 }
    );
    expect(eventsOf('UPDATED')).toHaveLength(1);
  });

  it('maps a stale version to CONFLICT, unknown shifts to NOT_FOUND, other branches to FORBIDDEN', async () => {
    mocks.updateShift.mockRejectedValueOnce(new ShiftError('Stale', 'VERSION_CONFLICT'));
    await expect(
      caller('MANAGER').update({ id: 'shift_emp', expectedVersion: 1, notes: 'x' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      caller('MANAGER').update({ id: 'shift_missing', expectedVersion: 1, notes: 'x' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller('MANAGER').update({ id: 'shift_dha', expectedVersion: 1, notes: 'x' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.updateShift).toHaveBeenCalledTimes(1);
    expect(state.events).toHaveLength(0);
  });
});

describe('restaurantShifts.cancel', () => {
  it('records a CANCELLED event carrying the reason, and maps ALREADY_CANCELLED to CONFLICT', async () => {
    mocks.cancelShift.mockImplementation(async (_tx, id, { now, reason }) => ({
      ...state.shifts.find((s) => s.id === id)!,
      status: 'CANCELLED',
      cancelledAt: now,
      cancelReason: reason,
    }));
    const cancelled = await caller('OWNER').cancel({
      id: 'shift_emp',
      expectedVersion: 1,
      reason: 'Sick leave',
    });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Sick leave' });
    expect(mocks.cancelShift.mock.calls[0]![3]).toEqual({
      organizationId: 'org_a',
      expectedVersion: 1,
    });
    expect(eventsOf('CANCELLED')).toEqual([
      expect.objectContaining({ shiftId: 'shift_emp', reason: 'Sick leave' }),
    ]);

    mocks.cancelShift.mockRejectedValueOnce(new ShiftError('Already', 'ALREADY_CANCELLED'));
    await expect(
      caller('OWNER').cancel({ id: 'shift_cancelled', expectedVersion: 1 })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      caller('EMPLOYEE').cancel({ id: 'shift_emp', expectedVersion: 1 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ---------------------------------------------------------------------------
// Roster reads
// ---------------------------------------------------------------------------

describe('restaurantShifts.myRoster', () => {
  it("returns only the caller's own shifts with presented attendance", async () => {
    const result = await caller('EMPLOYEE').myRoster({
      from: '2026-09-20T00:00:00Z' as unknown as Date,
      to: '2026-09-22T00:00:00Z' as unknown as Date,
    });
    expect(result!.actor.id).toBe('staff_emp');
    expect(result!.shifts.map((s) => s.id)).toEqual(['shift_emp', 'shift_cancelled']);
    expect(result!.shifts.map((s) => s.attendanceStatus)).toEqual(['SCHEDULED', 'CANCELLED']);
  });

  it('fails closed without the workforce module, a staff profile, or a bounded range', async () => {
    const range = {
      from: '2026-09-20T00:00:00Z' as unknown as Date,
      to: '2026-09-21T00:00:00Z' as unknown as Date,
    };
    await expect(caller('EMPLOYEE', ['restaurant-core']).myRoster(range)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller('NO_PROFILE').myRoster(range)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller('EMPLOYEE').myRoster({
        from: '2026-09-01T00:00:00Z' as unknown as Date,
        to: '2026-10-03T00:00:00Z' as unknown as Date,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller('EMPLOYEE').myRoster({ from: range.to, to: range.from })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('restaurantShifts.managerRoster', () => {
  it('lists the branch roster (SCHEDULED by default) and denies other branches and employees', async () => {
    const rows = await caller('MANAGER').managerRoster({ branchId: 'branch_1', ...RANGE });
    expect(rows.map((r) => r.id)).toEqual(['shift_emp', 'shift_other']);
    expect(rows.every((r) => r.branchId === 'branch_1')).toBe(true);

    const withCancelled = await caller('MANAGER').managerRoster({
      branchId: 'branch_1',
      ...RANGE,
      includeCancelled: true,
    });
    expect(withCancelled.map((r) => r.id)).toContain('shift_cancelled');

    await expect(
      caller('MANAGER').managerRoster({ branchId: 'branch_2', ...RANGE })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller('EMPLOYEE').managerRoster({ branchId: 'branch_1', ...RANGE })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('restaurantShifts.swapCandidates', () => {
  it('offers active colleagues from the same primary branch, never the caller', async () => {
    const rows = await caller('EMPLOYEE').swapCandidates();
    expect(rows!.map((r) => r.id).sort()).toEqual(['staff_mgr', 'staff_other', 'staff_owner']);
    expect(rows!.map((r) => r.id)).not.toContain('staff_emp');
    expect(rows!.map((r) => r.id)).not.toContain('staff_far');
    expect(rows!.map((r) => r.id)).not.toContain('staff_gone');

    await expect(caller('NO_PROFILE').swapCandidates()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

// ---------------------------------------------------------------------------
// Timekeeping (employee self-service)
// ---------------------------------------------------------------------------

describe('restaurantShifts.clockIn', () => {
  it('is idempotent: a retried key returns the same clock-in without a second write', async () => {
    const first = await caller('EMPLOYEE').clockIn({
      shiftId: 'shift_emp',
      idempotencyKey: 'ci-1',
    });
    expect(first).toMatchObject({
      id: 'shift_emp',
      clockedInAt: at('2026-09-20T09:02:00Z'),
      attendanceStatus: 'PRESENT',
      lateMinutes: 2,
    });

    vi.setSystemTime(at('2026-09-20T09:10:00Z'));
    const replay = await caller('EMPLOYEE').clockIn({
      shiftId: 'shift_emp',
      idempotencyKey: 'ci-1',
    });
    expect(replay!.clockedInAt).toEqual(at('2026-09-20T09:02:00Z'));
    expect(replay!.attendanceStatus).toBe('PRESENT');
    expect(state.commands.filter((c) => c.kind === 'CLOCK_IN')).toHaveLength(1);
    expect(
      (db.restaurantShift as { update: ReturnType<typeof vi.fn> }).update
    ).toHaveBeenCalledTimes(1);

    await expect(
      caller('EMPLOYEE').clockIn({ shiftId: 'shift_emp', idempotencyKey: 'ci-2' })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('already') });
  });

  it("denies clocking into another employee's shift and enforces the 30-minute window", async () => {
    await expect(
      caller('EMPLOYEE').clockIn({ shiftId: 'shift_other', idempotencyKey: 'ci-x' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller('EMPLOYEE').clockIn({ shiftId: 'shift_cancelled', idempotencyKey: 'ci-c' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      caller('EMPLOYEE', ['restaurant-core']).clockIn({ shiftId: 'shift_emp', idempotencyKey: 'k' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    vi.setSystemTime(at('2026-09-20T08:29:00Z'));
    await expect(
      caller('EMPLOYEE').clockIn({ shiftId: 'shift_emp', idempotencyKey: 'ci-early' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    vi.setSystemTime(at('2026-09-20T17:31:00Z'));
    await expect(
      caller('EMPLOYEE').clockIn({ shiftId: 'shift_emp', idempotencyKey: 'ci-late' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(state.shifts.find((s) => s.id === 'shift_emp')!.clockedInAt).toBeNull();
    expect(state.commands).toHaveLength(0);
  });
});

describe('restaurantShifts.startBreak / endBreak / clockOut', () => {
  it('startBreak requires an active clock-in and refuses a second open break', async () => {
    await expect(
      caller('EMPLOYEE').startBreak({ shiftId: 'shift_emp', idempotencyKey: 'b-0' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await caller('EMPLOYEE').clockIn({ shiftId: 'shift_emp', idempotencyKey: 'ci' });
    vi.setSystemTime(at('2026-09-20T12:00:00Z'));
    const onBreak = await caller('EMPLOYEE').startBreak({
      shiftId: 'shift_emp',
      idempotencyKey: 'b-1',
    });
    expect(onBreak!.breaks).toEqual([
      expect.objectContaining({ startedAt: at('2026-09-20T12:00:00Z'), endedAt: null }),
    ]);
    const replay = await caller('EMPLOYEE').startBreak({
      shiftId: 'shift_emp',
      idempotencyKey: 'b-1',
    });
    expect(replay!.breaks).toHaveLength(1);
    await expect(
      caller('EMPLOYEE').startBreak({ shiftId: 'shift_emp', idempotencyKey: 'b-2' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('endBreak closes the open break and rejects when none is open', async () => {
    await caller('EMPLOYEE').clockIn({ shiftId: 'shift_emp', idempotencyKey: 'ci' });
    await expect(
      caller('EMPLOYEE').endBreak({ shiftId: 'shift_emp', idempotencyKey: 'e-0' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    vi.setSystemTime(at('2026-09-20T12:00:00Z'));
    await caller('EMPLOYEE').startBreak({ shiftId: 'shift_emp', idempotencyKey: 'b-1' });
    vi.setSystemTime(at('2026-09-20T12:30:00Z'));
    const back = await caller('EMPLOYEE').endBreak({ shiftId: 'shift_emp', idempotencyKey: 'e-1' });
    expect(back!.breaks[0]).toMatchObject({ endedAt: at('2026-09-20T12:30:00Z') });
    await expect(
      caller('OTHER_EMPLOYEE').endBreak({ shiftId: 'shift_emp', idempotencyKey: 'e-x' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('clockOut refuses during an open break, then completes the shift idempotently', async () => {
    await expect(
      caller('EMPLOYEE').clockOut({ shiftId: 'shift_emp', idempotencyKey: 'co-0' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await caller('EMPLOYEE').clockIn({ shiftId: 'shift_emp', idempotencyKey: 'ci' });
    vi.setSystemTime(at('2026-09-20T12:00:00Z'));
    await caller('EMPLOYEE').startBreak({ shiftId: 'shift_emp', idempotencyKey: 'b-1' });
    await expect(
      caller('EMPLOYEE').clockOut({ shiftId: 'shift_emp', idempotencyKey: 'co-1' })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('break') });

    vi.setSystemTime(at('2026-09-20T12:30:00Z'));
    await caller('EMPLOYEE').endBreak({ shiftId: 'shift_emp', idempotencyKey: 'e-1' });
    vi.setSystemTime(at('2026-09-20T17:05:00Z'));
    const done = await caller('EMPLOYEE').clockOut({
      shiftId: 'shift_emp',
      idempotencyKey: 'co-1',
    });
    expect(done).toMatchObject({
      clockedOutAt: at('2026-09-20T17:05:00Z'),
      attendanceStatus: 'COMPLETE',
    });
    const replay = await caller('EMPLOYEE').clockOut({
      shiftId: 'shift_emp',
      idempotencyKey: 'co-1',
    });
    expect(replay!.clockedOutAt).toEqual(at('2026-09-20T17:05:00Z'));

    // A key minted for one command cannot be replayed as another.
    await expect(
      caller('EMPLOYEE').startBreak({ shiftId: 'shift_emp', idempotencyKey: 'co-1' })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('idempotency') });
  });
});

// ---------------------------------------------------------------------------
// Swaps
// ---------------------------------------------------------------------------

describe('restaurantShifts.requestSwap', () => {
  it('creates one request + SWAP_REQUESTED event, replays by key, and blocks duplicates', async () => {
    const request = await caller('EMPLOYEE').requestSwap({
      shiftId: 'shift_emp',
      replacementStaffProfileId: 'staff_other',
      note: '  family event  ',
      idempotencyKey: 'sw-1',
    });
    expect(request).toMatchObject({
      shiftId: 'shift_emp',
      requestedByStaffProfileId: 'staff_emp',
      replacementStaffProfileId: 'staff_other',
      note: 'family event',
    });
    expect(eventsOf('SWAP_REQUESTED')).toHaveLength(1);

    const replay = await caller('EMPLOYEE').requestSwap({
      shiftId: 'shift_emp',
      replacementStaffProfileId: 'staff_other',
      idempotencyKey: 'sw-1',
    });
    expect(replay!.id).toBe(request!.id);
    expect(state.swapRequests).toHaveLength(1);

    await expect(
      caller('EMPLOYEE').requestSwap({
        shiftId: 'shift_emp',
        replacementStaffProfileId: 'staff_owner',
        idempotencyKey: 'sw-2',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects self, out-of-branch and inactive replacements, and foreign shifts', async () => {
    for (const replacementStaffProfileId of ['staff_emp', 'staff_far', 'staff_gone']) {
      await expect(
        caller('EMPLOYEE').requestSwap({
          shiftId: 'shift_emp',
          replacementStaffProfileId,
          idempotencyKey: `sw-${replacementStaffProfileId}`,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(
      caller('EMPLOYEE').requestSwap({
        shiftId: 'shift_other',
        replacementStaffProfileId: 'staff_owner',
        idempotencyKey: 'sw-foreign',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(state.swapRequests).toHaveLength(0);
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });
});

describe('restaurantShifts.reviewSwap', () => {
  async function pendingSwap() {
    return caller('EMPLOYEE').requestSwap({
      shiftId: 'shift_emp',
      replacementStaffProfileId: 'staff_owner',
      idempotencyKey: 'sw-1',
    });
  }

  it('approval reassigns the shift to the replacement exactly once', async () => {
    const request = await pendingSwap();
    const decision = await caller('MANAGER').reviewSwap({
      requestId: request!.id,
      branchId: 'branch_1',
      decision: 'APPROVED',
      reason: 'Covered',
      idempotencyKey: 'rv-1',
    });
    expect(decision).toMatchObject({
      requestId: request!.id,
      decision: 'APPROVED',
      decidedByUserId: USERS.MANAGER,
      decidedByStaffProfileId: 'staff_mgr',
    });
    expect(state.shifts.find((s) => s.id === 'shift_emp')!.staffProfileId).toBe('staff_owner');
    expect(eventsOf('SWAP_APPROVED')).toHaveLength(1);

    const replay = await caller('MANAGER').reviewSwap({
      requestId: request!.id,
      branchId: 'branch_1',
      decision: 'APPROVED',
      idempotencyKey: 'rv-1',
    });
    expect(replay!.id).toBe(decision!.id);
    await expect(
      caller('MANAGER').reviewSwap({
        requestId: request!.id,
        branchId: 'branch_1',
        decision: 'REJECTED',
        idempotencyKey: 'rv-2',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(state.decisions).toHaveLength(1);
  });

  it('refuses to reassign a shift after attendance has been recorded', async () => {
    const request = await pendingSwap();
    await caller('EMPLOYEE').clockIn({ shiftId: 'shift_emp', idempotencyKey: 'ci-before-swap' });

    await expect(
      caller('MANAGER').reviewSwap({
        requestId: request!.id,
        branchId: 'branch_1',
        decision: 'APPROVED',
        idempotencyKey: 'rv-attendance',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('recorded attendance'),
    });

    expect(state.shifts.find((shift) => shift.id === 'shift_emp')).toMatchObject({
      staffProfileId: 'staff_emp',
      clockedInAt: at('2026-09-20T09:02:00Z'),
    });
    expect(state.decisions).toHaveLength(0);
    expect(eventsOf('SWAP_APPROVED')).toHaveLength(0);
  });

  it('refuses to reassign a shift with recorded clock-out attendance', async () => {
    const request = await pendingSwap();
    const shift = state.shifts.find((row) => row.id === 'shift_emp')!;
    shift.clockedOutAt = at('2026-09-20T17:00:00Z');

    await expect(
      caller('MANAGER').reviewSwap({
        requestId: request!.id,
        branchId: 'branch_1',
        decision: 'APPROVED',
        idempotencyKey: 'rv-clock-out',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('recorded attendance'),
    });

    expect(shift).toMatchObject({
      staffProfileId: 'staff_emp',
      clockedOutAt: at('2026-09-20T17:00:00Z'),
    });
    expect(state.decisions).toHaveLength(0);
    expect(eventsOf('SWAP_APPROVED')).toHaveLength(0);
  });

  it('refuses to reassign a shift with a historical break record', async () => {
    const request = await pendingSwap();
    state.breaks.push({
      id: 'break_historical',
      shiftId: 'shift_emp',
      startedAt: at('2026-09-20T12:00:00Z'),
      endedAt: at('2026-09-20T12:30:00Z'),
    });

    await expect(
      caller('MANAGER').reviewSwap({
        requestId: request!.id,
        branchId: 'branch_1',
        decision: 'APPROVED',
        idempotencyKey: 'rv-historical-break',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('recorded attendance'),
    });

    expect(state.shifts.find((shift) => shift.id === 'shift_emp')!.staffProfileId).toBe(
      'staff_emp'
    );
    expect(state.decisions).toHaveLength(0);
    expect(eventsOf('SWAP_APPROVED')).toHaveLength(0);
  });

  it('allows rejecting a swap after attendance has been recorded', async () => {
    const request = await pendingSwap();
    await caller('EMPLOYEE').clockIn({ shiftId: 'shift_emp', idempotencyKey: 'ci-before-reject' });

    await expect(
      caller('MANAGER').reviewSwap({
        requestId: request!.id,
        branchId: 'branch_1',
        decision: 'APPROVED',
        idempotencyKey: 'rv-approve-before-reject',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const decision = await caller('MANAGER').reviewSwap({
      requestId: request!.id,
      branchId: 'branch_1',
      decision: 'REJECTED',
      // The failed approval must not consume its idempotency key or the pending request.
      idempotencyKey: 'rv-approve-before-reject',
    });

    expect(decision).toMatchObject({ requestId: request!.id, decision: 'REJECTED' });
    expect(state.shifts.find((shift) => shift.id === 'shift_emp')).toMatchObject({
      staffProfileId: 'staff_emp',
      clockedInAt: at('2026-09-20T09:02:00Z'),
    });
    expect(state.decisions).toContainEqual(
      expect.objectContaining({
        requestId: request!.id,
        decision: 'REJECTED',
      })
    );
    expect(eventsOf('SWAP_REJECTED')).toHaveLength(1);
    expect(eventsOf('SWAP_APPROVED')).toHaveLength(0);
  });

  it('denies employees, other-branch managers, and replacements with an overlapping shift', async () => {
    const request = await pendingSwap();
    const review = {
      requestId: request!.id,
      branchId: 'branch_1',
      decision: 'APPROVED' as const,
      idempotencyKey: 'rv-1',
    };
    await expect(caller('EMPLOYEE').reviewSwap(review)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller('MANAGER').reviewSwap({ ...review, branchId: 'branch_2' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller('OWNER').reviewSwap({ ...review, branchId: 'branch_2' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    state.shifts.push({
      ...state.shifts[0]!,
      id: 'shift_owner_overlap',
      staffProfileId: 'staff_owner',
      startAt: at('2026-09-20T16:00:00Z'),
      endAt: at('2026-09-20T22:00:00Z'),
    });
    await expect(caller('OWNER').reviewSwap(review)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(state.shifts.find((s) => s.id === 'shift_emp')!.staffProfileId).toBe('staff_emp');
    expect(state.decisions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Manager corrections + payroll export
// ---------------------------------------------------------------------------

describe('restaurantShifts.correctTime', () => {
  it('appends a reasoned correction that later reads (and payroll) honour', async () => {
    await caller('EMPLOYEE').clockIn({ shiftId: 'shift_emp', idempotencyKey: 'ci' });
    const adjustment = await caller('MANAGER').correctTime({
      shiftId: 'shift_emp',
      branchId: 'branch_1',
      kind: 'CLOCK_IN',
      correctedAt: '2026-09-20T08:58:00Z' as unknown as Date,
      reason: '  Badge reader offline  ',
    });
    expect(adjustment).toMatchObject({
      kind: 'CLOCK_IN',
      originalAt: at('2026-09-20T09:02:00Z'),
      correctedAt: at('2026-09-20T08:58:00Z'),
      reason: 'Badge reader offline',
    });
    // Original punch is preserved; the correction is layered on read.
    expect(state.shifts.find((s) => s.id === 'shift_emp')!.clockedInAt).toEqual(
      at('2026-09-20T09:02:00Z')
    );
    const roster = await caller('MANAGER').managerRoster({ branchId: 'branch_1', ...RANGE });
    expect(roster.find((r) => r.id === 'shift_emp')).toMatchObject({
      clockedInAt: at('2026-09-20T08:58:00Z'),
      lateMinutes: 0,
    });
  });

  it('rejects cross-branch shifts, impossible corrections and non-managers', async () => {
    await caller('EMPLOYEE').clockIn({ shiftId: 'shift_emp', idempotencyKey: 'ci' });
    const base = {
      shiftId: 'shift_emp',
      branchId: 'branch_1',
      kind: 'CLOCK_OUT' as const,
      correctedAt: '2026-09-20T17:00:00Z' as unknown as Date,
      reason: 'Forgot to clock out',
    };
    // Clock-out was never punched: nothing to correct.
    await expect(caller('MANAGER').correctTime(base)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // A branch_1 manager naming branch_1 cannot correct a punched branch_2 shift.
    state.shifts.find((s) => s.id === 'shift_dha')!.clockedInAt = at('2026-09-20T09:00:00Z');
    await expect(
      caller('MANAGER').correctTime({
        ...base,
        kind: 'CLOCK_IN',
        correctedAt: '2026-09-20T09:00:00Z' as unknown as Date,
        shiftId: 'shift_dha',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller('MANAGER').correctTime({ ...base, kind: 'BREAK_START' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller('MANAGER').correctTime({ ...base, kind: 'CLOCK_IN', reason: '   ' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller('EMPLOYEE').correctTime({
        ...base,
        kind: 'CLOCK_IN',
        correctedAt: '2026-09-20T08:00:00Z' as unknown as Date,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    vi.setSystemTime(at('2026-09-20T17:00:00Z'));
    await caller('EMPLOYEE').clockOut({ shiftId: 'shift_emp', idempotencyKey: 'co' });
    await expect(
      caller('MANAGER').correctTime({
        ...base,
        correctedAt: '2026-09-20T08:00:00Z' as unknown as Date,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('before') });
    expect(state.adjustments).toHaveLength(0);
  });
});

describe('restaurantShifts.exportAttendanceCsv', () => {
  it('exports a payroll CSV with the exact header, one row per shift, and computed minutes', async () => {
    await caller('EMPLOYEE').clockIn({ shiftId: 'shift_emp', idempotencyKey: 'ci' });
    vi.setSystemTime(at('2026-09-20T12:00:00Z'));
    await caller('EMPLOYEE').startBreak({ shiftId: 'shift_emp', idempotencyKey: 'b' });
    vi.setSystemTime(at('2026-09-20T12:45:00Z'));
    await caller('EMPLOYEE').endBreak({ shiftId: 'shift_emp', idempotencyKey: 'e' });
    vi.setSystemTime(at('2026-09-20T17:01:00Z'));
    await caller('EMPLOYEE').clockOut({ shiftId: 'shift_emp', idempotencyKey: 'co' });
    vi.setSystemTime(at('2026-09-22T00:00:00Z'));

    const result = await caller('MANAGER').exportAttendanceCsv({ branchId: 'branch_1', ...RANGE });
    expect(result.filename).toBe('restaurant-workforce-2026-09-20-2026-09-21.csv');
    const lines = result.csv.split('\n');
    expect(lines[0]).toBe(
      'branch,employee,businessDate,scheduledStart,scheduledEnd,clockIn,clockOut,breakMinutes,attendanceStatus,lateMinutes'
    );
    expect(lines).toHaveLength(4);
    const cells = (line: string) => line.split(',');
    expect(cells(lines[1]!)).toEqual([
      'Gulberg Main',
      'Ayesha',
      '2026-09-20',
      '2026-09-20T09:00:00.000Z',
      '2026-09-20T17:00:00.000Z',
      '2026-09-20T09:02:00.000Z',
      '2026-09-20T17:01:00.000Z',
      '45',
      'COMPLETE',
      '2',
    ]);
    expect(cells(lines[2]!).slice(0, 2)).toEqual(['Gulberg Main', 'Bilal']);
    expect(cells(lines[2]!).slice(5, 10)).toEqual(['', '', '0', 'ABSENT', '0']);
    expect(cells(lines[3]!).slice(8)).toEqual(['CANCELLED', '0']);
    expect(result.csv).not.toContain('DHA Phase 6');
  });

  it('denies employees, other-branch managers and over-long ranges', async () => {
    await expect(
      caller('EMPLOYEE').exportAttendanceCsv({ branchId: 'branch_1', ...RANGE })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller('MANAGER').exportAttendanceCsv({ branchId: 'branch_2', ...RANGE })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller('OWNER').exportAttendanceCsv({
        branchId: 'branch_1',
        fromBusinessDate: '2026-08-01',
        toBusinessDate: '2026-09-30',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller('OWNER', ['restaurant-core']).exportAttendanceCsv({ branchId: 'branch_1', ...RANGE })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
