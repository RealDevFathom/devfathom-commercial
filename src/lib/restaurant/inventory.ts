import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { resolveActiveVersion } from './effective-dating';
import { explodeRecipeInDb } from './recipe-costing';
import {
  deriveBalance,
  deriveBalances,
  postStockMovements,
  runStockTransaction,
  type StockMovementReason,
  type StockActor,
  type PostedStockMovement,
} from './inventory-ledger';

/**
 * M6-L2 / §11.4 — inventory operations domain.
 *
 * Implements the five operations that post to the append-only stock ledger
 * (via the L1 `postStockMovements` primitive):
 *   1. Physical count lifecycle (create/addLine/submit/post → PHYSICAL_COUNT_ADJUSTMENT)
 *   2. Inter-location transfers (atomic paired TRANSFER movements in one transaction)
 *   3. Wastage/spoilage/staff-meal postings (WASTAGE / SPOILAGE / STAFF_MEAL)
 *   4. Sale-reversal corrections (SALE_REVERSAL, positive)
 *   5. Recipe consumption at order close (RECIPE_CONSUMPTION; called by orders.ts)
 *
 * Also exposes:
 *   - Low-stock rule CRUD + evaluation reads (no balance column — derived at read time)
 *   - Console read helpers: stock on hand (w/ negative flag), ledger browse, counts,
 *     transfers, batches
 *
 * D07 invariants (binding):
 *   - Negative derived stock is PERMITTED; flagged in reads (`isNegative`).
 *   - No balance pre-check at posting; no mutable balance column.
 *   - Costing is read-time WAC from intrinsic-cost movements (unitCost on
 *     PURCHASE_RECEIPT / SUPPLIER_RETURN); no per-consumption cost snapshot.
 */

// ── Error types ───────────────────────────────────────────────────────────────

export type InventoryErrorReason =
  | 'NOT_FOUND'
  | 'INVALID'
  | 'STOCK_ITEM_EXISTS'
  | 'COUNT_NOT_DRAFT'
  | 'COUNT_NOT_SUBMITTED'
  | 'TRANSFER_NOT_DRAFT'
  | 'TRANSFER_ALREADY_COMPLETE'
  | 'DUPLICATE_COUNT_LINE'
  | 'NO_ACTIVE_RECIPE_VERSION';

export class InventoryError extends Error {
  constructor(
    message: string,
    readonly reason: InventoryErrorReason
  ) {
    super(message);
    this.name = 'InventoryError';
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const ZERO = new Prisma.Decimal(0);

function dec(v: Prisma.Decimal | string | number): Prisma.Decimal {
  return new Prisma.Decimal(v);
}

export type CreateStockItemInput = {
  ingredientId: string;
  canonicalUnitId: string;
  trackBatches?: boolean;
};

export async function createStockItem(db: ScopedDb, input: CreateStockItemInput) {
  const ingredient = await db.restaurantIngredient.findUnique({
    where: { id: input.ingredientId },
    select: { id: true, baseUnitId: true },
  });
  if (!ingredient) throw new InventoryError('Ingredient not found.', 'NOT_FOUND');

  const unit = await db.restaurantUnit.findUnique({
    where: { id: input.canonicalUnitId },
    select: { id: true },
  });
  if (!unit) throw new InventoryError('Canonical unit not found.', 'NOT_FOUND');
  if (ingredient.baseUnitId !== unit.id) {
    throw new InventoryError(
      "A stock item's canonical unit must match its ingredient base unit.",
      'INVALID'
    );
  }

  const existing = await db.restaurantStockItem.findUnique({
    where: { ingredientId: ingredient.id },
    select: { id: true },
  });
  if (existing) {
    throw new InventoryError(
      'A stock item already exists for this ingredient.',
      'STOCK_ITEM_EXISTS'
    );
  }

  return db.restaurantStockItem.create({
    data: {
      ingredientId: ingredient.id,
      canonicalUnitId: unit.id,
      trackBatches: input.trackBatches ?? false,
    },
  });
}

// ── Physical counts ───────────────────────────────────────────────────────────

export type CreateStockCountInput = {
  locationId: string;
  reference?: string | null;
  countedAt?: Date;
  actor?: StockActor;
};

export async function createStockCount(db: ScopedDb, input: CreateStockCountInput) {
  return db.restaurantStockCount.create({
    data: {
      locationId: input.locationId,
      reference: input.reference ?? null,
      countedAt: input.countedAt ?? null,
      staffProfileId: input.actor?.staffProfileId ?? null,
      status: 'DRAFT',
    },
  });
}

export type AddStockCountLineInput = {
  stockCountId: string;
  stockItemId: string;
  countedQuantity: Prisma.Decimal | string | number;
};

export async function addStockCountLine(db: ScopedDb, input: AddStockCountLineInput) {
  const count = await db.restaurantStockCount.findUnique({
    where: { id: input.stockCountId },
    select: { id: true, status: true },
  });
  if (!count) throw new InventoryError('Stock count not found.', 'NOT_FOUND');
  if (count.status !== 'DRAFT')
    throw new InventoryError('Count is not in DRAFT.', 'COUNT_NOT_DRAFT');

  const existing = await db.restaurantStockCountLine.findFirst({
    where: { stockCountId: input.stockCountId, stockItemId: input.stockItemId },
    select: { id: true },
  });
  if (existing)
    throw new InventoryError('Duplicate count line for this stock item.', 'DUPLICATE_COUNT_LINE');

  const countedQty = dec(input.countedQuantity);
  // snapshotQuantity and varianceQuantity are filled at submit time.
  return db.restaurantStockCountLine.create({
    data: {
      stockCountId: input.stockCountId,
      stockItemId: input.stockItemId,
      countedQuantity: countedQty,
      snapshotQuantity: ZERO,
      varianceQuantity: ZERO,
    },
  });
}

export type SubmitStockCountInput = {
  stockCountId: string;
  actor?: StockActor;
};

/**
 * Freeze the count: snapshot the derived on-hand for each counted item
 * (snapshotQuantity) and compute variance = counted − snapshot. Count moves
 * DRAFT → SUBMITTED. The snapshot is the exact Decimal balance at submit time.
 */
export async function submitStockCount(
  db: ScopedDb,
  input: SubmitStockCountInput
): Promise<{ stockCountId: string }> {
  return runStockTransaction(db, async (tx) => {
    const count = await tx.restaurantStockCount.findUnique({
      where: { id: input.stockCountId },
      select: {
        id: true,
        status: true,
        locationId: true,
        lines: { select: { id: true, stockItemId: true, countedQuantity: true } },
      },
    });
    if (!count) throw new InventoryError('Stock count not found.', 'NOT_FOUND');
    if (count.status !== 'DRAFT')
      throw new InventoryError('Count is not in DRAFT.', 'COUNT_NOT_DRAFT');

    const now = new Date();
    for (const line of count.lines) {
      const snapshot = await deriveBalance(tx, line.stockItemId, count.locationId);
      const variance = dec(line.countedQuantity).minus(snapshot);
      await tx.restaurantStockCountLine.update({
        where: { id: line.id },
        data: { snapshotQuantity: snapshot, varianceQuantity: variance },
      });
    }

    await tx.restaurantStockCount.update({
      where: { id: count.id },
      data: { status: 'SUBMITTED', submittedAt: now },
    });
    return { stockCountId: count.id };
  });
}

export type PostStockCountInput = {
  stockCountId: string;
  actor?: StockActor;
  now?: Date;
};

/**
 * Post one PHYSICAL_COUNT_ADJUSTMENT movement per counted line whose variance ≠ 0.
 * The movement's signed quantity equals the variance (counted − snapshot).
 * Count moves SUBMITTED → POSTED.
 */
export async function postStockCount(
  db: ScopedDb,
  input: PostStockCountInput
): Promise<{ stockCountId: string; movementsPosted: number }> {
  return runStockTransaction(db, async (tx) => {
    const count = await tx.restaurantStockCount.findUnique({
      where: { id: input.stockCountId },
      select: {
        id: true,
        status: true,
        locationId: true,
        lines: { select: { stockItemId: true, varianceQuantity: true } },
      },
    });
    if (!count) throw new InventoryError('Stock count not found.', 'NOT_FOUND');
    if (count.status !== 'SUBMITTED')
      throw new InventoryError('Count is not SUBMITTED.', 'COUNT_NOT_SUBMITTED');

    const at = input.now ?? new Date();
    const nonZeroLines = count.lines.filter((l) => !dec(l.varianceQuantity).equals(ZERO));

    if (nonZeroLines.length > 0) {
      await postStockMovements(tx, {
        actor: input.actor,
        now: at,
        commandType: 'stock.count.post',
        movements: nonZeroLines.map((l) => ({
          stockItemId: l.stockItemId,
          locationId: count.locationId,
          reason: 'PHYSICAL_COUNT_ADJUSTMENT' as StockMovementReason,
          quantity: l.varianceQuantity,
          countId: count.id,
        })),
      });
    }

    await tx.restaurantStockCount.update({
      where: { id: count.id },
      data: { status: 'POSTED', postedAt: at },
    });
    return { stockCountId: count.id, movementsPosted: nonZeroLines.length };
  });
}

// ── Stock transfers ───────────────────────────────────────────────────────────

export type CreateStockTransferInput = {
  sourceLocationId: string;
  destinationLocationId: string;
  reference?: string | null;
  actor?: StockActor;
};

export async function createStockTransfer(db: ScopedDb, input: CreateStockTransferInput) {
  return db.restaurantStockTransfer.create({
    data: {
      sourceLocationId: input.sourceLocationId,
      destinationLocationId: input.destinationLocationId,
      reference: input.reference ?? null,
      staffProfileId: input.actor?.staffProfileId ?? null,
      status: 'DRAFT',
    },
  });
}

export type AddStockTransferLineInput = {
  stockTransferId: string;
  stockItemId: string;
  quantity: Prisma.Decimal | string | number;
  unitId?: string | null;
};

export async function addStockTransferLine(db: ScopedDb, input: AddStockTransferLineInput) {
  const transfer = await db.restaurantStockTransfer.findUnique({
    where: { id: input.stockTransferId },
    select: { id: true, status: true },
  });
  if (!transfer) throw new InventoryError('Stock transfer not found.', 'NOT_FOUND');
  if (transfer.status !== 'DRAFT')
    throw new InventoryError('Transfer is not in DRAFT.', 'TRANSFER_NOT_DRAFT');

  return db.restaurantStockTransferLine.create({
    data: {
      stockTransferId: input.stockTransferId,
      stockItemId: input.stockItemId,
      quantity: dec(input.quantity),
    },
  });
}

export type CompleteStockTransferInput = {
  stockTransferId: string;
  actor?: StockActor;
  now?: Date;
};

/**
 * Atomically post paired TRANSFER movements (negative at source, positive at
 * destination) and mark the transfer RECEIVED in a single transaction.
 * Fail-closed: if the transaction rolls back, zero movements are written.
 */
export async function completeStockTransfer(
  db: ScopedDb,
  input: CompleteStockTransferInput
): Promise<{ stockTransferId: string; movementsPosted: number }> {
  return runStockTransaction(db, async (tx) => {
    const transfer = await tx.restaurantStockTransfer.findUnique({
      where: { id: input.stockTransferId },
      select: {
        id: true,
        status: true,
        sourceLocationId: true,
        destinationLocationId: true,
        lines: { select: { stockItemId: true, quantity: true } },
      },
    });
    if (!transfer) throw new InventoryError('Stock transfer not found.', 'NOT_FOUND');
    if (transfer.status === 'RECEIVED' || transfer.status === 'CANCELLED') {
      throw new InventoryError(
        'Transfer is already complete or cancelled.',
        'TRANSFER_ALREADY_COMPLETE'
      );
    }
    if (transfer.status !== 'DRAFT') {
      throw new InventoryError('Transfer is not in DRAFT.', 'TRANSFER_NOT_DRAFT');
    }

    const at = input.now ?? new Date();
    const lines = transfer.lines;
    if (lines.length === 0) {
      await tx.restaurantStockTransfer.update({
        where: { id: transfer.id },
        data: { status: 'RECEIVED', dispatchedAt: at, receivedAt: at },
      });
      return { stockTransferId: transfer.id, movementsPosted: 0 };
    }

    // Source OUT (negative) + destination IN (positive) — atomic in this transaction.
    await postStockMovements(tx, {
      actor: input.actor,
      now: at,
      commandType: 'stock.transfer',
      movements: [
        ...lines.map((l) => ({
          stockItemId: l.stockItemId,
          locationId: transfer.sourceLocationId,
          reason: 'TRANSFER' as StockMovementReason,
          quantity: dec(l.quantity).negated(),
          transferId: transfer.id,
        })),
        ...lines.map((l) => ({
          stockItemId: l.stockItemId,
          locationId: transfer.destinationLocationId,
          reason: 'TRANSFER' as StockMovementReason,
          quantity: dec(l.quantity),
          transferId: transfer.id,
        })),
      ],
    });

    await tx.restaurantStockTransfer.update({
      where: { id: transfer.id },
      data: { status: 'RECEIVED', dispatchedAt: at, receivedAt: at },
    });
    return { stockTransferId: transfer.id, movementsPosted: lines.length * 2 };
  });
}

// ── Wastage / spoilage / staff-meal postings ──────────────────────────────────

export type WastageReason = 'WASTAGE' | 'SPOILAGE' | 'STAFF_MEAL';

export type PostWastageInput = {
  stockItemId: string;
  locationId: string;
  reason: WastageReason;
  quantity: Prisma.Decimal | string | number;
  unitId?: string | null;
  occurredAt?: Date;
  actor?: StockActor;
  now?: Date;
};

export async function postWastage(
  db: ScopedDb,
  input: PostWastageInput
): Promise<PostedStockMovement> {
  const result = await postStockMovements(db, {
    actor: input.actor,
    now: input.now,
    commandType: `stock.${input.reason.toLowerCase()}`,
    movements: [
      {
        stockItemId: input.stockItemId,
        locationId: input.locationId,
        reason: input.reason as StockMovementReason,
        quantity: dec(input.quantity).negated().abs().negated(), // always negative (out)
        unitId: input.unitId ?? null,
        occurredAt: input.occurredAt,
      },
    ],
  });
  return result.movements[0]!;
}

// ── Sale reversal ─────────────────────────────────────────────────────────────

export type PostSaleReversalInput = {
  stockItemId: string;
  locationId: string;
  quantity: Prisma.Decimal | string | number;
  unitId?: string | null;
  orderId?: string | null;
  occurredAt?: Date;
  actor?: StockActor;
  now?: Date;
};

export async function postSaleReversal(
  db: ScopedDb,
  input: PostSaleReversalInput
): Promise<PostedStockMovement> {
  const result = await postStockMovements(db, {
    actor: input.actor,
    now: input.now,
    commandType: 'stock.sale_reversal',
    movements: [
      {
        stockItemId: input.stockItemId,
        locationId: input.locationId,
        reason: 'SALE_REVERSAL' as StockMovementReason,
        quantity: dec(input.quantity).abs(), // always positive (back in)
        unitId: input.unitId ?? null,
        orderId: input.orderId ?? null,
        occurredAt: input.occurredAt,
      },
    ],
  });
  return result.movements[0]!;
}

// ── Low-stock rules ───────────────────────────────────────────────────────────

export type CreateLowStockRuleInput = {
  stockItemId: string;
  locationId: string;
  threshold: Prisma.Decimal | string | number;
};

export async function createLowStockRule(db: ScopedDb, input: CreateLowStockRuleInput) {
  return db.restaurantLowStockRule.create({
    data: {
      stockItemId: input.stockItemId,
      locationId: input.locationId,
      threshold: dec(input.threshold),
    },
  });
}

export type UpdateLowStockRuleInput = { threshold: Prisma.Decimal | string | number };

export async function updateLowStockRule(db: ScopedDb, id: string, patch: UpdateLowStockRuleInput) {
  const rule = await db.restaurantLowStockRule.findUnique({ where: { id }, select: { id: true } });
  if (!rule) throw new InventoryError('Low-stock rule not found.', 'NOT_FOUND');
  return db.restaurantLowStockRule.update({
    where: { id },
    data: { threshold: dec(patch.threshold) },
  });
}

export async function deleteLowStockRule(db: ScopedDb, id: string) {
  const rule = await db.restaurantLowStockRule.findUnique({ where: { id }, select: { id: true } });
  if (!rule) throw new InventoryError('Low-stock rule not found.', 'NOT_FOUND');
  await db.restaurantLowStockRule.delete({ where: { id } });
}

export type LowStockFlag = {
  ruleId: string;
  stockItemId: string;
  locationId: string;
  threshold: Prisma.Decimal;
  onHand: Prisma.Decimal;
  isTriggered: boolean;
};

/** Derive on-hand for each rule's (stockItem, location) and flag when < threshold. */
export async function evaluateLowStockRules(
  db: ScopedDb,
  filter: { locationId?: string; stockItemId?: string; branchIds?: string[] } = {}
): Promise<LowStockFlag[]> {
  const rules = await db.restaurantLowStockRule.findMany({
    where: {
      ...(filter.locationId ? { locationId: filter.locationId } : {}),
      ...(filter.branchIds ? { location: { branchId: { in: filter.branchIds } } } : {}),
      ...(filter.stockItemId ? { stockItemId: filter.stockItemId } : {}),
    },
    select: { id: true, stockItemId: true, locationId: true, threshold: true },
  });
  if (rules.length === 0) return [];

  const balances = await deriveBalances(db, {
    stockItemIds: [...new Set(rules.map((r) => r.stockItemId))],
    locationIds: [...new Set(rules.map((r) => r.locationId))],
  });
  const balanceMap = new Map(balances.map((b) => [`${b.stockItemId}::${b.locationId}`, b.onHand]));

  return rules.map((r) => {
    const onHand = balanceMap.get(`${r.stockItemId}::${r.locationId}`) ?? ZERO;
    return {
      ruleId: r.id,
      stockItemId: r.stockItemId,
      locationId: r.locationId,
      threshold: r.threshold,
      onHand,
      isTriggered: onHand.lessThan(r.threshold),
    };
  });
}

// ── Recipe consumption at order close ─────────────────────────────────────────

type OrderItemForConsumption = {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  status: string;
  wastageDisposition: string | null;
};

/**
 * Called by orders.ts::closeOrder (coordinated single touch) inside the order's
 * existing transaction. Resolves the active recipe version for each non-voided
 * order item, flattens its BOM, and posts RECIPE_CONSUMPTION movements. Items with
 * no recipe or no active version are silently skipped (not every product is tracked).
 *
 * C6 disposition for post-prep voided items:
 *   - WASTE  → post WASTAGE movements (negative)
 *   - RESTOCK → no consumption (skip)
 *   - NONE   → no movement
 */
export async function postOrderRecipeConsumption(
  tx: ScopedDb,
  orderId: string,
  branchId: string,
  items: readonly OrderItemForConsumption[],
  actor?: StockActor,
  now?: Date
): Promise<void> {
  // Find the primary stock location for this branch (first active location).
  const location = await tx.restaurantStockLocation.findFirst({
    where: { branchId, isActive: true },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!location) return; // no stock location set up for branch → skip consumption

  const at = now ?? new Date();

  for (const item of items) {
    const isVoided = item.status === 'VOIDED';
    const disposition = item.wastageDisposition;

    if (isVoided) {
      // C6: WASTE → WASTAGE; RESTOCK or NONE → no movement
      if (disposition !== 'WASTE') continue;
    }
    // For voided+WASTE or any non-voided non-cancelled item, derive recipe BOM.

    // Prefer the exact variant; use the product recipe only when it is absent.
    let recipe = await tx.restaurantRecipe.findFirst({
      where: { productId: item.productId, variantId: item.variantId ?? null },
      select: { id: true, organizationId: true },
    });
    if (!recipe && item.variantId) {
      recipe = await tx.restaurantRecipe.findFirst({
        where: { productId: item.productId, variantId: null },
        select: { id: true, organizationId: true },
      });
    }
    if (!recipe) continue;

    const versions = await tx.restaurantRecipeVersion.findMany({
      where: { recipeId: recipe.id },
      select: { id: true, status: true },
    });
    const active = resolveActiveVersion(versions);
    if (!active) continue;

    const explosion = await explodeRecipeInDb(tx, {
      organizationId: recipe.organizationId,
      recipeVersionId: active.id,
      portions: dec(item.quantity),
    });
    const leaves = explosion.ingredients.filter(
      (leaf): leaf is typeof leaf & { stockItemId: string } => leaf.stockItemId !== null
    );
    if (leaves.length === 0) continue;

    const reason: StockMovementReason = isVoided ? 'WASTAGE' : 'RECIPE_CONSUMPTION';

    await postStockMovements(tx, {
      actor,
      now: at,
      commandType: isVoided ? 'stock.wastage' : 'stock.recipe_consumption',
      movements: leaves.map((leaf) => ({
        stockItemId: leaf.stockItemId,
        locationId: location.id,
        reason,
        quantity: leaf.quantityInBaseUnit.negated(), // consumption = out (negative)
        unitId: leaf.baseUnitId,
        orderId,
      })),
    });
  }
}

// ── Console reads ─────────────────────────────────────────────────────────────

export type StockOnHandRow = {
  stockItemId: string;
  ingredientName: string;
  locationId: string;
  locationName: string;
  onHand: Prisma.Decimal;
  isNegative: boolean;
  /** Read-time weighted-average cost per canonical unit, derived from the
   *  intrinsic-cost movements (unitCost on PURCHASE_RECEIPT / SUPPLIER_RETURN);
   *  ZERO when no cost-bearing movements exist for the group (D07, no snapshot). */
  weightedAverageCost: Prisma.Decimal;
};

/** Derived on-hand per (stockItem × location) with negative flag. */
export async function listStockOnHand(
  db: ScopedDb,
  filter: { locationId?: string; stockItemId?: string; branchId?: string; branchIds?: string[] }
): Promise<StockOnHandRow[]> {
  // Determine location IDs for this branch when branchId is supplied.
  let locationIds: string[] | undefined;
  if (filter.branchId || filter.branchIds) {
    if (filter.branchId && filter.branchIds && !filter.branchIds.includes(filter.branchId))
      return [];
    const locations = await db.restaurantStockLocation.findMany({
      where: {
        branchId: filter.branchId ?? { in: filter.branchIds! },
        isActive: true,
        ...(filter.locationId ? { id: filter.locationId } : {}),
      },
      select: { id: true },
    });
    locationIds = locations.map((l) => l.id);
    if (locationIds.length === 0) return [];
  }

  const balances = await deriveBalances(db, {
    stockItemIds: filter.stockItemId ? [filter.stockItemId] : undefined,
    locationIds: filter.locationId ? [filter.locationId] : locationIds,
  });
  if (balances.length === 0) return [];

  const itemIds = [...new Set(balances.map((b) => b.stockItemId))];
  const locIds = [...new Set(balances.map((b) => b.locationId))];

  const [items, locations] = await Promise.all([
    db.restaurantStockItem.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, ingredient: { select: { name: true } } },
    }),
    db.restaurantStockLocation.findMany({
      where: { id: { in: locIds } },
      select: { id: true, name: true },
    }),
  ]);

  const itemMap = new Map(items.map((i) => [i.id, i]));
  const locMap = new Map(locations.map((l) => [l.id, l]));

  // Read-time WAC (D07): fold the intrinsic-cost movements per (item × location).
  // WAC = Σ(quantity × unitCost) / Σ(quantity) over cost-bearing movements only —
  // the divisor is the received quantity, NOT the (consumption-reduced) on-hand.
  const wacKey = (stockItemId: string, locationId: string) => `${stockItemId} ${locationId}`;
  const costRows = await db.restaurantStockMovement.findMany({
    where: {
      stockItemId: { in: itemIds },
      locationId: { in: locIds },
      unitCost: { not: null },
    },
    select: { stockItemId: true, locationId: true, quantity: true, unitCost: true },
  });
  const costAcc = new Map<string, { totalCost: Prisma.Decimal; totalQty: Prisma.Decimal }>();
  for (const row of costRows) {
    if (row.unitCost === null) continue;
    const key = wacKey(row.stockItemId, row.locationId);
    const acc = costAcc.get(key) ?? { totalCost: ZERO, totalQty: ZERO };
    acc.totalCost = acc.totalCost.plus(row.quantity.times(row.unitCost));
    acc.totalQty = acc.totalQty.plus(row.quantity);
    costAcc.set(key, acc);
  }

  return balances.map((b) => {
    const acc = costAcc.get(wacKey(b.stockItemId, b.locationId));
    const weightedAverageCost =
      acc && !acc.totalQty.isZero() ? acc.totalCost.dividedBy(acc.totalQty) : ZERO;
    return {
      stockItemId: b.stockItemId,
      ingredientName: itemMap.get(b.stockItemId)?.ingredient?.name ?? b.stockItemId,
      locationId: b.locationId,
      locationName: locMap.get(b.locationId)?.name ?? b.locationId,
      onHand: b.onHand,
      isNegative: b.onHand.lessThan(ZERO),
      weightedAverageCost,
    };
  });
}

export type ListMovementsInput = {
  stockItemId?: string;
  locationId?: string;
  reason?: StockMovementReason;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
  branchIds?: string[];
};

export async function listStockMovements(db: ScopedDb, input: ListMovementsInput) {
  const limit = Math.min(input.limit ?? 50, 200);
  const rows = await db.restaurantStockMovement.findMany({
    where: {
      ...(input.stockItemId ? { stockItemId: input.stockItemId } : {}),
      ...(input.locationId ? { locationId: input.locationId } : {}),
      ...(input.branchIds ? { location: { branchId: { in: input.branchIds } } } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.from || input.to
        ? {
            occurredAt: {
              ...(input.from ? { gte: input.from } : {}),
              ...(input.to ? { lte: input.to } : {}),
            },
          }
        : {}),
      ...(input.cursor ? { id: { lt: input.cursor } } : {}),
    },
    orderBy: { occurredAt: 'desc' },
    take: limit + 1,
    select: {
      id: true,
      stockItemId: true,
      locationId: true,
      reason: true,
      quantity: true,
      unitCost: true,
      occurredAt: true,
      recordedAt: true,
      orderId: true,
      receiptId: true,
      transferId: true,
      countId: true,
    },
  });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}

export type ListCountsInput = {
  locationId?: string;
  status?: 'DRAFT' | 'SUBMITTED' | 'POSTED';
  cursor?: string;
  limit?: number;
  branchIds?: string[];
};

export async function listStockCounts(db: ScopedDb, input: ListCountsInput) {
  const limit = Math.min(input.limit ?? 50, 200);
  const rows = await db.restaurantStockCount.findMany({
    where: {
      ...(input.locationId ? { locationId: input.locationId } : {}),
      ...(input.branchIds ? { location: { branchId: { in: input.branchIds } } } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.cursor ? { id: { lt: input.cursor } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    select: {
      id: true,
      locationId: true,
      status: true,
      reference: true,
      countedAt: true,
      submittedAt: true,
      postedAt: true,
      _count: { select: { lines: true } },
    },
  });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}

export type ListTransfersInput = {
  sourceLocationId?: string;
  destinationLocationId?: string;
  status?: 'DRAFT' | 'DISPATCHED' | 'RECEIVED' | 'CANCELLED';
  cursor?: string;
  limit?: number;
  branchIds?: string[];
};

export async function listStockTransfers(db: ScopedDb, input: ListTransfersInput) {
  const limit = Math.min(input.limit ?? 50, 200);
  const rows = await db.restaurantStockTransfer.findMany({
    where: {
      ...(input.sourceLocationId ? { sourceLocationId: input.sourceLocationId } : {}),
      ...(input.destinationLocationId
        ? { destinationLocationId: input.destinationLocationId }
        : {}),
      ...(input.branchIds
        ? {
            sourceLocation: { branchId: { in: input.branchIds } },
            destinationLocation: { branchId: { in: input.branchIds } },
          }
        : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.cursor ? { id: { lt: input.cursor } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    select: {
      id: true,
      sourceLocationId: true,
      destinationLocationId: true,
      status: true,
      reference: true,
      dispatchedAt: true,
      receivedAt: true,
      _count: { select: { lines: true } },
    },
  });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}

export async function listStockBatches(
  db: ScopedDb,
  filter: { stockItemId?: string; cursor?: string; limit?: number; branchIds?: string[] }
) {
  const limit = Math.min(filter.limit ?? 50, 200);
  const rows = await db.restaurantStockBatch.findMany({
    where: {
      ...(filter.stockItemId ? { stockItemId: filter.stockItemId } : {}),
      // A batch can be receipt-less or received again/transferred elsewhere.
      // Keep its metadata available wherever it has ledger history, including
      // depleted stock, so historical inventory remains readable.
      ...(filter.branchIds
        ? { movements: { some: { location: { branchId: { in: filter.branchIds } } } } }
        : {}),
      ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    select: {
      id: true,
      stockItemId: true,
      receiptId: true,
      code: true,
      expiryDate: true,
      createdAt: true,
    },
  });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}
