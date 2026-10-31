import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import {
  StationError,
  createRoutingRule,
  createStation,
  deleteRoutingRule,
  deleteStation,
  listStations,
  setDefaultStation,
  updateRoutingRule,
  updateStation,
} from './stations';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M4-L3 stations lib — the one-default-per-branch invariant (auto-default the
 * first station; promotion clears the incumbent; the partial-unique P2002 a race
 * loses surfaces as DEFAULT_CONFLICT), routing-rule product-XOR-category
 * validation with same-org reference checks, and the routing read model.
 * In-memory `ScopedDb` fake; RLS is exercised by `tests/restaurant-m4-rls.test.ts`.
 */

const P2002 = new Prisma.PrismaClientKnownRequestError('unique', {
  code: 'P2002',
  clientVersion: 'test',
});

const P2025 = new Prisma.PrismaClientKnownRequestError('record not found', {
  code: 'P2025',
  clientVersion: 'test',
});

const mocks = vi.hoisted(() => ({
  branchFindUnique: vi.fn(),
  stationFindUnique: vi.fn(),
  stationFindFirst: vi.fn(),
  stationCreate: vi.fn(),
  stationUpdate: vi.fn(),
  stationUpdateMany: vi.fn(),
  stationDelete: vi.fn(),
  stationFindUniqueOrThrow: vi.fn(),
  stationFindMany: vi.fn(),
  ticketCount: vi.fn(),
  productFindUnique: vi.fn(),
  categoryFindUnique: vi.fn(),
  ruleFindUnique: vi.fn(),
  ruleCreate: vi.fn(),
  ruleUpdate: vi.fn(),
  ruleDelete: vi.fn(),
  transaction: vi.fn(),
}));

const db = {
  restaurantBranch: { findUnique: mocks.branchFindUnique },
  restaurantKitchenStation: {
    findUnique: mocks.stationFindUnique,
    findFirst: mocks.stationFindFirst,
    create: mocks.stationCreate,
    update: mocks.stationUpdate,
    updateMany: mocks.stationUpdateMany,
    delete: mocks.stationDelete,
    findUniqueOrThrow: mocks.stationFindUniqueOrThrow,
    findMany: mocks.stationFindMany,
  },
  restaurantKitchenTicket: { count: mocks.ticketCount },
  restaurantProduct: { findUnique: mocks.productFindUnique },
  restaurantCategory: { findUnique: mocks.categoryFindUnique },
  restaurantStationRoutingRule: {
    findUnique: mocks.ruleFindUnique,
    create: mocks.ruleCreate,
    update: mocks.ruleUpdate,
    delete: mocks.ruleDelete,
  },
  $transaction: mocks.transaction,
} as unknown as ScopedDb;

/** Model a competing write committed after the initial read, before our update. */
function raceStationChange(change: { active?: boolean; isDefault?: boolean }) {
  const station = { id: 'station_1', branchId: 'branch_1', active: true, isDefault: false };
  mocks.stationFindUnique.mockImplementationOnce(async () => {
    const snapshot = { ...station };
    Object.assign(station, change);
    return snapshot;
  });
  mocks.stationUpdate.mockImplementationOnce(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (!Object.entries(where).every(([key, value]) => Reflect.get(station, key) === value)) {
        throw P2025;
      }
      Object.assign(station, data);
      return { ...station };
    }
  );
  return station;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.branchFindUnique.mockResolvedValue({ id: 'branch_1' });
  mocks.stationFindUnique.mockResolvedValue({
    id: 'station_1',
    branchId: 'branch_1',
    isDefault: false,
    active: true,
  });
  mocks.stationFindFirst.mockResolvedValue(null); // no default yet by default
  mocks.stationCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'station_new',
    ...data,
  }));
  mocks.stationUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      branchId: 'branch_1',
      name: 'Existing',
      ...data,
    })
  );
  mocks.stationUpdateMany.mockResolvedValue({ count: 0 });
  mocks.stationDelete.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    name: 'Deleted',
  }));
  mocks.stationFindUniqueOrThrow.mockResolvedValue({
    id: 'station_1',
    name: 'Grill',
    isDefault: true,
  });
  mocks.ticketCount.mockResolvedValue(0);
  mocks.productFindUnique.mockResolvedValue({ id: 'product_1' });
  mocks.categoryFindUnique.mockResolvedValue({ id: 'category_1' });
  mocks.ruleFindUnique.mockResolvedValue({ id: 'rule_1' });
  mocks.ruleCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'rule_new',
    ...data,
  }));
  mocks.ruleUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      ...data,
    })
  );
  mocks.ruleDelete.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    stationId: 'station_1',
  }));
  mocks.transaction.mockImplementation(async (cb: (tx: ScopedDb) => Promise<unknown>) => cb(db));
});

describe('createStation (one-default-per-branch invariant)', () => {
  it('auto-defaults the first station in a branch, clearing any incumbent first', async () => {
    await createStation(db, { branchId: 'branch_1', name: 'Grill' });
    expect(mocks.stationUpdateMany).toHaveBeenCalledWith({
      where: { branchId: 'branch_1', isDefault: true },
      data: { isDefault: false },
    });
    expect(mocks.stationCreate).toHaveBeenCalledWith({
      data: { branchId: 'branch_1', name: 'Grill', isDefault: true },
    });
  });

  it('does not default a later station when one already exists', async () => {
    mocks.stationFindFirst.mockResolvedValue({ id: 'station_default' });
    await createStation(db, { branchId: 'branch_1', name: 'Bar' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.stationCreate).toHaveBeenCalledWith({
      data: { branchId: 'branch_1', name: 'Bar', isDefault: false },
    });
  });

  it('honours an explicit isDefault, clearing the incumbent', async () => {
    mocks.stationFindFirst.mockResolvedValue({ id: 'station_default' });
    await createStation(db, { branchId: 'branch_1', name: 'Expo', isDefault: true });
    expect(mocks.stationUpdateMany).toHaveBeenCalled();
    expect(mocks.stationCreate).toHaveBeenCalledWith({
      data: { branchId: 'branch_1', name: 'Expo', isDefault: true },
    });
  });

  it('surfaces a concurrent default race (P2002) as DEFAULT_CONFLICT', async () => {
    mocks.stationCreate.mockRejectedValueOnce(P2002);
    await expect(createStation(db, { branchId: 'branch_1', name: 'Grill' })).rejects.toMatchObject({
      reason: 'DEFAULT_CONFLICT',
    });
  });

  it('rejects an out-of-tenant branch', async () => {
    mocks.branchFindUnique.mockResolvedValue(null);
    await expect(createStation(db, { branchId: 'x', name: 'Grill' })).rejects.toMatchObject({
      reason: 'BRANCH_NOT_FOUND',
    });
  });
});

describe('updateStation', () => {
  it('refuses deactivation if the station becomes default after the initial read', async () => {
    const station = raceStationChange({ isDefault: true });

    await expect(updateStation(db, station.id, { active: false })).rejects.toMatchObject({
      reason: 'INVALID',
    });
    expect(station).toMatchObject({ active: true, isDefault: true });
  });

  it('refuses to deactivate the current default station', async () => {
    mocks.stationFindUnique.mockResolvedValue({
      id: 'station_1',
      branchId: 'branch_1',
      isDefault: true,
    });
    await expect(updateStation(db, 'station_1', { active: false })).rejects.toMatchObject({
      reason: 'INVALID',
    });
    expect(mocks.stationUpdate).not.toHaveBeenCalled();
  });

  it('updates name and active for a non-default station', async () => {
    await updateStation(db, 'station_1', { name: 'Grill 2', active: false });
    expect(mocks.stationUpdate).toHaveBeenCalledWith({
      where: { id: 'station_1', isDefault: false },
      data: { name: 'Grill 2', active: false },
    });
  });

  it('maps a missing station to STATION_NOT_FOUND', async () => {
    mocks.stationFindUnique.mockResolvedValue(null);
    await expect(updateStation(db, 'gone', { name: 'x' })).rejects.toMatchObject({
      reason: 'STATION_NOT_FOUND',
    });
  });
});

describe('setDefaultStation', () => {
  it('refuses promotion if the station becomes inactive after the initial read', async () => {
    const station = raceStationChange({ active: false });

    await expect(setDefaultStation(db, station.id)).rejects.toMatchObject({ reason: 'INVALID' });
    expect(station).toMatchObject({ active: false, isDefault: false });
  });

  it('clears the incumbent default (excluding self) and promotes the target', async () => {
    mocks.stationFindUnique.mockResolvedValue({
      id: 'station_2',
      branchId: 'branch_1',
      isDefault: false,
      active: true,
    });
    await setDefaultStation(db, 'station_2');
    expect(mocks.stationUpdateMany).toHaveBeenCalledWith({
      where: { branchId: 'branch_1', isDefault: true, id: { not: 'station_2' } },
      data: { isDefault: false },
    });
    expect(mocks.stationUpdate).toHaveBeenCalledWith({
      where: { id: 'station_2', active: true },
      data: { isDefault: true },
    });
  });

  it('is a no-op when the station is already the default', async () => {
    mocks.stationFindUnique.mockResolvedValue({
      id: 'station_1',
      branchId: 'branch_1',
      isDefault: true,
      active: true,
    });
    await setDefaultStation(db, 'station_1');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.stationFindUniqueOrThrow).toHaveBeenCalled();
  });

  it('surfaces a concurrent promotion race (P2002) as DEFAULT_CONFLICT', async () => {
    mocks.stationFindUnique.mockResolvedValue({
      id: 'station_2',
      branchId: 'branch_1',
      isDefault: false,
      active: true,
    });
    mocks.stationUpdate.mockRejectedValueOnce(P2002);
    await expect(setDefaultStation(db, 'station_2')).rejects.toMatchObject({
      reason: 'DEFAULT_CONFLICT',
    });
  });

  it('refuses to promote an inactive station without clearing the live default', async () => {
    mocks.stationFindUnique.mockResolvedValue({
      id: 'station_2',
      branchId: 'branch_1',
      isDefault: false,
      active: false,
    });
    await expect(setDefaultStation(db, 'station_2')).rejects.toMatchObject({ reason: 'INVALID' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.stationUpdateMany).not.toHaveBeenCalled();
  });
});

describe('deleteStation', () => {
  it('refuses to delete a station referenced by kitchen tickets', async () => {
    mocks.ticketCount.mockResolvedValue(4);
    await expect(deleteStation(db, 'station_1')).rejects.toMatchObject({
      reason: 'STATION_REFERENCED',
    });
    expect(mocks.stationDelete).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced station (routing rules cascade)', async () => {
    await deleteStation(db, 'station_1');
    expect(mocks.stationDelete).toHaveBeenCalledWith({ where: { id: 'station_1' } });
  });
});

describe('createRoutingRule (product/category/course XOR, same-org refs)', () => {
  it('rejects a rule with neither target', async () => {
    await expect(createRoutingRule(db, { stationId: 'station_1' })).rejects.toMatchObject({
      reason: 'RULE_TARGET_INVALID',
    });
  });

  it('rejects a rule targeting both a product and a category', async () => {
    await expect(
      createRoutingRule(db, { stationId: 'station_1', productId: 'p1', categoryId: 'c1' })
    ).rejects.toMatchObject({ reason: 'RULE_TARGET_INVALID' });
  });

  it('rejects an out-of-tenant product reference', async () => {
    mocks.productFindUnique.mockResolvedValue(null);
    await expect(
      createRoutingRule(db, { stationId: 'station_1', productId: 'p_other' })
    ).rejects.toMatchObject({ reason: 'PRODUCT_NOT_FOUND' });
    expect(mocks.ruleCreate).not.toHaveBeenCalled();
  });

  it('rejects an out-of-tenant category reference', async () => {
    mocks.categoryFindUnique.mockResolvedValue(null);
    await expect(
      createRoutingRule(db, { stationId: 'station_1', categoryId: 'c_other' })
    ).rejects.toMatchObject({ reason: 'CATEGORY_NOT_FOUND' });
  });

  it('rejects an out-of-tenant station', async () => {
    mocks.stationFindUnique.mockResolvedValue(null);
    await expect(
      createRoutingRule(db, { stationId: 'station_other', productId: 'p1' })
    ).rejects.toMatchObject({ reason: 'STATION_NOT_FOUND' });
  });

  it('creates a product rule with a default priority of 0', async () => {
    await createRoutingRule(db, { stationId: 'station_1', productId: 'product_1' });
    expect(mocks.ruleCreate).toHaveBeenCalledWith({
      data: {
        stationId: 'station_1',
        productId: 'product_1',
        categoryId: null,
        course: null,
        priority: 0,
      },
    });
  });

  it('creates a category rule with the given priority', async () => {
    await createRoutingRule(db, { stationId: 'station_1', categoryId: 'category_1', priority: 5 });
    expect(mocks.ruleCreate).toHaveBeenCalledWith({
      data: {
        stationId: 'station_1',
        productId: null,
        categoryId: 'category_1',
        course: null,
        priority: 5,
      },
    });
  });

  it('creates a positive course rule without a catalog lookup', async () => {
    await createRoutingRule(db, { stationId: 'station_1', course: 3 });
    expect(mocks.ruleCreate).toHaveBeenCalledWith({
      data: {
        stationId: 'station_1',
        productId: null,
        categoryId: null,
        course: 3,
        priority: 0,
      },
    });
    expect(mocks.productFindUnique).not.toHaveBeenCalled();
    expect(mocks.categoryFindUnique).not.toHaveBeenCalled();
  });
});

describe('updateRoutingRule / deleteRoutingRule', () => {
  it('updates the priority', async () => {
    await updateRoutingRule(db, 'rule_1', { priority: 9 });
    expect(mocks.ruleUpdate).toHaveBeenCalledWith({
      where: { id: 'rule_1' },
      data: { priority: 9 },
    });
  });

  it('maps a missing rule to RULE_NOT_FOUND on update and delete', async () => {
    mocks.ruleFindUnique.mockResolvedValue(null);
    await expect(updateRoutingRule(db, 'gone', { priority: 1 })).rejects.toMatchObject({
      reason: 'RULE_NOT_FOUND',
    });
    await expect(deleteRoutingRule(db, 'gone')).rejects.toMatchObject({ reason: 'RULE_NOT_FOUND' });
  });

  it('deletes an existing rule', async () => {
    await deleteRoutingRule(db, 'rule_1');
    expect(mocks.ruleDelete).toHaveBeenCalledWith({ where: { id: 'rule_1' } });
  });
});

describe('listStations (routing read model)', () => {
  it('maps stations to their routing rules with product/category names', async () => {
    mocks.stationFindMany.mockResolvedValue([
      {
        id: 'station_1',
        branchId: 'branch_1',
        name: 'Grill',
        active: true,
        isDefault: true,
        routingRules: [
          {
            id: 'r1',
            priority: 10,
            productId: 'p1',
            categoryId: null,
            product: { name: 'Steak' },
            category: null,
          },
          {
            id: 'r2',
            priority: 0,
            productId: null,
            categoryId: 'c1',
            product: null,
            category: { name: 'Mains' },
          },
        ],
      },
    ]);

    const stations = await listStations(db, { branchId: 'branch_1' });

    expect(mocks.stationFindMany.mock.calls[0][0].where).toEqual({
      branchId: 'branch_1',
      active: true,
    });
    expect(stations[0].routingRules).toEqual([
      {
        id: 'r1',
        priority: 10,
        productId: 'p1',
        productName: 'Steak',
        categoryId: null,
        categoryName: null,
      },
      {
        id: 'r2',
        priority: 0,
        productId: null,
        productName: null,
        categoryId: 'c1',
        categoryName: 'Mains',
      },
    ]);
  });
});

describe('StationError', () => {
  it('carries its reason', () => {
    expect(new StationError('nope', 'INVALID').reason).toBe('INVALID');
  });
});
