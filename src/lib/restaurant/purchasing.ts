import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  postStockMovements,
  runStockTransaction,
  type StockMovementInput,
} from './inventory-ledger';

/**
 * M6-L3 / §6.5 / §11.4 / D07 — the purchasing & suppliers domain: supplier
 * records, the purchase-order lifecycle with SERVER-SIDE state guards, goods
 * receiving, and supplier returns. It is the command layer beneath the
 * purchasing console (`restaurant-purchasing.ts`) and the L5 console UI.
 *
 * Two invariants shape this module:
 *
 *   - Stock truth is the ledger, never a column. Every `PURCHASE_RECEIPT` and
 *     `SUPPLIER_RETURN` posting flows through the L1 primitive
 *     (`inventory-ledger.ts::postStockMovements`) with `unitCost` set on the
 *     intrinsic-cost movement — this module supplies the cost-carrying
 *     movements; weighted-average cost is derived at READ time by L2 (D07). A
 *     purchase-order line's received quantity is likewise DERIVED by folding the
 *     receipt lines that reference it (converted to the item's canonical unit),
 *     never stored on the line.
 *
 *   - Receiving and returns are idempotent. A receive/return retry carrying the
 *     same org-scoped `RestaurantInventoryIdempotencyKey` applies EXACTLY once:
 *     the first call records the key and creates the receipt/movement rows; a
 *     replay short-circuits before any write and returns the original result.
 *     Because a receipt creates several rows (receipt + lines + batches +
 *     discrepancies + movements) the idempotency gate is held at the WHOLE-
 *     command level here, inside one tenant-scoped transaction, so the ledger
 *     primitive is invoked WITHOUT its own key (the outer key governs replay).
 *
 * The PO state machine (§11.4): DRAFT → SUBMITTED → APPROVED →
 * PARTIALLY_RECEIVED → RECEIVED → CLOSED, with CANCELLED reachable from any
 * pre-receipt state. Receiving is permitted ONLY against APPROVED or
 * PARTIALLY_RECEIVED orders. Approval is gated (at the console edge) on
 * `purchasing:approve`, creation on `purchasing:create`; this module enforces
 * the transitions themselves so an out-of-band call cannot skip a state.
 *
 * Concurrency (DEV-775): every command that reads a PO's status to decide what
 * it may do — line edits, lifecycle transitions and receiving — runs in one
 * transaction that first takes the PO row lock (`SELECT … FOR UPDATE`) and
 * re-reads the status under it, and every status write is a conditional
 * transition from the states it was validated against. Two sessions acting on
 * the same PO therefore serialize on one current status: a stale cancel cannot
 * overwrite a committed receipt, and a receipt cannot post against an order
 * that was cancelled while it waited.
 */

export type PurchasingErrorReason =
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'EMPTY_ORDER'
  | 'EMPTY_RECEIPT'
  | 'LINE_NOT_ON_ORDER'
  | 'RECEIVING_LOCATION_REQUIRED'
  | 'INVALID';

export class PurchasingError extends Error {
  constructor(
    message: string,
    readonly reason: PurchasingErrorReason
  ) {
    super(message);
    this.name = 'PurchasingError';
  }
}

/** Mirrors the Prisma `RestaurantPurchaseOrderStatus` enum (§11.4 lifecycle). */
export type PurchaseOrderStatus =
  'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED' | 'CANCELLED';

/** Mirrors the Prisma `RestaurantReceivingDiscrepancyKind` enum. */
export type ReceivingDiscrepancyKind =
  'SHORTAGE' | 'OVERAGE' | 'DAMAGED' | 'EXPIRED' | 'REJECTED' | 'OTHER';

/** Statuses a receipt may be posted against (§6.5 — never DRAFT/SUBMITTED). */
const RECEIVABLE_STATUSES: ReadonlySet<PurchaseOrderStatus> = new Set([
  'APPROVED',
  'PARTIALLY_RECEIVED',
]);

/** States a PO may still be cancelled from — before any goods have arrived. */
const CANCELLABLE_STATUSES: ReadonlySet<PurchaseOrderStatus> = new Set([
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
]);

/** States a PO may be closed from — once at least one receipt has posted. */
const CLOSEABLE_STATUSES: ReadonlySet<PurchaseOrderStatus> = new Set([
  'PARTIALLY_RECEIVED',
  'RECEIVED',
]);

const ZERO = new Prisma.Decimal(0);
/** Exclusive bound of a DECIMAL(18,6) column: at most 12 integer digits. */
const DECIMAL_18_6_LIMIT = new Prisma.Decimal(10).pow(12);

/**
 * Parse a purchasing quantity or cost into the DECIMAL(18,6) domain. NaN and
 * ±Infinity are valid `Prisma.Decimal` values (and PostgreSQL `numeric` stores
 * NaN past a `>= 0` CHECK), so they — like malformed text, excess scale/range and
 * forbidden signs — must be refused before anything is written.
 */
function decimal(
  value: Prisma.Decimal | string | number,
  label: string,
  domain: 'positive' | 'nonnegative' = 'nonnegative'
): Prisma.Decimal {
  let parsed: Prisma.Decimal;
  try {
    parsed = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  } catch {
    throw new PurchasingError(`${label} must be a valid decimal.`, 'INVALID');
  }
  const valid =
    parsed.isFinite() &&
    parsed.decimalPlaces() <= 6 &&
    parsed.abs().lessThan(DECIMAL_18_6_LIMIT) &&
    (domain === 'positive' ? parsed.greaterThan(0) : parsed.greaterThanOrEqualTo(0));
  if (!valid) {
    throw new PurchasingError(
      `${label} must be a finite ${domain === 'positive' ? 'positive' : 'non-negative'} decimal ` +
        'with at most 12 integer digits and 6 decimal places.',
      'INVALID'
    );
  }
  return parsed;
}

// ── Suppliers ─────────────────────────────────────────────────────────────────

export type CreateSupplierInput = {
  name: string;
  code?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
};

export type UpdateSupplierInput = Partial<CreateSupplierInput>;

const SUPPLIER_SELECT = {
  id: true,
  name: true,
  code: true,
  contactName: true,
  contactEmail: true,
  contactPhone: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RestaurantSupplierSelect;

export async function createSupplier(db: ScopedDb, input: CreateSupplierInput) {
  return db.restaurantSupplier.create({
    data: {
      name: input.name,
      code: input.code ?? null,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
    },
    select: SUPPLIER_SELECT,
  });
}

export async function updateSupplier(db: ScopedDb, id: string, patch: UpdateSupplierInput) {
  await requireSupplier(db, id);
  return db.restaurantSupplier.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.code !== undefined ? { code: patch.code } : {}),
      ...(patch.contactName !== undefined ? { contactName: patch.contactName } : {}),
      ...(patch.contactEmail !== undefined ? { contactEmail: patch.contactEmail } : {}),
      ...(patch.contactPhone !== undefined ? { contactPhone: patch.contactPhone } : {}),
    },
    select: SUPPLIER_SELECT,
  });
}

export async function setSupplierActive(db: ScopedDb, id: string, isActive: boolean) {
  await requireSupplier(db, id);
  return db.restaurantSupplier.update({
    where: { id },
    data: { isActive },
    select: SUPPLIER_SELECT,
  });
}

export type ListSuppliersInput = {
  activeOnly?: boolean;
  limit?: number;
  cursor?: string;
};

export async function listSuppliers(db: ScopedDb, input: ListSuppliersInput = {}) {
  const limit = input.limit ?? 50;
  const rows = await db.restaurantSupplier.findMany({
    where: input.activeOnly ? { isActive: true } : undefined,
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: SUPPLIER_SELECT,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { suppliers: page, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
}

export async function getSupplier(db: ScopedDb, id: string) {
  return requireSupplier(db, id);
}

async function requireSupplier(db: ScopedDb, id: string) {
  const supplier = await db.restaurantSupplier.findUnique({
    where: { id },
    select: SUPPLIER_SELECT,
  });
  if (!supplier) throw new PurchasingError('The supplier does not exist.', 'NOT_FOUND');
  return supplier;
}

// ── Purchase orders — creation & line editing (DRAFT only) ──────────────────────

export type PurchaseOrderLineInput = {
  stockItemId: string;
  orderedQuantity: Prisma.Decimal | string | number;
  unitId: string;
  unitCost: Prisma.Decimal | string | number;
};

export type CreatePurchaseOrderInput = {
  supplierId: string;
  branchId: string;
  locationId?: string | null;
  reference?: string | null;
  expectedDate?: Date | null;
  createdByStaffProfileId?: string | null;
  lines?: readonly PurchaseOrderLineInput[];
  /** Internal authoritative creation instant; public routers never accept it. */
  now?: Date;
};

export async function createPurchaseOrder(db: ScopedDb, input: CreatePurchaseOrderInput) {
  if (input.now && !Number.isFinite(input.now.getTime())) {
    throw new PurchasingError('Purchase order creation time must be valid.', 'INVALID');
  }
  const order = await db.restaurantPurchaseOrder.create({
    data: {
      supplierId: input.supplierId,
      branchId: input.branchId,
      locationId: input.locationId ?? null,
      reference: input.reference ?? null,
      expectedDate: input.expectedDate ?? null,
      createdByStaffProfileId: input.createdByStaffProfileId ?? null,
      ...(input.now ? { createdAt: input.now } : {}),
      status: 'DRAFT',
      lines: input.lines?.length
        ? {
            create: input.lines.map((line) => ({
              stockItemId: line.stockItemId,
              orderedQuantity: decimal(line.orderedQuantity, 'Ordered quantity'),
              unitId: line.unitId,
              unitCost: decimal(line.unitCost, 'Unit cost'),
            })),
          }
        : undefined,
    },
    select: { id: true },
  });
  return getPurchaseOrder(db, order.id);
}

export async function addPurchaseOrderLine(
  db: ScopedDb,
  purchaseOrderId: string,
  line: PurchaseOrderLineInput
) {
  const orderedQuantity = decimal(line.orderedQuantity, 'Ordered quantity');
  const unitCost = decimal(line.unitCost, 'Unit cost');
  return runStockTransaction(db, async (tx) => {
    const order = await requirePurchaseOrderStatus(tx, purchaseOrderId, 'DRAFT');
    await tx.restaurantPurchaseOrderLine.create({
      data: {
        purchaseOrderId: order.id,
        stockItemId: line.stockItemId,
        orderedQuantity,
        unitId: line.unitId,
        unitCost,
      },
      select: { id: true },
    });
    return getPurchaseOrder(tx, purchaseOrderId);
  });
}

export type UpdatePurchaseOrderLineInput = {
  orderedQuantity?: Prisma.Decimal | string | number;
  unitId?: string;
  unitCost?: Prisma.Decimal | string | number;
};

export async function updatePurchaseOrderLine(
  db: ScopedDb,
  purchaseOrderId: string,
  lineId: string,
  patch: UpdatePurchaseOrderLineInput
) {
  const orderedQuantity =
    patch.orderedQuantity !== undefined
      ? decimal(patch.orderedQuantity, 'Ordered quantity')
      : undefined;
  const unitCost = patch.unitCost !== undefined ? decimal(patch.unitCost, 'Unit cost') : undefined;
  return runStockTransaction(db, async (tx) => {
    await requirePurchaseOrderStatus(tx, purchaseOrderId, 'DRAFT');
    const line = await tx.restaurantPurchaseOrderLine.findFirst({
      where: { id: lineId, purchaseOrderId },
      select: { id: true },
    });
    if (!line) {
      throw new PurchasingError('The order line is not on this order.', 'LINE_NOT_ON_ORDER');
    }
    await tx.restaurantPurchaseOrderLine.update({
      where: { id: lineId },
      data: {
        ...(orderedQuantity !== undefined ? { orderedQuantity } : {}),
        ...(patch.unitId !== undefined ? { unitId: patch.unitId } : {}),
        ...(unitCost !== undefined ? { unitCost } : {}),
      },
      select: { id: true },
    });
    return getPurchaseOrder(tx, purchaseOrderId);
  });
}

export async function removePurchaseOrderLine(
  db: ScopedDb,
  purchaseOrderId: string,
  lineId: string
) {
  return runStockTransaction(db, async (tx) => {
    await requirePurchaseOrderStatus(tx, purchaseOrderId, 'DRAFT');
    const { count } = await tx.restaurantPurchaseOrderLine.deleteMany({
      where: { id: lineId, purchaseOrderId },
    });
    if (count === 0)
      throw new PurchasingError('The order line is not on this order.', 'LINE_NOT_ON_ORDER');
    return getPurchaseOrder(tx, purchaseOrderId);
  });
}

// ── Purchase orders — lifecycle transitions (server-side guards) ────────────────

export async function submitPurchaseOrder(db: ScopedDb, purchaseOrderId: string, now?: Date) {
  return runStockTransaction(db, async (tx) => {
    const order = await requirePurchaseOrderStatus(tx, purchaseOrderId, 'DRAFT');
    const lineCount = await tx.restaurantPurchaseOrderLine.count({
      where: { purchaseOrderId: order.id },
    });
    if (lineCount === 0)
      throw new PurchasingError('Cannot submit a purchase order with no lines.', 'EMPTY_ORDER');
    await transitionPurchaseOrder(tx, order.id, ['DRAFT'], {
      status: 'SUBMITTED',
      submittedAt: now ?? new Date(),
    });
    return getPurchaseOrder(tx, purchaseOrderId);
  });
}

export type ApprovePurchaseOrderInput = {
  approvedByStaffProfileId?: string | null;
  now?: Date;
};

export async function approvePurchaseOrder(
  db: ScopedDb,
  purchaseOrderId: string,
  input: ApprovePurchaseOrderInput = {}
) {
  return runStockTransaction(db, async (tx) => {
    const order = await requirePurchaseOrderStatus(tx, purchaseOrderId, 'SUBMITTED');
    await transitionPurchaseOrder(tx, order.id, ['SUBMITTED'], {
      status: 'APPROVED',
      approvedAt: input.now ?? new Date(),
      approvedByStaffProfileId: input.approvedByStaffProfileId ?? null,
    });
    return getPurchaseOrder(tx, purchaseOrderId);
  });
}

export async function cancelPurchaseOrder(db: ScopedDb, purchaseOrderId: string, now?: Date) {
  return runStockTransaction(db, async (tx) => {
    const order = await requirePurchaseOrder(tx, purchaseOrderId);
    if (!CANCELLABLE_STATUSES.has(order.status)) {
      throw new PurchasingError(
        `A purchase order in ${order.status} cannot be cancelled.`,
        'INVALID_STATE'
      );
    }
    await transitionPurchaseOrder(tx, order.id, [...CANCELLABLE_STATUSES], {
      status: 'CANCELLED',
      cancelledAt: now ?? new Date(),
    });
    return getPurchaseOrder(tx, purchaseOrderId);
  });
}

export async function closePurchaseOrder(db: ScopedDb, purchaseOrderId: string, now?: Date) {
  return runStockTransaction(db, async (tx) => {
    const order = await requirePurchaseOrder(tx, purchaseOrderId);
    if (!CLOSEABLE_STATUSES.has(order.status)) {
      throw new PurchasingError(
        `A purchase order in ${order.status} cannot be closed.`,
        'INVALID_STATE'
      );
    }
    await transitionPurchaseOrder(tx, order.id, [...CLOSEABLE_STATUSES], {
      status: 'CLOSED',
      closedAt: now ?? new Date(),
    });
    return getPurchaseOrder(tx, purchaseOrderId);
  });
}

// ── Receiving ───────────────────────────────────────────────────────────────────

export type ReceiveDiscrepancyInput = {
  kind: ReceivingDiscrepancyKind;
  expectedQuantity: Prisma.Decimal | string | number;
  receivedQuantity: Prisma.Decimal | string | number;
  note?: string | null;
};

export type ReceiveLineInput = {
  purchaseOrderLineId: string;
  receivedQuantity: Prisma.Decimal | string | number;
  /** Receiving unit; defaults to the PO line's ordering unit. */
  unitId?: string | null;
  /** Actual received unit cost; defaults to the PO line's expected cost. */
  unitCost?: Prisma.Decimal | string | number | null;
  /** Optional batch/lot — recordable, never enforced (D07). */
  batch?: { code: string; expiryDate?: Date | null } | null;
  /** Caller-recorded discrepancies (shortage/damaged/expired/rejected/…). */
  discrepancies?: readonly ReceiveDiscrepancyInput[];
};

export type ReceivePurchaseOrderInput = {
  purchaseOrderId: string;
  /** Receiving location; defaults to the PO's default receiving location. */
  locationId?: string | null;
  reference?: string | null;
  receivedAt?: Date;
  actor?: {
    staffProfileId?: string | null;
    deviceId?: string | null;
    idempotencyKey?: string | null;
  };
  lines: readonly ReceiveLineInput[];
  now?: Date;
};

export type ReceivedMovement = {
  id: string;
  stockItemId: string;
  locationId: string;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
  batchId: string | null;
};

export type ReceivePurchaseOrderResult = {
  receiptId: string;
  purchaseOrderId: string;
  purchaseOrderStatus: PurchaseOrderStatus;
  movements: ReceivedMovement[];
  discrepancyIds: string[];
  replayed: boolean;
};

/**
 * Receive goods against an APPROVED or PARTIALLY_RECEIVED purchase order. Posts
 * one `PURCHASE_RECEIPT` movement per line through the L1 primitive (with
 * `unitCost`), records the receipt + its lines + optional batches, auto-records
 * price-variance and overage discrepancies (plus any caller-supplied ones), then
 * advances the PO to PARTIALLY_RECEIVED or RECEIVED from the DERIVED per-line
 * received quantities. The whole command is idempotent on `actor.idempotencyKey`.
 */
export async function receivePurchaseOrder(
  db: ScopedDb,
  input: ReceivePurchaseOrderInput
): Promise<ReceivePurchaseOrderResult> {
  if (input.lines.length === 0) {
    throw new PurchasingError('A receipt requires at least one line.', 'EMPTY_RECEIPT');
  }
  // Validate every quantity/cost before the transaction opens, so a rejected
  // command leaves no receipt, movement, idempotency key or PO status change.
  for (const line of input.lines) {
    decimal(line.receivedQuantity, 'Received quantity');
    if (line.unitCost != null) decimal(line.unitCost, 'Unit cost');
    for (const discrepancy of line.discrepancies ?? []) {
      decimal(discrepancy.expectedQuantity, 'Discrepancy expected quantity');
      decimal(discrepancy.receivedQuantity, 'Discrepancy received quantity');
    }
  }
  const at = input.now ?? input.receivedAt ?? new Date();
  const key = input.actor?.idempotencyKey ?? null;

  return runStockTransaction(db, async (tx) => {
    if (key) {
      const existing = await tx.restaurantInventoryIdempotencyKey.findFirst({
        where: { key },
        select: { resultRef: true },
      });
      if (existing) {
        if (!existing.resultRef) {
          throw new PurchasingError('The idempotent result reference is missing.', 'INVALID');
        }
        return buildReceiveResult(tx, existing.resultRef, true);
      }
      await tx.restaurantInventoryIdempotencyKey.create({
        data: {
          key,
          commandType: 'purchasing.receive',
          deviceId: input.actor?.deviceId ?? null,
        },
      });
    }

    // Lock the PO row and re-read its status under the lock BEFORE any receipt
    // or stock write, so a concurrent cancel/close/receive serializes behind
    // (or ahead of) this receipt instead of acting on a stale status.
    const locked = await requirePurchaseOrder(tx, input.purchaseOrderId);
    if (!RECEIVABLE_STATUSES.has(locked.status)) {
      throw new PurchasingError(
        `A purchase order in ${locked.status} cannot receive goods.`,
        'INVALID_STATE'
      );
    }
    const order = await tx.restaurantPurchaseOrder.findUnique({
      where: { id: locked.id },
      select: {
        id: true,
        status: true,
        supplierId: true,
        branchId: true,
        locationId: true,
        lines: { select: { id: true, stockItemId: true, unitId: true, unitCost: true } },
      },
    });
    if (!order) throw new PurchasingError('The purchase order does not exist.', 'NOT_FOUND');
    if (!RECEIVABLE_STATUSES.has(order.status as PurchaseOrderStatus)) {
      throw new PurchasingError(
        `A purchase order in ${order.status} cannot receive goods.`,
        'INVALID_STATE'
      );
    }

    const locationId = input.locationId ?? order.locationId;
    if (!locationId) {
      throw new PurchasingError(
        'A receiving location is required (the order has no default).',
        'RECEIVING_LOCATION_REQUIRED'
      );
    }

    const poLineById = new Map(order.lines.map((line) => [line.id, line]));
    for (const line of input.lines) {
      if (!poLineById.has(line.purchaseOrderLineId)) {
        throw new PurchasingError(
          'A receipt line references a line not on this order.',
          'LINE_NOT_ON_ORDER'
        );
      }
    }

    const receipt = await tx.restaurantPurchaseReceipt.create({
      data: {
        purchaseOrderId: order.id,
        supplierId: order.supplierId,
        branchId: order.branchId,
        locationId,
        reference: input.reference ?? null,
        receivedAt: at,
        staffProfileId: input.actor?.staffProfileId ?? null,
        deviceId: input.actor?.deviceId ?? null,
      },
      select: { id: true },
    });

    const movementInputs: StockMovementInput[] = [];
    const discrepancyIds: string[] = [];

    for (const line of input.lines) {
      const poLine = poLineById.get(line.purchaseOrderLineId)!;
      const stockItemId = poLine.stockItemId;
      const unitId = line.unitId ?? poLine.unitId;
      const unitCost =
        line.unitCost != null ? decimal(line.unitCost, 'Unit cost') : poLine.unitCost;
      const receivedQuantity = decimal(line.receivedQuantity, 'Received quantity');

      let batchId: string | null = null;
      if (line.batch) {
        batchId = await upsertBatch(tx, stockItemId, receipt.id, line.batch);
      }

      const receiptLine = await tx.restaurantPurchaseReceiptLine.create({
        data: {
          purchaseReceiptId: receipt.id,
          purchaseOrderLineId: poLine.id,
          stockItemId,
          receivedQuantity,
          unitId,
          unitCost,
          batchId,
        },
        select: { id: true },
      });

      movementInputs.push({
        stockItemId,
        locationId,
        reason: 'PURCHASE_RECEIPT',
        quantity: receivedQuantity,
        unitId,
        unitCost,
        occurredAt: at,
        batchId,
        receiptId: receipt.id,
      });

      // Auto price-variance discrepancy (§AC) — only comparable when the receipt
      // line is priced in the same unit as the order line.
      if (unitId === poLine.unitId && !unitCost.equals(poLine.unitCost)) {
        const id = await recordDiscrepancy(tx, {
          purchaseReceiptId: receipt.id,
          purchaseReceiptLineId: receiptLine.id,
          stockItemId,
          kind: 'OTHER',
          expectedQuantity: receivedQuantity,
          receivedQuantity,
          note: `Price variance: expected ${poLine.unitCost.toString()}, received ${unitCost.toString()} per unit.`,
        });
        discrepancyIds.push(id);
      }

      // Caller-recorded discrepancies (shortage/damaged/expired/rejected/…).
      for (const discrepancy of line.discrepancies ?? []) {
        const id = await recordDiscrepancy(tx, {
          purchaseReceiptId: receipt.id,
          purchaseReceiptLineId: receiptLine.id,
          stockItemId,
          kind: discrepancy.kind,
          expectedQuantity: decimal(discrepancy.expectedQuantity, 'Discrepancy expected quantity'),
          receivedQuantity: decimal(discrepancy.receivedQuantity, 'Discrepancy received quantity'),
          note: discrepancy.note ?? null,
        });
        discrepancyIds.push(id);
      }
    }

    // Post the cost-carrying movements through the L1 primitive. NO idempotency
    // key here — the whole command's replay is governed by the outer key above,
    // and this call runs inside the same transaction (unit conversion + cost
    // inversion happen in the primitive; the returned quantities are canonical).
    await postStockMovements(tx, {
      actor: {
        staffProfileId: input.actor?.staffProfileId ?? null,
        deviceId: input.actor?.deviceId ?? null,
      },
      movements: movementInputs,
      commandType: 'purchasing.receive',
      now: at,
    });

    // Auto overage discrepancies + PO status advance from DERIVED received qty.
    const touchedLineIds = [...new Set(input.lines.map((line) => line.purchaseOrderLineId))];
    const overageIds = await recordOverageDiscrepancies(
      tx,
      receipt.id,
      order.lines,
      touchedLineIds
    );
    discrepancyIds.push(...overageIds);

    const nextStatus = await deriveOrderStatusAfterReceipt(tx, order.lines);
    if (nextStatus !== order.status) {
      await transitionPurchaseOrder(tx, order.id, [order.status as PurchaseOrderStatus], {
        status: nextStatus,
      });
    }

    if (key) {
      await tx.restaurantInventoryIdempotencyKey.updateMany({
        where: { key },
        data: { resultRef: receipt.id },
      });
    }

    return buildReceiveResult(tx, receipt.id, false);
  });
}

// ── Supplier returns ────────────────────────────────────────────────────────────

export type SupplierReturnLineInput = {
  stockItemId: string;
  /** Positive quantity to return; posted as a negative `SUPPLIER_RETURN`. */
  quantity: Prisma.Decimal | string | number;
  unitId?: string | null;
  unitCost?: Prisma.Decimal | string | number | null;
  batchId?: string | null;
};

export type CreateSupplierReturnInput = {
  locationId: string;
  reference?: string | null;
  occurredAt?: Date;
  actor?: {
    staffProfileId?: string | null;
    deviceId?: string | null;
    idempotencyKey?: string | null;
  };
  lines: readonly SupplierReturnLineInput[];
  now?: Date;
};

export type CreateSupplierReturnResult = {
  movements: ReceivedMovement[];
  replayed: boolean;
};

/**
 * Return goods to a supplier — posts one negative `SUPPLIER_RETURN` movement per
 * line through the L1 primitive (carrying `unitCost`, D07). There is no return
 * header table, so idempotency is delegated straight to the primitive's key.
 */
export async function createSupplierReturn(
  db: ScopedDb,
  input: CreateSupplierReturnInput
): Promise<CreateSupplierReturnResult> {
  if (input.lines.length === 0) {
    throw new PurchasingError('A supplier return requires at least one line.', 'EMPTY_RECEIPT');
  }
  const at = input.now ?? input.occurredAt ?? new Date();
  const movements: StockMovementInput[] = input.lines.map((line) => {
    const quantity = decimal(line.quantity, 'Return quantity', 'positive');
    return {
      stockItemId: line.stockItemId,
      locationId: input.locationId,
      reason: 'SUPPLIER_RETURN',
      quantity: quantity.negated(),
      unitId: line.unitId ?? null,
      unitCost: line.unitCost != null ? decimal(line.unitCost, 'Unit cost') : null,
      occurredAt: at,
      batchId: line.batchId ?? null,
    };
  });

  const result = await postStockMovements(db, {
    actor: {
      staffProfileId: input.actor?.staffProfileId ?? null,
      deviceId: input.actor?.deviceId ?? null,
      idempotencyKey: input.actor?.idempotencyKey ?? null,
    },
    movements,
    commandType: 'purchasing.supplierReturn',
    now: at,
  });

  return {
    movements: result.movements.map((movement) => ({
      id: movement.id,
      stockItemId: movement.stockItemId,
      locationId: movement.locationId,
      quantity: movement.quantity,
      unitCost: movement.unitCost,
      batchId: movement.batchId,
    })),
    replayed: result.replayed,
  };
}

// ── Read models (purchasing console) ────────────────────────────────────────────

export type ListPurchaseOrdersInput = {
  branchId?: string;
  supplierId?: string;
  status?: PurchaseOrderStatus;
  limit?: number;
  cursor?: string;
};

export async function listPurchaseOrders(db: ScopedDb, input: ListPurchaseOrdersInput = {}) {
  const limit = input.limit ?? 50;
  const rows = await db.restaurantPurchaseOrder.findMany({
    where: {
      branchId: input.branchId,
      supplierId: input.supplierId,
      status: input.status,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      supplierId: true,
      supplier: { select: { name: true } },
      branchId: true,
      locationId: true,
      status: true,
      reference: true,
      expectedDate: true,
      submittedAt: true,
      approvedAt: true,
      closedAt: true,
      cancelledAt: true,
      createdAt: true,
      _count: { select: { lines: true, receipts: true } },
    },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    orders: page.map((order) => ({
      id: order.id,
      supplierId: order.supplierId,
      supplierName: order.supplier.name,
      branchId: order.branchId,
      locationId: order.locationId,
      status: order.status as PurchaseOrderStatus,
      reference: order.reference,
      expectedDate: order.expectedDate,
      submittedAt: order.submittedAt,
      approvedAt: order.approvedAt,
      closedAt: order.closedAt,
      cancelledAt: order.cancelledAt,
      createdAt: order.createdAt,
      lineCount: order._count.lines,
      receiptCount: order._count.receipts,
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getPurchaseOrder(db: ScopedDb, id: string) {
  const order = await db.restaurantPurchaseOrder.findUnique({
    where: { id },
    select: {
      id: true,
      supplierId: true,
      supplier: { select: { name: true } },
      branchId: true,
      locationId: true,
      status: true,
      reference: true,
      expectedDate: true,
      submittedAt: true,
      approvedAt: true,
      closedAt: true,
      cancelledAt: true,
      createdByStaffProfileId: true,
      approvedByStaffProfileId: true,
      createdAt: true,
      updatedAt: true,
      lines: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          stockItemId: true,
          orderedQuantity: true,
          unitId: true,
          unitCost: true,
        },
      },
      receipts: {
        orderBy: { receivedAt: 'asc' },
        select: {
          id: true,
          locationId: true,
          reference: true,
          receivedAt: true,
          staffProfileId: true,
          _count: { select: { lines: true, discrepancies: true } },
        },
      },
    },
  });
  if (!order) throw new PurchasingError('The purchase order does not exist.', 'NOT_FOUND');

  // Per-line received quantity is DERIVED (canonical) from the receipt lines.
  const received = await receivedCanonicalByOrderLine(
    db,
    order.lines.map((line) => ({ id: line.id, stockItemId: line.stockItemId }))
  );
  const canonical = await convertToCanonical(
    db,
    order.lines.map((line) => ({
      key: line.id,
      stockItemId: line.stockItemId,
      quantity: line.orderedQuantity,
      unitId: line.unitId,
    }))
  );

  return {
    id: order.id,
    supplierId: order.supplierId,
    supplierName: order.supplier.name,
    branchId: order.branchId,
    locationId: order.locationId,
    status: order.status as PurchaseOrderStatus,
    reference: order.reference,
    expectedDate: order.expectedDate,
    submittedAt: order.submittedAt,
    approvedAt: order.approvedAt,
    closedAt: order.closedAt,
    cancelledAt: order.cancelledAt,
    createdByStaffProfileId: order.createdByStaffProfileId,
    approvedByStaffProfileId: order.approvedByStaffProfileId,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    lines: order.lines.map((line) => {
      const orderedCanonical = canonical.get(line.id) ?? ZERO;
      const receivedCanonical = received.get(line.id) ?? ZERO;
      return {
        id: line.id,
        stockItemId: line.stockItemId,
        orderedQuantity: line.orderedQuantity,
        unitId: line.unitId,
        unitCost: line.unitCost,
        orderedQuantityCanonical: orderedCanonical,
        receivedQuantityCanonical: receivedCanonical,
        fullyReceived: receivedCanonical.gte(orderedCanonical),
      };
    }),
    receipts: order.receipts.map((receipt) => ({
      id: receipt.id,
      locationId: receipt.locationId,
      reference: receipt.reference,
      receivedAt: receipt.receivedAt,
      staffProfileId: receipt.staffProfileId,
      lineCount: receipt._count.lines,
      discrepancyCount: receipt._count.discrepancies,
    })),
  };
}

export async function getPurchaseReceipt(db: ScopedDb, id: string) {
  const receipt = await db.restaurantPurchaseReceipt.findUnique({
    where: { id },
    select: {
      id: true,
      purchaseOrderId: true,
      supplierId: true,
      branchId: true,
      locationId: true,
      reference: true,
      receivedAt: true,
      staffProfileId: true,
      deviceId: true,
      lines: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          purchaseOrderLineId: true,
          stockItemId: true,
          receivedQuantity: true,
          unitId: true,
          unitCost: true,
          batchId: true,
        },
      },
      discrepancies: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          purchaseReceiptLineId: true,
          stockItemId: true,
          kind: true,
          expectedQuantity: true,
          receivedQuantity: true,
          note: true,
        },
      },
    },
  });
  if (!receipt) throw new PurchasingError('The receipt does not exist.', 'NOT_FOUND');
  return receipt;
}

// ── Internals ────────────────────────────────────────────────────────────────────

/**
 * Lock the purchase-order row (`FOR UPDATE`) and read its CURRENT status under
 * the lock. Must run inside the command's transaction: the lock is held until
 * that transaction ends, so every PO command serializes on one current status.
 * RLS still applies, so another organization's PO reads as NOT_FOUND.
 */
async function requirePurchaseOrder(tx: ScopedDb, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT id, status::text AS status FROM restaurant_purchase_orders WHERE id = ${id} FOR UPDATE`;
  const order = rows[0];
  if (!order) throw new PurchasingError('The purchase order does not exist.', 'NOT_FOUND');
  return { id: order.id, status: order.status as PurchaseOrderStatus };
}

async function requirePurchaseOrderStatus(tx: ScopedDb, id: string, expected: PurchaseOrderStatus) {
  const order = await requirePurchaseOrder(tx, id);
  if (order.status !== expected) {
    throw new PurchasingError(
      `Expected a ${expected} purchase order but it is ${order.status}.`,
      'INVALID_STATE'
    );
  }
  return order;
}

/**
 * Conditional status transition: writes only while the PO is still in one of
 * the `from` states the caller validated, and fails closed otherwise — a stale
 * status read can never overwrite a newer lifecycle state.
 */
async function transitionPurchaseOrder(
  tx: ScopedDb,
  id: string,
  from: readonly PurchaseOrderStatus[],
  data: Prisma.RestaurantPurchaseOrderUncheckedUpdateManyInput & { status: PurchaseOrderStatus }
): Promise<void> {
  const { count } = await tx.restaurantPurchaseOrder.updateMany({
    where: { id, status: { in: [...from] } },
    data,
  });
  if (count !== 1) {
    throw new PurchasingError(
      'The purchase order changed state while this command ran. Reload it and try again.',
      'INVALID_STATE'
    );
  }
}

async function upsertBatch(
  tx: ScopedDb,
  stockItemId: string,
  receiptId: string,
  batch: { code: string; expiryDate?: Date | null }
): Promise<string> {
  const existing = await tx.restaurantStockBatch.findUnique({
    where: { stockItemId_code: { stockItemId, code: batch.code } },
    select: { id: true },
  });
  if (existing) {
    if (batch.expiryDate !== undefined) {
      await tx.restaurantStockBatch.update({
        where: { id: existing.id },
        data: { expiryDate: batch.expiryDate ?? null },
        select: { id: true },
      });
    }
    return existing.id;
  }
  const created = await tx.restaurantStockBatch.create({
    data: {
      stockItemId,
      receiptId,
      code: batch.code,
      expiryDate: batch.expiryDate ?? null,
    },
    select: { id: true },
  });
  return created.id;
}

async function recordDiscrepancy(
  tx: ScopedDb,
  data: {
    purchaseReceiptId: string;
    purchaseReceiptLineId: string | null;
    stockItemId: string;
    kind: ReceivingDiscrepancyKind;
    expectedQuantity: Prisma.Decimal;
    receivedQuantity: Prisma.Decimal;
    note: string | null;
  }
): Promise<string> {
  const row = await tx.restaurantReceivingDiscrepancy.create({ data, select: { id: true } });
  return row.id;
}

/** Record an OVERAGE for every touched line whose cumulative received (canonical)
 * now exceeds its ordered (canonical) quantity. */
async function recordOverageDiscrepancies(
  tx: ScopedDb,
  receiptId: string,
  orderLines: ReadonlyArray<{
    id: string;
    stockItemId: string;
    unitId: string;
    unitCost: Prisma.Decimal;
  }>,
  touchedLineIds: readonly string[]
): Promise<string[]> {
  const touched = orderLines.filter((line) => touchedLineIds.includes(line.id));
  if (touched.length === 0) return [];

  const received = await receivedCanonicalByOrderLine(tx, touched);
  const ordered = await orderedCanonicalByOrderLine(tx, touched);

  const ids: string[] = [];
  for (const line of touched) {
    const receivedQty = received.get(line.id) ?? ZERO;
    const orderedQty = ordered.get(line.id) ?? ZERO;
    if (receivedQty.gt(orderedQty)) {
      const id = await recordDiscrepancy(tx, {
        purchaseReceiptId: receiptId,
        purchaseReceiptLineId: null,
        stockItemId: line.stockItemId,
        kind: 'OVERAGE',
        expectedQuantity: orderedQty,
        receivedQuantity: receivedQty,
        note: `Received ${receivedQty.toString()} exceeds ordered ${orderedQty.toString()} (canonical unit).`,
      });
      ids.push(id);
    }
  }
  return ids;
}

/** Derive the PO status after a receipt from the per-line received quantities. */
async function deriveOrderStatusAfterReceipt(
  tx: ScopedDb,
  orderLines: ReadonlyArray<{
    id: string;
    stockItemId: string;
    unitId: string;
    unitCost: Prisma.Decimal;
  }>
): Promise<PurchaseOrderStatus> {
  if (orderLines.length === 0) return 'RECEIVED';
  const received = await receivedCanonicalByOrderLine(tx, orderLines);
  const ordered = await orderedCanonicalByOrderLine(tx, orderLines);
  const allFull = orderLines.every((line) => {
    const receivedQty = received.get(line.id) ?? ZERO;
    const orderedQty = ordered.get(line.id) ?? ZERO;
    return receivedQty.gte(orderedQty);
  });
  return allFull ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
}

/** Sum every receipt line for the given order lines, converted to canonical. */
async function receivedCanonicalByOrderLine(
  db: ScopedDb,
  orderLines: ReadonlyArray<{ id: string }>
): Promise<Map<string, Prisma.Decimal>> {
  const orderLineIds = orderLines.map((line) => line.id);
  if (orderLineIds.length === 0) return new Map();
  const receiptLines = await db.restaurantPurchaseReceiptLine.findMany({
    where: { purchaseOrderLineId: { in: orderLineIds } },
    select: {
      purchaseOrderLineId: true,
      stockItemId: true,
      receivedQuantity: true,
      unitId: true,
    },
  });
  const canonical = await convertToCanonical(
    db,
    receiptLines.map((line, index) => ({
      key: `${index}`,
      stockItemId: line.stockItemId,
      quantity: line.receivedQuantity,
      unitId: line.unitId,
    }))
  );
  const totals = new Map<string, Prisma.Decimal>();
  receiptLines.forEach((line, index) => {
    if (line.purchaseOrderLineId == null) return;
    const quantity = canonical.get(`${index}`) ?? ZERO;
    totals.set(
      line.purchaseOrderLineId,
      (totals.get(line.purchaseOrderLineId) ?? ZERO).plus(quantity)
    );
  });
  return totals;
}

/** Ordered quantity per order line, converted to the item's canonical unit. */
async function orderedCanonicalByOrderLine(
  db: ScopedDb,
  orderLines: ReadonlyArray<{
    id: string;
    stockItemId: string;
    unitId: string;
  }>
): Promise<Map<string, Prisma.Decimal>> {
  const lines = await db.restaurantPurchaseOrderLine.findMany({
    where: { id: { in: orderLines.map((line) => line.id) } },
    select: { id: true, stockItemId: true, orderedQuantity: true, unitId: true },
  });
  const canonical = await convertToCanonical(
    db,
    lines.map((line) => ({
      key: line.id,
      stockItemId: line.stockItemId,
      quantity: line.orderedQuantity,
      unitId: line.unitId,
    }))
  );
  return canonical;
}

/**
 * Convert a batch of `{quantity, unitId}` to each stock item's canonical unit
 * (identity, or one directed `RestaurantUnitConversion` factor), keyed by the
 * caller's `key`. Mirrors the conversion the L1 ledger primitive applies at post
 * time; used here only for READ-side derived quantities (received vs ordered).
 */
async function convertToCanonical(
  db: ScopedDb,
  items: ReadonlyArray<{
    key: string;
    stockItemId: string;
    quantity: Prisma.Decimal;
    unitId: string;
  }>
): Promise<Map<string, Prisma.Decimal>> {
  const result = new Map<string, Prisma.Decimal>();
  if (items.length === 0) return result;

  const stockItemIds = [...new Set(items.map((item) => item.stockItemId))];
  const stockItems = await db.restaurantStockItem.findMany({
    where: { id: { in: stockItemIds } },
    select: { id: true, canonicalUnitId: true },
  });
  const canonicalUnitByItem = new Map(stockItems.map((item) => [item.id, item.canonicalUnitId]));

  const neededPairs = new Map<string, { fromUnitId: string; toUnitId: string }>();
  for (const item of items) {
    const canonicalUnitId = canonicalUnitByItem.get(item.stockItemId);
    if (!canonicalUnitId) {
      throw new PurchasingError(`Unknown stock item: ${item.stockItemId}.`, 'INVALID');
    }
    if (item.unitId !== canonicalUnitId) {
      neededPairs.set(`${item.unitId}->${canonicalUnitId}`, {
        fromUnitId: item.unitId,
        toUnitId: canonicalUnitId,
      });
    }
  }

  const factors = new Map<string, Prisma.Decimal>();
  for (const [pairKey, pair] of neededPairs) {
    const conversion = await db.restaurantUnitConversion.findUnique({
      where: { fromUnitId_toUnitId: { fromUnitId: pair.fromUnitId, toUnitId: pair.toUnitId } },
      select: { factor: true },
    });
    if (!conversion) {
      throw new PurchasingError(
        `No unit conversion from ${pair.fromUnitId} to ${pair.toUnitId}.`,
        'INVALID'
      );
    }
    factors.set(pairKey, conversion.factor);
  }

  for (const item of items) {
    const canonicalUnitId = canonicalUnitByItem.get(item.stockItemId)!;
    const factor =
      item.unitId === canonicalUnitId
        ? new Prisma.Decimal(1)
        : factors.get(`${item.unitId}->${canonicalUnitId}`)!;
    result.set(item.key, item.quantity.times(factor));
  }
  return result;
}

/** Rebuild a receive result from persisted rows (fresh return AND idempotent replay). */
async function buildReceiveResult(
  tx: ScopedDb,
  receiptId: string,
  replayed: boolean
): Promise<ReceivePurchaseOrderResult> {
  const receipt = await tx.restaurantPurchaseReceipt.findUnique({
    where: { id: receiptId },
    select: {
      id: true,
      purchaseOrderId: true,
      purchaseOrder: { select: { status: true } },
      movements: {
        orderBy: { recordedAt: 'asc' },
        select: {
          id: true,
          stockItemId: true,
          locationId: true,
          quantity: true,
          unitCost: true,
          batchId: true,
        },
      },
      discrepancies: { orderBy: { createdAt: 'asc' }, select: { id: true } },
    },
  });
  if (!receipt) {
    throw new PurchasingError('The receipt no longer exists.', 'NOT_FOUND');
  }
  return {
    receiptId: receipt.id,
    purchaseOrderId: receipt.purchaseOrderId ?? '',
    purchaseOrderStatus: (receipt.purchaseOrder?.status ?? 'RECEIVED') as PurchaseOrderStatus,
    movements: receipt.movements.map((movement) => ({
      id: movement.id,
      stockItemId: movement.stockItemId,
      locationId: movement.locationId,
      quantity: movement.quantity,
      unitCost: movement.unitCost,
      batchId: movement.batchId,
    })),
    discrepancyIds: receipt.discrepancies.map((discrepancy) => discrepancy.id),
    replayed,
  };
}
