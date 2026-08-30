import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(async () => true), annotateAudit: vi.fn() }));

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
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import type { TRPCContext } from '../trpc';
import { restaurantBranchesRouter } from './restaurant-branches';

const branch = {
  id: 'branch_a',
  organizationId: 'org_a',
  name: 'DHA Phase 6',
  code: 'DHA-PH6',
  timezone: 'Asia/Karachi',
  businessDayCutoff: '04:00',
  address: null,
  active: true,
  isDefault: false,
  shiftSignInEnforced: false,
};

function makeDb() {
  const delegate = {
    findMany: vi.fn().mockResolvedValue([branch]),
    findFirst: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(1),
    create: vi.fn(async ({ data }: { data: object }) => ({ ...branch, ...data })),
    update: vi.fn(async ({ data }: { data: object }) => ({ ...branch, ...data })),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const db = { restaurantBranch: delegate } as Record<string, unknown>;
  db.$transaction = vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db));
  return { db, delegate };
}

let state = makeDb();

function caller(limit = 5, organizationId = 'org_a') {
  return restaurantBranchesRouter.createCaller({
    db: state.db,
    entitlements: {
      enabledModules: ['restaurant-core'],
      activeSeats: 1,
      seatLimit: 5,
      modules: [],
      limits: { 'restaurant.locations.max': limit },
    },
    session: {
      expires: 'later',
      user: {
        id: 'user_a',
        organizationId,
        role: 'ADMIN',
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

const input = {
  name: 'Gulberg Main',
  code: 'gul-main',
  timezone: 'Asia/Karachi',
  businessDayCutoff: '04:00',
  address: null,
  shiftSignInEnforced: false,
};

beforeEach(() => {
  state = makeDb();
  mocks.can.mockResolvedValue(true);
});

describe('restaurant branch administration', () => {
  it('denies callers without restaurant:configure', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(state.delegate.findMany).not.toHaveBeenCalled();
  });

  it('scopes every list to the session tenant and returns readable codes', async () => {
    const result = await caller(5, 'org_a').list();
    expect(state.delegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_a' } })
    );
    expect(result.branches[0]).toMatchObject({ name: 'DHA Phase 6', code: 'DHA-PH6' });
    expect(result.branches[0]).toHaveProperty('id');
  });

  it('enforces restaurant.locations.max', async () => {
    state.delegate.count.mockResolvedValue(1);
    await expect(caller(1).create(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(state.delegate.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate human name or code', async () => {
    state.delegate.count.mockResolvedValue(0);
    state.delegate.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(caller().create(input)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('normalizes a new readable code and keeps tenant id server-owned', async () => {
    state.delegate.count.mockResolvedValue(0);
    const result = await caller().create(input);
    expect(state.delegate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: 'org_a', code: 'GUL-MAIN', isDefault: true }),
    });
    expect(result.code).toBe('GUL-MAIN');
  });

  it('prevents cross-tenant updates', async () => {
    state.delegate.findFirst.mockResolvedValue(null);
    await expect(caller().update({ id: 'branch_other', name: 'Nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(state.delegate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'branch_other', organizationId: 'org_a' } })
    );
  });

  it('guards the last active and primary branch', async () => {
    state.delegate.findFirst.mockResolvedValue({ ...branch, isDefault: false });
    state.delegate.count.mockResolvedValue(1);
    await expect(caller().setActive({ id: branch.id, active: false })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    state.delegate.findFirst.mockResolvedValue({ ...branch, isDefault: true });
    await expect(caller().setActive({ id: branch.id, active: false })).rejects.toMatchObject({
      message: expect.stringContaining('primary'),
    });
  });
});
