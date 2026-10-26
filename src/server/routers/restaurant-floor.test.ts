/**
 * M4-L3 router — capability gating (floor:manage mutations, orders:read reads),
 * strict-input rejection, business-date conversion, domain-error → tRPC status
 * mapping, and the C10 read-contract passthrough. Runs the REAL router with the
 * real domain-error classes; the lib CRUD functions, the ABAC decision, the
 * entitlement check and the audit writer are mocked so the test exercises this
 * lane's wiring, not the platform middleware.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  annotateAudit: vi.fn(),
  // floor lib
  createFloor: vi.fn(),
  updateFloor: vi.fn(),
  deleteFloor: vi.fn(),
  createTable: vi.fn(),
  updateTable: vi.fn(),
  deleteTable: vi.fn(),
  listFloors: vi.fn(),
  // sections lib
  createSection: vi.fn(),
  updateSection: vi.fn(),
  deleteSection: vi.fn(),
  setSectionTables: vi.fn(),
  assignServer: vi.fn(),
  unassignServer: vi.fn(),
  listSections: vi.fn(),
  // stations lib
  createStation: vi.fn(),
  updateStation: vi.fn(),
  setDefaultStation: vi.fn(),
  deleteStation: vi.fn(),
  createRoutingRule: vi.fn(),
  updateRoutingRule: vi.fn(),
  deleteRoutingRule: vi.fn(),
  listStations: vi.fn(),
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
vi.mock('@/lib/restaurant/floor', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/restaurant/floor')>('@/lib/restaurant/floor');
  return {
    ...actual,
    createFloor: mocks.createFloor,
    updateFloor: mocks.updateFloor,
    deleteFloor: mocks.deleteFloor,
    createTable: mocks.createTable,
    updateTable: mocks.updateTable,
    deleteTable: mocks.deleteTable,
    listFloors: mocks.listFloors,
  };
});
vi.mock('@/lib/restaurant/sections', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/sections')>(
    '@/lib/restaurant/sections'
  );
  return {
    ...actual,
    createSection: mocks.createSection,
    updateSection: mocks.updateSection,
    deleteSection: mocks.deleteSection,
    setSectionTables: mocks.setSectionTables,
    assignServer: mocks.assignServer,
    unassignServer: mocks.unassignServer,
    listSections: mocks.listSections,
  };
});
vi.mock('@/lib/restaurant/stations', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/stations')>(
    '@/lib/restaurant/stations'
  );
  return {
    ...actual,
    createStation: mocks.createStation,
    updateStation: mocks.updateStation,
    setDefaultStation: mocks.setDefaultStation,
    deleteStation: mocks.deleteStation,
    createRoutingRule: mocks.createRoutingRule,
    updateRoutingRule: mocks.updateRoutingRule,
    deleteRoutingRule: mocks.deleteRoutingRule,
    listStations: mocks.listStations,
  };
});

import { restaurantFloorRouter } from './restaurant-floor';
import { FloorError } from '@/lib/restaurant/floor';
import { SectionError } from '@/lib/restaurant/sections';
import { StationError } from '@/lib/restaurant/stations';
import type { TRPCContext } from '../trpc';

function caller(primaryBranchId = 'branch_1') {
  const branch = (id: string) => ({
    branchId: id === 'branch_b_resource' ? 'branch_b' : 'branch_1',
  });
  type ResourceLookup = { where: { id: string } };
  return restaurantFloorRouter.createCaller({
    db: {
      restaurantBranch: {
        findMany: vi.fn(async ({ where }: { where?: { id?: { in?: string[] } } }) =>
          (where?.id?.in ?? []).map((id) => ({ id }))
        ),
      },
      restaurantStaffProfile: {
        findFirst: vi.fn(async ({ where }: { where: { primaryBranchId: string } }) =>
          where.primaryBranchId === primaryBranchId ? { id: 'staff_1' } : null
        ),
      },
      restaurantBranchAssignment: { findFirst: vi.fn(async () => null) },
      restaurantFloor: {
        findUnique: vi.fn(async ({ where }: ResourceLookup) => branch(where.id)),
      },
      restaurantTable: {
        findUnique: vi.fn(async ({ where }: ResourceLookup) => ({ floor: branch(where.id) })),
      },
      restaurantServerSection: {
        findUnique: vi.fn(async ({ where }: ResourceLookup) => branch(where.id)),
      },
      restaurantKitchenStation: {
        findUnique: vi.fn(async ({ where }: ResourceLookup) => branch(where.id)),
      },
      restaurantStationRoutingRule: {
        findUnique: vi.fn(async ({ where }: ResourceLookup) => ({ station: branch(where.id) })),
      },
    },
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['restaurant-pos'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'user_gm', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.createFloor.mockResolvedValue({ id: 'floor_new', name: 'Patio', branchId: 'branch_1' });
  mocks.listFloors.mockResolvedValue([{ id: 'floor_1', tables: [] }]);
  mocks.createTable.mockResolvedValue({
    id: 'table_new',
    code: 'A1',
    floorId: 'floor_1',
    capacity: 4,
  });
  mocks.listSections.mockResolvedValue([{ id: 'section_1', tables: [], assignments: [] }]);
  mocks.assignServer.mockResolvedValue({ id: 'assignment_new' });
  mocks.unassignServer.mockResolvedValue({ count: 1 });
  mocks.listStations.mockResolvedValue([{ id: 'station_1', routingRules: [] }]);
  mocks.createStation.mockResolvedValue({
    id: 'station_new',
    name: 'Grill',
    branchId: 'branch_1',
    isDefault: true,
  });
});

describe('capability gating', () => {
  it('rejects a mutation when the ABAC decision denies floor:manage', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(
      caller().createFloor({ branchId: 'branch_1', name: 'Patio' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.createFloor).not.toHaveBeenCalled();
  });

  it('denies a branch manager reads and ID-addressed mutations outside their branch', async () => {
    mocks.can.mockImplementation(
      async (_subject, capability) => capability !== 'restaurant:configure'
    );

    await expect(caller('branch_1').listFloors({ branchId: 'branch_b' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const outsideBranchMutations = [
      () => caller('branch_1').updateFloor({ id: 'branch_b_resource', name: 'Nope' }),
      () => caller('branch_1').updateTable({ id: 'branch_b_resource', code: 'Nope' }),
      () => caller('branch_1').updateSection({ id: 'branch_b_resource', name: 'Nope' }),
      () => caller('branch_1').updateStation({ id: 'branch_b_resource', name: 'Nope' }),
      () => caller('branch_1').updateRoutingRule({ id: 'branch_b_resource', priority: 1 }),
    ];
    for (const mutation of outsideBranchMutations) {
      await expect(mutation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(mocks.listFloors).not.toHaveBeenCalled();
    expect(mocks.updateFloor).not.toHaveBeenCalled();
    expect(mocks.updateTable).not.toHaveBeenCalled();
    expect(mocks.updateSection).not.toHaveBeenCalled();
    expect(mocks.updateStation).not.toHaveBeenCalled();
    expect(mocks.updateRoutingRule).not.toHaveBeenCalled();
  });

  it('allows an organization-wide restaurant administrator across branches', async () => {
    mocks.can.mockResolvedValue(true);
    await caller('branch_1').listFloors({ branchId: 'branch_b' });
    expect(mocks.listFloors).toHaveBeenCalled();
  });

  it('gates mutations on floor:manage and reads on orders:read', async () => {
    await caller().createFloor({ branchId: 'branch_1', name: 'Patio' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'floor:manage',
      undefined,
      expect.anything()
    );

    mocks.can.mockClear();
    await caller().listFloors({ branchId: 'branch_1' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'orders:read',
      undefined,
      expect.anything()
    );
  });
});

describe('strict inputs (house style, directive 6)', () => {
  it('rejects an unknown field instead of stripping it', async () => {
    await expect(
      // @ts-expect-error — unknown field must be rejected by .strict()
      caller().createFloor({ branchId: 'branch_1', name: 'Patio', color: 'red' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.createFloor).not.toHaveBeenCalled();
  });

  it('rejects a malformed business date', async () => {
    await expect(
      caller().listSections({ branchId: 'branch_1', businessDate: '2026/08/19' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.listSections).not.toHaveBeenCalled();
  });
});

describe('business date conversion', () => {
  it('converts the YYYY-MM-DD input to a UTC-midnight Date for the lib', async () => {
    await caller().listSections({ branchId: 'branch_1', businessDate: '2026-08-19' });
    expect(mocks.listSections).toHaveBeenCalledWith(expect.anything(), {
      branchId: 'branch_1',
      businessDate: new Date(Date.UTC(2026, 7, 19)),
      includeInactive: undefined,
    });
  });

  it('converts the date for assignServer', async () => {
    await caller().assignServer({
      sectionId: 'section_1',
      staffProfileId: 'staff_1',
      businessDate: '2026-08-19',
    });
    expect(mocks.assignServer).toHaveBeenCalledWith(expect.anything(), {
      sectionId: 'section_1',
      staffProfileId: 'staff_1',
      businessDate: new Date(Date.UTC(2026, 7, 19)),
    });
  });
});

describe('domain-error → tRPC status mapping', () => {
  it('maps a NOT_FOUND reason to NOT_FOUND', async () => {
    mocks.updateFloor.mockRejectedValue(new FloorError('gone', 'FLOOR_NOT_FOUND'));
    await expect(caller().updateFloor({ id: 'gone', name: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('maps a duplicate table code to CONFLICT', async () => {
    mocks.createTable.mockRejectedValue(new FloorError('dupe', 'DUPLICATE_CODE'));
    await expect(
      caller().createTable({ floorId: 'floor_1', code: 'A1', capacity: 4 })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps a referenced table to CONFLICT', async () => {
    mocks.deleteTable.mockRejectedValue(new FloorError('referenced', 'REFERENCED'));
    await expect(caller().deleteTable({ id: 'table_1' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('maps an inactive staff assignment to BAD_REQUEST', async () => {
    mocks.assignServer.mockRejectedValue(new SectionError('inactive', 'STAFF_INACTIVE'));
    await expect(
      caller().assignServer({
        sectionId: 'section_1',
        staffProfileId: 'staff_1',
        businessDate: '2026-08-19',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('maps a default-station race to CONFLICT', async () => {
    mocks.setDefaultStation.mockRejectedValue(new StationError('race', 'DEFAULT_CONFLICT'));
    await expect(caller().setDefaultStation({ id: 'station_1' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('maps a bad routing target to BAD_REQUEST', async () => {
    mocks.createRoutingRule.mockRejectedValue(new StationError('xor', 'RULE_TARGET_INVALID'));
    await expect(caller().createRoutingRule({ stationId: 'station_1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('read contract (C10) + audit', () => {
  it('returns the listFloors read model verbatim', async () => {
    const result = await caller().listFloors({ branchId: 'branch_1' });
    expect(result).toEqual([{ id: 'floor_1', tables: [] }]);
  });

  it('returns the listStations read model verbatim', async () => {
    const result = await caller().listStations({ branchId: 'branch_1' });
    expect(result).toEqual([{ id: 'station_1', routingRules: [] }]);
  });

  it('audits a floor creation', async () => {
    await caller().createFloor({ branchId: 'branch_1', name: 'Patio' });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetType: 'RestaurantFloor', targetId: 'floor_new' })
    );
  });
});
