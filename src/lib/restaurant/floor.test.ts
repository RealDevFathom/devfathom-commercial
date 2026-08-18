import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FloorError,
  createFloor,
  createTable,
  deleteFloor,
  deleteTable,
  listFloors,
  updateFloor,
  updateTable,
} from './floor';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M4-L3 floor/table lib — branch-scoped validation, duplicate-code rejection,
 * deactivate-not-delete once referenced by order-table history, and the derived
 * occupancy read model. Runs against a hand-rolled in-memory `ScopedDb` (RLS is
 * exercised by the milestone-level `tests/restaurant-m4-rls.test.ts`).
 */

const mocks = vi.hoisted(() => ({
  branchFindUnique: vi.fn(),
  floorFindUnique: vi.fn(),
  floorCreate: vi.fn(),
  floorUpdate: vi.fn(),
  floorDelete: vi.fn(),
  floorFindMany: vi.fn(),
  tableFindFirst: vi.fn(),
  tableFindUnique: vi.fn(),
  tableCreate: vi.fn(),
  tableUpdate: vi.fn(),
  tableDelete: vi.fn(),
  orderTableCount: vi.fn(),
}));

const db = {
  restaurantBranch: { findUnique: mocks.branchFindUnique },
  restaurantFloor: {
    findUnique: mocks.floorFindUnique,
    create: mocks.floorCreate,
    update: mocks.floorUpdate,
    delete: mocks.floorDelete,
    findMany: mocks.floorFindMany,
  },
  restaurantTable: {
    findFirst: mocks.tableFindFirst,
    findUnique: mocks.tableFindUnique,
    create: mocks.tableCreate,
    update: mocks.tableUpdate,
    delete: mocks.tableDelete,
  },
  restaurantOrderTable: { count: mocks.orderTableCount },
} as unknown as ScopedDb;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.branchFindUnique.mockResolvedValue({ id: 'branch_1' });
  mocks.floorFindUnique.mockResolvedValue({ id: 'floor_1', branchId: 'branch_1' });
  mocks.floorCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'floor_new',
    ...data,
  }));
  mocks.floorUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      name: 'Existing',
      ...data,
    })
  );
  mocks.floorDelete.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    name: 'Deleted',
  }));
  mocks.tableFindFirst.mockResolvedValue(null);
  mocks.tableFindUnique.mockResolvedValue({ id: 'table_1', floorId: 'floor_1' });
  mocks.tableCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'table_new',
    ...data,
  }));
  mocks.tableUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      code: 'T1',
      ...data,
    })
  );
  mocks.tableDelete.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    code: 'T1',
  }));
  mocks.orderTableCount.mockResolvedValue(0);
});

describe('createFloor', () => {
  it('trims the name, defaults sortOrder, and validates the branch is in scope', async () => {
    await createFloor(db, { branchId: 'branch_1', name: '  Patio  ' });
    expect(mocks.branchFindUnique).toHaveBeenCalledWith({
      where: { id: 'branch_1' },
      select: { id: true },
    });
    expect(mocks.floorCreate).toHaveBeenCalledWith({
      data: { branchId: 'branch_1', name: 'Patio', sortOrder: 0 },
    });
  });

  it('rejects a blank name', async () => {
    await expect(createFloor(db, { branchId: 'branch_1', name: '   ' })).rejects.toMatchObject({
      reason: 'INVALID',
    });
  });

  it('rejects an out-of-tenant branch as BRANCH_NOT_FOUND', async () => {
    mocks.branchFindUnique.mockResolvedValue(null);
    await expect(
      createFloor(db, { branchId: 'branch_other', name: 'Patio' })
    ).rejects.toMatchObject({ reason: 'BRANCH_NOT_FOUND' });
    expect(mocks.floorCreate).not.toHaveBeenCalled();
  });
});

describe('updateFloor', () => {
  it('maps a missing floor to FLOOR_NOT_FOUND', async () => {
    mocks.floorFindUnique.mockResolvedValue(null);
    await expect(updateFloor(db, 'gone', { name: 'x' })).rejects.toMatchObject({
      reason: 'FLOOR_NOT_FOUND',
    });
  });

  it('applies only the fields present in the patch', async () => {
    await updateFloor(db, 'floor_1', { active: false });
    expect(mocks.floorUpdate).toHaveBeenCalledWith({
      where: { id: 'floor_1' },
      data: { active: false },
    });
  });
});

describe('deleteFloor (deactivate-not-delete once referenced)', () => {
  it('refuses to delete a floor whose tables have order history', async () => {
    mocks.orderTableCount.mockResolvedValue(2);
    await expect(deleteFloor(db, 'floor_1')).rejects.toMatchObject({ reason: 'REFERENCED' });
    expect(mocks.floorDelete).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced floor', async () => {
    await deleteFloor(db, 'floor_1');
    expect(mocks.floorDelete).toHaveBeenCalledWith({ where: { id: 'floor_1' } });
  });
});

describe('createTable', () => {
  it('rejects a duplicate code within the floor', async () => {
    mocks.tableFindFirst.mockResolvedValue({ id: 'table_existing' });
    await expect(
      createTable(db, { floorId: 'floor_1', code: 'A1', capacity: 4 })
    ).rejects.toMatchObject({ reason: 'DUPLICATE_CODE' });
    expect(mocks.tableCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-positive or non-integer capacity', async () => {
    await expect(
      createTable(db, { floorId: 'floor_1', code: 'A1', capacity: 0 })
    ).rejects.toMatchObject({ reason: 'INVALID' });
    await expect(
      createTable(db, { floorId: 'floor_1', code: 'A1', capacity: 2.5 })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('rejects an out-of-tenant floor as FLOOR_NOT_FOUND', async () => {
    mocks.floorFindUnique.mockResolvedValue(null);
    await expect(
      createTable(db, { floorId: 'floor_other', code: 'A1', capacity: 4 })
    ).rejects.toMatchObject({ reason: 'FLOOR_NOT_FOUND' });
  });

  it('creates the table with a trimmed code', async () => {
    await createTable(db, { floorId: 'floor_1', code: ' A1 ', capacity: 4 });
    expect(mocks.tableCreate).toHaveBeenCalledWith({
      data: { floorId: 'floor_1', code: 'A1', capacity: 4 },
    });
  });
});

describe('updateTable', () => {
  it('maps a missing table to TABLE_NOT_FOUND', async () => {
    mocks.tableFindUnique.mockResolvedValue(null);
    await expect(updateTable(db, 'gone', { capacity: 6 })).rejects.toMatchObject({
      reason: 'TABLE_NOT_FOUND',
    });
  });

  it('excludes its own row from the code-uniqueness check', async () => {
    await updateTable(db, 'table_1', { code: 'B2' });
    expect(mocks.tableFindFirst).toHaveBeenCalledWith({
      where: { floorId: 'floor_1', code: 'B2', id: { not: 'table_1' } },
      select: { id: true },
    });
  });

  it('deactivates a table (soft removal)', async () => {
    await updateTable(db, 'table_1', { active: false });
    expect(mocks.tableUpdate).toHaveBeenCalledWith({
      where: { id: 'table_1' },
      data: { active: false },
    });
  });
});

describe('deleteTable (deactivate-not-delete once referenced)', () => {
  it('refuses to delete a table with order history', async () => {
    mocks.orderTableCount.mockResolvedValue(1);
    await expect(deleteTable(db, 'table_1')).rejects.toMatchObject({ reason: 'REFERENCED' });
    expect(mocks.tableDelete).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced table', async () => {
    await deleteTable(db, 'table_1');
    expect(mocks.tableDelete).toHaveBeenCalledWith({ where: { id: 'table_1' } });
  });
});

describe('listFloors (occupancy read model)', () => {
  it('filters to active floors/tables by default and derives occupancy from active links', async () => {
    mocks.floorFindMany.mockResolvedValue([
      {
        id: 'floor_1',
        branchId: 'branch_1',
        name: 'Main',
        sortOrder: 0,
        active: true,
        tables: [
          { id: 't1', code: 'A1', capacity: 4, active: true, orderLinks: [{ orderId: 'o1' }] },
          { id: 't2', code: 'A2', capacity: 2, active: true, orderLinks: [] },
        ],
      },
    ]);

    const floors = await listFloors(db, { branchId: 'branch_1' });

    const where = mocks.floorFindMany.mock.calls[0][0].where;
    expect(where).toEqual({ branchId: 'branch_1', active: true });
    expect(floors[0].tables).toEqual([
      { id: 't1', code: 'A1', capacity: 4, active: true, occupied: true, activeOrderIds: ['o1'] },
      { id: 't2', code: 'A2', capacity: 2, active: true, occupied: false, activeOrderIds: [] },
    ]);
  });

  it('includes inactive rows when asked', async () => {
    mocks.floorFindMany.mockResolvedValue([]);
    await listFloors(db, { branchId: 'branch_1', includeInactive: true });
    expect(mocks.floorFindMany.mock.calls[0][0].where).toEqual({ branchId: 'branch_1' });
  });
});

describe('FloorError', () => {
  it('carries its reason', () => {
    const err = new FloorError('nope', 'INVALID');
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe('INVALID');
  });
});
