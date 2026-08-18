import 'server-only';

import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M4-L3 / §4 — restaurant floors and tables (branch-scoped server config) plus
 * the live table-occupancy read model.
 *
 * A floor is a physical area within a branch that holds tables; a table carries
 * a human `code` unique within its floor and a seat `capacity`. Every function
 * takes a tenant-scoped `ScopedDb`: `organizationId` is supplied by the RLS
 * default on the row and must never be forged by the caller, and every reference
 * lookup (branch, floor) is RLS-scoped so a cross-tenant id is simply invisible
 * (returns null) and rejected here as a friendly domain error before the
 * composite tenant foreign keys in the migration would reject it (C1).
 *
 * Occupancy is a DERIVED read, never a stored column (C3 spirit): a table is
 * occupied iff it currently has one or more ACTIVE `RestaurantOrderTable` links
 * (the seating links L2 maintains). Deletion is guarded to preserve that
 * order-table history — a table (or a floor holding such a table) that has ever
 * been linked to an order is deactivated, never hard-deleted, because the link
 * FK cascades and a hard delete would erase the history rows.
 */

export type FloorErrorReason =
  | 'INVALID'
  | 'BRANCH_NOT_FOUND'
  | 'FLOOR_NOT_FOUND'
  | 'TABLE_NOT_FOUND'
  | 'DUPLICATE_CODE'
  | 'REFERENCED';

export class FloorError extends Error {
  constructor(
    message: string,
    readonly reason: FloorErrorReason
  ) {
    super(message);
    this.name = 'FloorError';
  }
}

/** A referenced branch must exist in the caller's organization (RLS scopes the lookup). */
async function assertBranchInScope(db: ScopedDb, branchId: string): Promise<void> {
  const branch = await db.restaurantBranch.findUnique({
    where: { id: branchId },
    select: { id: true },
  });
  if (!branch) {
    throw new FloorError('The branch does not exist.', 'BRANCH_NOT_FOUND');
  }
}

/** Load a floor in scope (or throw), returning its branch id for downstream checks. */
async function requireFloor(db: ScopedDb, id: string): Promise<{ id: string; branchId: string }> {
  const floor = await db.restaurantFloor.findUnique({
    where: { id },
    select: { id: true, branchId: true },
  });
  if (!floor) {
    throw new FloorError('Floor not found.', 'FLOOR_NOT_FOUND');
  }
  return floor;
}

function requireName(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new FloorError(`A ${label} is required.`, 'INVALID');
  }
  return trimmed;
}

// ── Floors ───────────────────────────────────────────────────────────────────

export type CreateFloorInput = {
  branchId: string;
  name: string;
  sortOrder?: number;
};

export async function createFloor(db: ScopedDb, input: CreateFloorInput) {
  const name = requireName(input.name, 'floor name');
  await assertBranchInScope(db, input.branchId);
  return db.restaurantFloor.create({
    data: { branchId: input.branchId, name, sortOrder: input.sortOrder ?? 0 },
  });
}

export type UpdateFloorInput = {
  name?: string;
  sortOrder?: number;
  active?: boolean;
};

/** Partial update. A field absent from `patch` is left untouched. */
export async function updateFloor(db: ScopedDb, id: string, patch: UpdateFloorInput) {
  await requireFloor(db, id);
  const data: Prisma.RestaurantFloorUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'floor name');
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  if (patch.active !== undefined) data.active = patch.active;
  return db.restaurantFloor.update({ where: { id }, data });
}

/**
 * Hard-delete a floor. Refused when any table on the floor has ever been linked
 * to an order — the link FK cascades, so a delete would erase order-table
 * history; deactivate the floor instead (deactivate-not-delete once referenced).
 * An unreferenced floor cascades its (also unreferenced) tables away.
 */
export async function deleteFloor(db: ScopedDb, id: string) {
  await requireFloor(db, id);
  const linked = await db.restaurantOrderTable.count({ where: { table: { floorId: id } } });
  if (linked > 0) {
    throw new FloorError(
      'This floor has tables with order history; deactivate it instead of deleting.',
      'REFERENCED'
    );
  }
  return db.restaurantFloor.delete({ where: { id } });
}

// ── Tables ───────────────────────────────────────────────────────────────────

/** Reject a duplicate table code within the same floor before it reaches the
 * `(floorId, code)` unique index; `excludeId` lets an update ignore its own row. */
async function assertCodeAvailable(
  db: ScopedDb,
  floorId: string,
  code: string,
  excludeId: string | null
): Promise<void> {
  const clash = await db.restaurantTable.findFirst({
    where: { floorId, code, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (clash) {
    throw new FloorError(`A table with code "${code}" already exists on this floor.`, 'DUPLICATE_CODE');
  }
}

export type CreateTableInput = {
  floorId: string;
  code: string;
  capacity: number;
};

export async function createTable(db: ScopedDb, input: CreateTableInput) {
  const code = requireName(input.code, 'table code');
  if (!Number.isInteger(input.capacity) || input.capacity < 1) {
    throw new FloorError('A table capacity must be a positive whole number.', 'INVALID');
  }
  await requireFloor(db, input.floorId);
  await assertCodeAvailable(db, input.floorId, code, null);
  return db.restaurantTable.create({
    data: { floorId: input.floorId, code, capacity: input.capacity },
  });
}

export type UpdateTableInput = {
  code?: string;
  capacity?: number;
  active?: boolean;
};

export async function updateTable(db: ScopedDb, id: string, patch: UpdateTableInput) {
  const existing = await db.restaurantTable.findUnique({
    where: { id },
    select: { id: true, floorId: true },
  });
  if (!existing) {
    throw new FloorError('Table not found.', 'TABLE_NOT_FOUND');
  }
  const data: Prisma.RestaurantTableUncheckedUpdateInput = {};
  if (patch.code !== undefined) {
    const code = requireName(patch.code, 'table code');
    await assertCodeAvailable(db, existing.floorId, code, id);
    data.code = code;
  }
  if (patch.capacity !== undefined) {
    if (!Number.isInteger(patch.capacity) || patch.capacity < 1) {
      throw new FloorError('A table capacity must be a positive whole number.', 'INVALID');
    }
    data.capacity = patch.capacity;
  }
  if (patch.active !== undefined) data.active = patch.active;
  return db.restaurantTable.update({ where: { id }, data });
}

/**
 * Hard-delete a table. Refused once the table has any order-table link history
 * (deactivate instead) so seating history is never cascade-erased.
 */
export async function deleteTable(db: ScopedDb, id: string) {
  const existing = await db.restaurantTable.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    throw new FloorError('Table not found.', 'TABLE_NOT_FOUND');
  }
  const linked = await db.restaurantOrderTable.count({ where: { tableId: id } });
  if (linked > 0) {
    throw new FloorError(
      'This table has order history; deactivate it instead of deleting.',
      'REFERENCED'
    );
  }
  return db.restaurantTable.delete({ where: { id } });
}

// ── Occupancy read model (C10 read contract, consumed by L5a) ─────────────────

export type TableOccupancyView = {
  id: string;
  code: string;
  capacity: number;
  active: boolean;
  /** Derived (C3 spirit): true iff one or more active order-table links exist. */
  occupied: boolean;
  /** The orders currently seated at this table (active links). */
  activeOrderIds: string[];
};

export type FloorView = {
  id: string;
  branchId: string;
  name: string;
  sortOrder: number;
  active: boolean;
  tables: TableOccupancyView[];
};

export type ListFloorsInput = {
  branchId: string;
  /** Include deactivated floors/tables in the result (default: active only). */
  includeInactive?: boolean;
};

/**
 * The `listFloors` read contract: a branch's floors, each with its tables and the
 * live occupancy derived from active `RestaurantOrderTable` links. Ordered by
 * `sortOrder` then name (floors) and by `code` (tables) for a stable layout.
 */
export async function listFloors(db: ScopedDb, input: ListFloorsInput): Promise<FloorView[]> {
  const floors = await db.restaurantFloor.findMany({
    where: { branchId: input.branchId, ...(input.includeInactive ? {} : { active: true }) },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      branchId: true,
      name: true,
      sortOrder: true,
      active: true,
      tables: {
        where: input.includeInactive ? {} : { active: true },
        orderBy: { code: 'asc' },
        select: {
          id: true,
          code: true,
          capacity: true,
          active: true,
          orderLinks: { where: { active: true }, select: { orderId: true } },
        },
      },
    },
  });

  return floors.map((floor) => ({
    id: floor.id,
    branchId: floor.branchId,
    name: floor.name,
    sortOrder: floor.sortOrder,
    active: floor.active,
    tables: floor.tables.map((table) => ({
      id: table.id,
      code: table.code,
      capacity: table.capacity,
      active: table.active,
      occupied: table.orderLinks.length > 0,
      activeOrderIds: table.orderLinks.map((link) => link.orderId),
    })),
  }));
}
