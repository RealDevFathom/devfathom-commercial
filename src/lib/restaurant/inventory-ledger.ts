import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M6-L1 / §11.4 / D07 — the inventory ledger primitive. The SINGLE write/read
 * path over `restaurant_stock_movements`, the APPEND-ONLY stock ledger that is
 * the ONLY source of stock truth (DB-enforced SELECT+INSERT RLS; a correction is
 * a NEW movement, never an edit). Every downstream inventory/purchasing lane
 * (receiving, consumption at order close, transfers, counts, wastage) composes
 * `postStockMovements`; every read derives on-hand with `deriveBalances`.
 *
 * D07 conservative defaults this module enforces:
 *   - NO mutable balance is stored. `deriveBalances` folds the signed-quantity
 *     ledger (SUM by stockItem × location, optionally × batch); the result is an
 *     EXACT Prisma.Decimal — no float, no `toBeCloseTo`.
 *   - Negative derived stock is PERMITTED. Consumption never blocks: there is no
 *     balance pre-check at posting, so posting stays append-only and race-free;
 *     a negative balance surfaces in reads (compare against zero) to be flagged.
 *   - Costing is read-time weighted-average from intrinsic-cost movements
 *     (`unitCost` on PURCHASE_RECEIPT / SUPPLIER_RETURN). This module stores the
 *     per-canonical-unit `unitCost` on those movements but computes NO cost
 *     snapshot at post time (avoids racy snapshots under parallel writes).
 *   - A movement `quantity` is expressed in an input unit and CONVERTED to the
 *     stock item's canonical unit here (identity, or one directed
 *     `RestaurantUnitConversion` factor); `unitCost` is converted inversely so
 *     `quantity × unitCost` (total cost) is invariant under the conversion.
 *
 * Money-style plumbing (mirrors drawer-sessions.ts): one tenant-scoped
 * transaction with forced RLS, and an OPTIONAL org-scoped idempotency key
 * (`restaurant_inventory_idempotency_keys`, a SEPARATE replay domain from the M5
 * money keys) so a receiving/transfer/count-post retry creates nothing.
 */

/** The ten canonical §11.4 movement reasons (mirrors the Prisma enum). */
export type StockMovementReason =
  | 'PURCHASE_RECEIPT'
  | 'RECIPE_CONSUMPTION'
  | 'SALE_REVERSAL'
  | 'TRANSFER'
  | 'PHYSICAL_COUNT_ADJUSTMENT'
  | 'WASTAGE'
  | 'SPOILAGE'
  | 'STAFF_MEAL'
  | 'SUPPLIER_RETURN'
  | 'MANUAL_CORRECTION';

export type StockLedgerErrorReason =
  | 'EMPTY_MOVEMENTS'
  | 'STOCK_ITEM_NOT_FOUND'
  | 'NO_UNIT_CONVERSION'
  | 'IDEMPOTENT_REPLAY_MISSING'
  | 'INVALID';

export class StockLedgerError extends Error {
  constructor(
    message: string,
    readonly reason: StockLedgerErrorReason
  ) {
    super(message);
    this.name = 'StockLedgerError';
  }
}

/** Who/what is posting, plus an OPTIONAL org-scoped idempotency key. Attribution
 * is best-effort — system postings (recipe consumption at order close) may carry
 * only the order's operator; back-office postings may carry neither device nor a
 * key. */
export type StockActor = {
  staffProfileId?: string | null;
  deviceId?: string | null;
  idempotencyKey?: string | null;
};

/** One movement to append. `quantity` is SIGNED (positive = in, negative = out)
 * and expressed in `unitId` (defaults to the item's canonical unit when null).
 * `unitCost` is the cost per `unitId` (intrinsic-cost reasons only); both are
 * converted to the canonical unit before persistence. */
export type StockMovementInput = {
  stockItemId: string;
  locationId: string;
  reason: StockMovementReason;
  quantity: Prisma.Decimal | string | number;
  /** Unit the `quantity`/`unitCost` are expressed in; null/omitted = canonical. */
  unitId?: string | null;
  unitCost?: Prisma.Decimal | string | number | null;
  /** Economic time of the movement (backdatable); defaults to the post instant. */
  occurredAt?: Date;
  batchId?: string | null;
  orderId?: string | null;
  receiptId?: string | null;
  transferId?: string | null;
  countId?: string | null;
};

export type PostStockMovementsInput = {
  actor?: StockActor;
  movements: readonly StockMovementInput[];
  /** Command label recorded on the idempotency key (defaults to 'stock.post'). */
  commandType?: string;
  /** Server-authoritative record instant; also the default `occurredAt`. */
  now?: Date;
};

/** A persisted movement (quantity/unitCost already in the canonical unit). */
export type PostedStockMovement = {
  id: string;
  stockItemId: string;
  locationId: string;
  reason: StockMovementReason;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
  batchId: string | null;
};

export type PostStockMovementsResult = {
  movements: PostedStockMovement[];
  /** True iff this call replayed a prior idempotent post (created nothing). */
  replayed: boolean;
};

/** A derived on-hand balance for a (stockItem, location[, batch]) group. */
export type DerivedBalance = {
  stockItemId: string;
  locationId: string;
  /** Present only when `byBatch` was requested; null for a batch-less fold. */
  batchId: string | null;
  /** The EXACT signed Decimal sum of the group's movement quantities (canonical
   * unit). May be negative — negative stock is permitted and flagged in reads. */
  onHand: Prisma.Decimal;
};

export type DeriveBalancesInput = {
  /** Restrict to these stock items (all items when omitted). */
  stockItemIds?: readonly string[];
  /** Restrict to these locations (all locations when omitted). */
  locationIds?: readonly string[];
  /** Fold by batch as a third dimension (the D07 optional batch seam). */
  byBatch?: boolean;
};

const ZERO = new Prisma.Decimal(0);

/**
 * Open one tenant-scoped interactive transaction. `db` is the request's
 * `createTenantDb` proxy whose `$transaction` sets the RLS tenant GUC and hands
 * the callback a nested `ScopedDb`; Prisma types the callback param as the
 * interactive-transaction client, so we retype it to the `ScopedDb` the proxy
 * passes at runtime (same shape as money's `runMoneyTransaction`).
 */
export function runStockTransaction<T>(
  db: ScopedDb,
  work: (tx: ScopedDb) => Promise<T>
): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

function isFiniteDecimal(value: Prisma.Decimal | string | number): boolean {
  try {
    return new Prisma.Decimal(value).isFinite();
  } catch {
    return false;
  }
}

/**
 * Append one or more stock movements to the ledger atomically and (optionally)
 * idempotently. Quantities are converted to each item's canonical unit; the
 * movements commit together or not at all. When `actor.idempotencyKey` is set,
 * a replay of the same (organization, key) returns the original movements and
 * creates nothing; a concurrent duplicate that loses the unique-index race rolls
 * back (fail-closed) and the retry replays.
 */
export async function postStockMovements(
  db: ScopedDb,
  input: PostStockMovementsInput
): Promise<PostStockMovementsResult> {
  if (input.movements.length === 0) {
    throw new StockLedgerError(
      'postStockMovements requires at least one movement.',
      'EMPTY_MOVEMENTS'
    );
  }
  for (const movement of input.movements) {
    // NaN/±Infinity are valid Decimals and PostgreSQL numeric stores NaN, so a
    // non-finite value would permanently poison every derived balance.
    if (
      !isFiniteDecimal(movement.quantity) ||
      (movement.unitCost != null && !isFiniteDecimal(movement.unitCost))
    ) {
      throw new StockLedgerError(
        'Stock movement quantities and unit costs must be finite decimals.',
        'INVALID'
      );
    }
  }
  const at = input.now ?? new Date();
  const key = input.actor?.idempotencyKey ?? null;
  const commandType = input.commandType ?? 'stock.post';

  return runStockTransaction(db, async (tx) => {
    if (key) {
      const existing = await tx.restaurantInventoryIdempotencyKey.findFirst({
        where: { key },
        select: { resultRef: true },
      });
      if (existing) return replayResult(tx, existing.resultRef);
      await tx.restaurantInventoryIdempotencyKey.create({
        data: { key, commandType, deviceId: input.actor?.deviceId ?? null },
      });
    }

    const canonicalUnits = await loadCanonicalUnits(tx, input.movements);
    const conversions = await loadConversions(tx, input.movements, canonicalUnits);

    const created: PostedStockMovement[] = [];
    for (const movement of input.movements) {
      const canonicalUnitId = canonicalUnits.get(movement.stockItemId)!;
      const fromUnitId = movement.unitId ?? canonicalUnitId;
      const factor =
        fromUnitId === canonicalUnitId
          ? new Prisma.Decimal(1)
          : conversions.get(`${fromUnitId}->${canonicalUnitId}`)!;

      const quantity = new Prisma.Decimal(movement.quantity).times(factor);
      // Inverse-convert the cost so quantity × unitCost (total cost) is invariant.
      const unitCost =
        movement.unitCost === undefined || movement.unitCost === null
          ? null
          : new Prisma.Decimal(movement.unitCost).dividedBy(factor);

      const row = await tx.restaurantStockMovement.create({
        data: {
          stockItemId: movement.stockItemId,
          locationId: movement.locationId,
          reason: movement.reason,
          quantity,
          unitCost,
          occurredAt: movement.occurredAt ?? at,
          recordedAt: at,
          batchId: movement.batchId ?? null,
          orderId: movement.orderId ?? null,
          receiptId: movement.receiptId ?? null,
          transferId: movement.transferId ?? null,
          countId: movement.countId ?? null,
          staffProfileId: input.actor?.staffProfileId ?? null,
          deviceId: input.actor?.deviceId ?? null,
        },
        select: {
          id: true,
          stockItemId: true,
          locationId: true,
          reason: true,
          quantity: true,
          unitCost: true,
          batchId: true,
        },
      });
      created.push({
        id: row.id,
        stockItemId: row.stockItemId,
        locationId: row.locationId,
        reason: row.reason as StockMovementReason,
        quantity: row.quantity,
        unitCost: row.unitCost,
        batchId: row.batchId,
      });
    }

    if (key) {
      await tx.restaurantInventoryIdempotencyKey.updateMany({
        where: { key },
        data: { resultRef: created.map((movement) => movement.id).join(',') },
      });
    }
    return { movements: created, replayed: false };
  });
}

/**
 * Derive on-hand balances by folding the signed-quantity ledger. Returns one
 * EXACT Decimal per (stockItem, location[, batch]) group that has movements —
 * a group with no movements is simply absent (its balance is zero). Balances may
 * be negative (permitted; flagged in reads). Read-only; safe to call outside a
 * transaction on the request-scoped db.
 */
export async function deriveBalances(
  db: ScopedDb,
  input: DeriveBalancesInput = {}
): Promise<DerivedBalance[]> {
  const where: Prisma.RestaurantStockMovementWhereInput = {};
  if (input.stockItemIds) where.stockItemId = { in: [...input.stockItemIds] };
  if (input.locationIds) where.locationId = { in: [...input.locationIds] };

  const by: Prisma.RestaurantStockMovementScalarFieldEnum[] = input.byBatch
    ? ['stockItemId', 'locationId', 'batchId']
    : ['stockItemId', 'locationId'];

  const groups = await db.restaurantStockMovement.groupBy({
    by,
    where,
    _sum: { quantity: true },
  });

  return groups.map((group) => ({
    stockItemId: group.stockItemId,
    locationId: group.locationId,
    batchId: input.byBatch ? ((group as { batchId: string | null }).batchId ?? null) : null,
    onHand: group._sum.quantity ?? ZERO,
  }));
}

/**
 * Convenience: the single derived on-hand for one (stockItem, location). Returns
 * the exact Decimal sum (zero when there are no movements).
 */
export async function deriveBalance(
  db: ScopedDb,
  stockItemId: string,
  locationId: string
): Promise<Prisma.Decimal> {
  const aggregate = await db.restaurantStockMovement.aggregate({
    where: { stockItemId, locationId },
    _sum: { quantity: true },
  });
  return aggregate._sum.quantity ?? ZERO;
}

/** Load each referenced stock item's canonical unit; throw on an unknown item. */
async function loadCanonicalUnits(
  tx: ScopedDb,
  movements: readonly StockMovementInput[]
): Promise<Map<string, string>> {
  const ids = [...new Set(movements.map((movement) => movement.stockItemId))];
  const items = await tx.restaurantStockItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, canonicalUnitId: true },
  });
  const map = new Map(items.map((item) => [item.id, item.canonicalUnitId]));
  for (const id of ids) {
    if (!map.has(id)) {
      throw new StockLedgerError(`Unknown stock item: ${id}.`, 'STOCK_ITEM_NOT_FOUND');
    }
  }
  return map;
}

/** Load every non-identity (fromUnit → canonicalUnit) conversion factor needed;
 * throw when a required directed conversion is missing. */
async function loadConversions(
  tx: ScopedDb,
  movements: readonly StockMovementInput[],
  canonicalUnits: Map<string, string>
): Promise<Map<string, Prisma.Decimal>> {
  const needed = new Map<string, { fromUnitId: string; toUnitId: string }>();
  for (const movement of movements) {
    const canonicalUnitId = canonicalUnits.get(movement.stockItemId)!;
    const fromUnitId = movement.unitId ?? canonicalUnitId;
    if (fromUnitId !== canonicalUnitId) {
      needed.set(`${fromUnitId}->${canonicalUnitId}`, { fromUnitId, toUnitId: canonicalUnitId });
    }
  }
  const factors = new Map<string, Prisma.Decimal>();
  for (const [pairKey, pair] of needed) {
    const conversion = await tx.restaurantUnitConversion.findUnique({
      where: { fromUnitId_toUnitId: { fromUnitId: pair.fromUnitId, toUnitId: pair.toUnitId } },
      select: { factor: true },
    });
    if (!conversion) {
      throw new StockLedgerError(
        `No unit conversion from ${pair.fromUnitId} to ${pair.toUnitId}.`,
        'NO_UNIT_CONVERSION'
      );
    }
    factors.set(pairKey, conversion.factor);
  }
  return factors;
}

/** Reconstruct a prior idempotent post from its stored movement-id list. */
async function replayResult(
  tx: ScopedDb,
  resultRef: string | null
): Promise<PostStockMovementsResult> {
  if (!resultRef) {
    throw new StockLedgerError(
      'The idempotent result reference is missing.',
      'IDEMPOTENT_REPLAY_MISSING'
    );
  }
  const ids = resultRef.split(',').filter(Boolean);
  const rows = await tx.restaurantStockMovement.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      stockItemId: true,
      locationId: true,
      reason: true,
      quantity: true,
      unitCost: true,
      batchId: true,
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const movements: PostedStockMovement[] = ids.map((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new StockLedgerError(
        'A replayed movement no longer exists.',
        'IDEMPOTENT_REPLAY_MISSING'
      );
    }
    return {
      id: row.id,
      stockItemId: row.stockItemId,
      locationId: row.locationId,
      reason: row.reason as StockMovementReason,
      quantity: row.quantity,
      unitCost: row.unitCost,
      batchId: row.batchId,
    };
  });
  return { movements, replayed: true };
}
