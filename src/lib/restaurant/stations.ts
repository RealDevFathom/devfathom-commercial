import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M4-L3 / §4 — restaurant kitchen stations and their routing rules.
 *
 * A station is a prep/service point (grill, bar, expo) within a branch. Exactly
 * one station per branch is the default (the routing fall-through target); the
 * "at most one default" half is enforced by a partial unique index in the
 * migration (`restaurant_kitchen_stations_branch_default_key`) and this module
 * keeps it single by clearing the incumbent default in the same transaction that
 * promotes a new one, and by treating the P2002 a concurrent promotion loses as a
 * conflict (never a silent double-default). The "at least one" half is maintained
 * by defaulting a branch's FIRST station automatically.
 *
 * A routing rule targets exactly one of a product, category or course (the DB CHECK
 * enforces the XOR; this layer rejects it earlier as a friendly error) and
 * carries a `priority`; resolution precedence lives in the pure
 * `station-routing.ts` (product > category > course > default, priority breaking ties).
 * Referenced station/product/category rows are validated in scope so a
 * cross-tenant reference is rejected here before the composite tenant foreign
 * keys would reject it (C1).
 */

export type StationErrorReason =
  | 'INVALID'
  | 'BRANCH_NOT_FOUND'
  | 'STATION_NOT_FOUND'
  | 'STATION_REFERENCED'
  | 'DEFAULT_CONFLICT'
  | 'RULE_NOT_FOUND'
  | 'RULE_TARGET_INVALID'
  | 'PRODUCT_NOT_FOUND'
  | 'CATEGORY_NOT_FOUND';

export class StationError extends Error {
  constructor(
    message: string,
    readonly reason: StationErrorReason
  ) {
    super(message);
    this.name = 'StationError';
  }
}

function requireName(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new StationError(`A ${label} is required.`, 'INVALID');
  }
  return trimmed;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function isRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

async function assertBranchInScope(db: ScopedDb, branchId: string): Promise<void> {
  const branch = await db.restaurantBranch.findUnique({
    where: { id: branchId },
    select: { id: true },
  });
  if (!branch) {
    throw new StationError('The branch does not exist.', 'BRANCH_NOT_FOUND');
  }
}

async function requireStation(
  db: ScopedDb,
  id: string
): Promise<{ id: string; branchId: string; isDefault: boolean; active: boolean }> {
  const station = await db.restaurantKitchenStation.findUnique({
    where: { id },
    select: { id: true, branchId: true, isDefault: true, active: true },
  });
  if (!station) {
    throw new StationError('Station not found.', 'STATION_NOT_FOUND');
  }
  return station;
}

async function branchHasDefault(db: ScopedDb, branchId: string): Promise<boolean> {
  const existing = await db.restaurantKitchenStation.findFirst({
    where: { branchId, isDefault: true },
    select: { id: true },
  });
  return existing !== null;
}

// ── Stations ─────────────────────────────────────────────────────────────────

export type CreateStationInput = {
  branchId: string;
  name: string;
  /** Force this station to be the branch default. When omitted, a branch's first
   * station becomes the default automatically and later ones do not. */
  isDefault?: boolean;
};

export async function createStation(db: ScopedDb, input: CreateStationInput) {
  const name = requireName(input.name, 'station name');
  await assertBranchInScope(db, input.branchId);
  const makeDefault =
    input.isDefault === true ||
    (input.isDefault === undefined && !(await branchHasDefault(db, input.branchId)));

  if (!makeDefault) {
    return db.restaurantKitchenStation.create({
      data: { branchId: input.branchId, name, isDefault: false },
    });
  }

  try {
    return await db.$transaction(async (tx) => {
      await tx.restaurantKitchenStation.updateMany({
        where: { branchId: input.branchId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.restaurantKitchenStation.create({
        data: { branchId: input.branchId, name, isDefault: true },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new StationError(
        'Another default station was set for this branch concurrently; retry.',
        'DEFAULT_CONFLICT'
      );
    }
    throw err;
  }
}

export type UpdateStationInput = {
  name?: string;
  active?: boolean;
};

/**
 * Update a station's name/active flag. Deactivating the current default station
 * is refused — promote another station to default first (`setDefaultStation`) so
 * the routing fall-through never points at an inactive station.
 */
export async function updateStation(db: ScopedDb, id: string, patch: UpdateStationInput) {
  const station = await requireStation(db, id);
  const data: Prisma.RestaurantKitchenStationUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'station name');
  if (patch.active !== undefined) {
    if (patch.active === false && station.isDefault) {
      throw new StationError(
        'Reassign the branch default before deactivating this station.',
        'INVALID'
      );
    }
    data.active = patch.active;
  }
  try {
    // Recheck at write time: another request may have promoted this station
    // since requireStation read it. The predicate is evaluated under the row lock.
    return await db.restaurantKitchenStation.update({
      where: { id, ...(patch.active === false ? { isDefault: false } : {}) },
      data,
    });
  } catch (err) {
    if (patch.active === false && isRecordNotFound(err)) {
      throw new StationError(
        'The station changed concurrently; reload before deactivating it.',
        'INVALID'
      );
    }
    throw err;
  }
}

/**
 * Promote a station to be its branch's default, clearing the incumbent default in
 * the same transaction. The partial unique index is the concurrency backstop: a
 * promotion that races another for the same branch surfaces as DEFAULT_CONFLICT
 * rather than leaving two defaults.
 */
export async function setDefaultStation(db: ScopedDb, id: string) {
  const station = await requireStation(db, id);
  if (!station.active) {
    throw new StationError(
      'Reactivate this station before making it the branch default.',
      'INVALID'
    );
  }
  if (station.isDefault) return db.restaurantKitchenStation.findUniqueOrThrow({ where: { id } });
  try {
    return await db.$transaction(async (tx) => {
      await tx.restaurantKitchenStation.updateMany({
        where: { branchId: station.branchId, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
      // A concurrent deactivation must reject the promotion and roll back the
      // incumbent's demotion in this transaction.
      return tx.restaurantKitchenStation.update({
        where: { id, active: true },
        data: { isDefault: true },
      });
    });
  } catch (err) {
    if (isRecordNotFound(err)) {
      throw new StationError(
        'The station changed concurrently; reload before making it the branch default.',
        'INVALID'
      );
    }
    if (isUniqueViolation(err)) {
      throw new StationError(
        'Another default station was set for this branch concurrently; retry.',
        'DEFAULT_CONFLICT'
      );
    }
    throw err;
  }
}

/**
 * Hard-delete a station. Refused once kitchen tickets reference it (the ticket FK
 * is `Restrict`); deactivate it instead. Routing rules cascade away.
 */
export async function deleteStation(db: ScopedDb, id: string) {
  await requireStation(db, id);
  const tickets = await db.restaurantKitchenTicket.count({ where: { stationId: id } });
  if (tickets > 0) {
    throw new StationError(
      'This station has kitchen tickets; deactivate it instead of deleting.',
      'STATION_REFERENCED'
    );
  }
  return db.restaurantKitchenStation.delete({ where: { id } });
}

// ── Routing rules ────────────────────────────────────────────────────────────

export type CreateRoutingRuleInput = {
  stationId: string;
  productId?: string | null;
  categoryId?: string | null;
  course?: number | null;
  priority?: number;
};

/** Validate the product/category/course XOR target and referenced rows in scope. */
async function assertRoutingTarget(
  db: ScopedDb,
  productId: string | null,
  categoryId: string | null,
  course: number | null
): Promise<void> {
  const targets = [productId !== null, categoryId !== null, course !== null].filter(Boolean).length;
  if (targets !== 1 || (course !== null && (!Number.isInteger(course) || course < 1))) {
    throw new StationError(
      'A routing rule must target exactly one product, category, or positive course number.',
      'RULE_TARGET_INVALID'
    );
  }
  if (productId !== null) {
    const product = await db.restaurantProduct.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw new StationError('The product does not exist.', 'PRODUCT_NOT_FOUND');
  } else if (categoryId !== null) {
    const category = await db.restaurantCategory.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) throw new StationError('The category does not exist.', 'CATEGORY_NOT_FOUND');
  }
}

export async function createRoutingRule(db: ScopedDb, input: CreateRoutingRuleInput) {
  await requireStation(db, input.stationId);
  const productId = input.productId ?? null;
  const categoryId = input.categoryId ?? null;
  const course = input.course ?? null;
  await assertRoutingTarget(db, productId, categoryId, course);
  return db.restaurantStationRoutingRule.create({
    data: {
      stationId: input.stationId,
      productId,
      categoryId,
      course,
      priority: input.priority ?? 0,
    },
  });
}

export type UpdateRoutingRuleInput = {
  priority: number;
};

/**
 * Update a routing rule's priority (its tie-break weight). A rule's target
 * (product/category) is its identity — re-targeting is done by deleting the rule
 * and creating a new one, which keeps the XOR validation in one place.
 */
export async function updateRoutingRule(db: ScopedDb, id: string, patch: UpdateRoutingRuleInput) {
  const existing = await db.restaurantStationRoutingRule.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    throw new StationError('Routing rule not found.', 'RULE_NOT_FOUND');
  }
  return db.restaurantStationRoutingRule.update({
    where: { id },
    data: { priority: patch.priority },
  });
}

export async function deleteRoutingRule(db: ScopedDb, id: string) {
  const existing = await db.restaurantStationRoutingRule.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    throw new StationError('Routing rule not found.', 'RULE_NOT_FOUND');
  }
  return db.restaurantStationRoutingRule.delete({ where: { id } });
}

// ── Read model (C10 read contract, consumed by L5a + L5b) ────────────────────

export type RoutingRuleView = {
  id: string;
  priority: number;
  productId: string | null;
  productName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  course: number | null;
};

export type StationView = {
  id: string;
  branchId: string;
  name: string;
  active: boolean;
  isDefault: boolean;
  routingRules: RoutingRuleView[];
};

export type ListStationsInput = {
  branchId: string;
  includeInactive?: boolean;
};

/**
 * The `listStations` read contract: a branch's stations (default first, then by
 * name) each with its routing rules ordered by descending priority.
 */
export async function listStations(db: ScopedDb, input: ListStationsInput): Promise<StationView[]> {
  const stations = await db.restaurantKitchenStation.findMany({
    where: { branchId: input.branchId, ...(input.includeInactive ? {} : { active: true }) },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    select: {
      id: true,
      branchId: true,
      name: true,
      active: true,
      isDefault: true,
      routingRules: {
        orderBy: [{ priority: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          priority: true,
          productId: true,
          categoryId: true,
          course: true,
          product: { select: { name: true } },
          category: { select: { name: true } },
        },
      },
    },
  });

  return stations.map((station) => ({
    id: station.id,
    branchId: station.branchId,
    name: station.name,
    active: station.active,
    isDefault: station.isDefault,
    routingRules: station.routingRules.map((rule) => ({
      id: rule.id,
      priority: rule.priority,
      productId: rule.productId,
      productName: rule.product?.name ?? null,
      categoryId: rule.categoryId,
      categoryName: rule.category?.name ?? null,
      course: rule.course,
    })),
  }));
}
