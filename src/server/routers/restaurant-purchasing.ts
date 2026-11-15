import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import { router, capabilityProcedure, type TRPCContext } from '../trpc';
import { annotateAudit } from '../audit';
import { resolveRestaurantActor } from '../restaurant-actor';
import {
  PurchasingError,
  createSupplier,
  updateSupplier,
  setSupplierActive,
  listSuppliers,
  getSupplier,
  createPurchaseOrder,
  addPurchaseOrderLine,
  updatePurchaseOrderLine,
  removePurchaseOrderLine,
  submitPurchaseOrder,
  approvePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  receivePurchaseOrder,
  createSupplierReturn,
  listPurchaseOrders,
  getPurchaseOrder,
  getPurchaseReceipt,
} from '@/lib/restaurant/purchasing';

/**
 * M6-L3 — the purchasing & suppliers CONSOLE SERVER (§6.5 / §11.4). It is the
 * back-office tRPC edge over the `purchasing.ts` command layer, consumed by the
 * L5 purchasing console.
 *
 * Capability gating (ABAC, org-role-driven — no static policy): reads gate on
 * `inventory:read`; supplier/PO/receiving mutations on `purchasing:create`; the
 * approval transition on `purchasing:approve` (§AC). All require the licensed
 * `restaurant-pos` module (module-catalog.ts). Tenant scoping is the RLS-forced
 * `organizationId` default on every row — a cross-org id is simply invisible and
 * reads/mutations resolve to NOT_FOUND.
 *
 * Every input is `.strict()` (house style — unknown fields are rejected, never
 * stripped). Every Decimal (quantity, cost) crosses the tRPC boundary as a STRING
 * via `.toString()`: superjson does not carry a Prisma `Decimal` and no quantity
 * or cost may round-trip through a float (D07 — stock math is exact).
 */

const readProcedure = capabilityProcedure('inventory:read');
const writeProcedure = capabilityProcedure('purchasing:create');
const approveProcedure = capabilityProcedure('purchasing:approve');

const ID = z.string().min(1);
/**
 * A DECIMAL(18,6) quantity or cost, accepted as a plain decimal string
 * (preferred) or a finite number: at most 12 integer digits and 6 decimal
 * places, no sign, exponent, NaN or ±Infinity (PostgreSQL numeric stores NaN
 * past a `>= 0` CHECK, which would poison derived stock balances).
 */
const DECIMAL_18_6_TEXT = /^\d{1,12}(?:\.\d{1,6})?$/;
const decimal18_6 = (domain: 'positive' | 'nonnegative') =>
  z
    .union([z.string(), z.number().finite()])
    .transform((value) => (typeof value === 'number' ? String(value) : value))
    .pipe(
      z
        .string()
        .regex(
          DECIMAL_18_6_TEXT,
          'Expected a non-negative decimal with at most 12 integer digits and 6 decimal places.'
        )
        .refine((value) => domain === 'nonnegative' || /[1-9]/.test(value), {
          message: 'Expected a positive decimal.',
        })
    );
const DECIMAL = decimal18_6('nonnegative');
const POSITIVE_DECIMAL = decimal18_6('positive');
const DATE_ONLY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a "YYYY-MM-DD" date.');
const PO_STATUS = z.enum([
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
]);
const DISCREPANCY_KIND = z.enum(['SHORTAGE', 'OVERAGE', 'DAMAGED', 'EXPIRED', 'REJECTED', 'OTHER']);

const PO_LINE_INPUT = z
  .object({
    stockItemId: ID,
    orderedQuantity: DECIMAL,
    unitId: ID,
    unitCost: DECIMAL,
  })
  .strict();

const RECEIVE_LINE_INPUT = z
  .object({
    purchaseOrderLineId: ID,
    receivedQuantity: DECIMAL,
    unitId: ID.optional(),
    unitCost: DECIMAL.optional(),
    batch: z.object({ code: ID, expiryDate: DATE_ONLY.optional() }).strict().optional(),
    discrepancies: z
      .array(
        z
          .object({
            kind: DISCREPANCY_KIND,
            expectedQuantity: DECIMAL,
            receivedQuantity: DECIMAL,
            note: z.string().optional(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

const RETURN_LINE_INPUT = z
  .object({
    stockItemId: ID,
    quantity: POSITIVE_DECIMAL,
    unitId: ID.optional(),
    unitCost: DECIMAL.optional(),
    batchId: ID.optional(),
  })
  .strict();

async function requirePurchaseOrderScope(ctx: TRPCContext, purchaseOrderId: string) {
  const order = await ctx.db.restaurantPurchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    select: { branchId: true, locationId: true },
  });
  if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase order not found.' });
  return order;
}

async function requireResourceBranchAccess(
  ctx: TRPCContext,
  branchId: string,
  resource: 'Purchase order' | 'Purchase receipt',
  options: { allowInactiveBranches?: boolean } = {}
) {
  try {
    return await resolveRestaurantActor(ctx, [branchId], options);
  } catch (error) {
    // Resource ids must not disclose records in a branch the caller cannot access.
    if (error instanceof TRPCError && error.code === 'FORBIDDEN') {
      throw new TRPCError({ code: 'NOT_FOUND', message: `${resource} not found.` });
    }
    throw error;
  }
}

async function requirePurchaseOrderAccess(
  ctx: TRPCContext,
  purchaseOrderId: string,
  options: { allowInactiveBranches?: boolean } = {}
) {
  const order = await requirePurchaseOrderScope(ctx, purchaseOrderId);
  const actor = await requireResourceBranchAccess(ctx, order.branchId, 'Purchase order', options);
  return { ...order, actor };
}

async function requireReceiptAccess(ctx: TRPCContext, receiptId: string): Promise<void> {
  const receipt = await ctx.db.restaurantPurchaseReceipt.findUnique({
    where: { id: receiptId },
    select: { branchId: true },
  });
  if (!receipt) throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase receipt not found.' });
  await requireResourceBranchAccess(ctx, receipt.branchId, 'Purchase receipt', {
    allowInactiveBranches: true,
  });
}

async function requirePurchaseOrderListAccess(ctx: TRPCContext, branchId?: string): Promise<void> {
  if (branchId) {
    await resolveRestaurantActor(ctx, [branchId], { allowInactiveBranches: true });
    return;
  }

  await resolveRestaurantActor(ctx, []);
  const user = ctx.session!.user;
  const canReadAllBranches = await can(
    subjectFromSession(user),
    'restaurant:configure',
    undefined,
    { db: ctx.db, source: 'TRPC', ip: ctx.requestMeta.ip }
  );
  if (!canReadAllBranches) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Listing purchase orders across all branches requires restaurant:configure.',
    });
  }
}

async function requireLocationInBranch(
  ctx: TRPCContext,
  locationId: string,
  branchId: string
): Promise<void> {
  const location = await ctx.db.restaurantStockLocation.findUnique({
    where: { id: locationId },
    select: { branchId: true },
  });
  if (!location || location.branchId !== branchId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The stock location is not authorized for this purchase order branch.',
    });
  }
}

export const restaurantPurchasingRouter = router({
  // ── Suppliers ─────────────────────────────────────────────────────────────────
  listSuppliers: readProcedure
    .input(
      z
        .object({
          activeOnly: z.boolean().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: ID.optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => listSuppliers(ctx.db, input)),

  getSupplier: readProcedure
    .input(z.object({ supplierId: ID }).strict())
    .query(({ ctx, input }) => run(() => getSupplier(ctx.db, input.supplierId))),

  createSupplier: writeProcedure
    .input(
      z
        .object({
          name: z.string().min(1).max(200),
          code: z.string().max(64).optional(),
          contactName: z.string().max(200).optional(),
          contactEmail: z.string().max(320).optional(),
          contactPhone: z.string().max(64).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const supplier = await createSupplier(ctx.db, input);
      annotateAudit(ctx, {
        targetType: 'RestaurantSupplier',
        targetId: supplier.id,
        targetLabel: supplier.name,
        description: `Created supplier "${supplier.name}"`,
      });
      return supplier;
    }),

  updateSupplier: writeProcedure
    .input(
      z
        .object({
          supplierId: ID,
          name: z.string().min(1).max(200).optional(),
          code: z.string().max(64).nullable().optional(),
          contactName: z.string().max(200).nullable().optional(),
          contactEmail: z.string().max(320).nullable().optional(),
          contactPhone: z.string().max(64).nullable().optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) => {
      const { supplierId, ...patch } = input;
      annotateAudit(ctx, { targetType: 'RestaurantSupplier', targetId: supplierId });
      return run(() => updateSupplier(ctx.db, supplierId, patch));
    }),

  setSupplierActive: writeProcedure
    .input(z.object({ supplierId: ID, isActive: z.boolean() }).strict())
    .mutation(({ ctx, input }) => {
      annotateAudit(ctx, { targetType: 'RestaurantSupplier', targetId: input.supplierId });
      return run(() => setSupplierActive(ctx.db, input.supplierId, input.isActive));
    }),

  // ── Purchase orders — reads ─────────────────────────────────────────────────────
  listPurchaseOrders: readProcedure
    .input(
      z
        .object({
          branchId: ID.optional(),
          supplierId: ID.optional(),
          status: PO_STATUS.optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: ID.optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      await requirePurchaseOrderListAccess(ctx, input.branchId);
      const result = await listPurchaseOrders(ctx.db, input);
      return { orders: result.orders.map(serializeOrderSummary), nextCursor: result.nextCursor };
    }),

  getPurchaseOrder: readProcedure
    .input(z.object({ purchaseOrderId: ID }).strict())
    .query(({ ctx, input }) =>
      run(async () => {
        await requirePurchaseOrderAccess(ctx, input.purchaseOrderId, { allowInactiveBranches: true });
        return serializePurchaseOrder(await getPurchaseOrder(ctx.db, input.purchaseOrderId));
      })
    ),

  getReceipt: readProcedure
    .input(z.object({ receiptId: ID }).strict())
    .query(({ ctx, input }) =>
      run(async () => {
        await requireReceiptAccess(ctx, input.receiptId);
        return serializeReceipt(await getPurchaseReceipt(ctx.db, input.receiptId));
      })
    ),

  // ── Purchase orders — creation & line editing (DRAFT) ────────────────────────────
  createPurchaseOrder: writeProcedure
    .input(
      z
        .object({
          supplierId: ID,
          branchId: ID,
          locationId: ID.optional(),
          reference: z.string().max(200).optional(),
          expectedDate: DATE_ONLY.optional(),
          lines: z.array(PO_LINE_INPUT).optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      run(async () => {
        const actor = await resolveRestaurantActor(ctx, [input.branchId]);
        if (input.locationId) {
          await requireLocationInBranch(ctx, input.locationId, input.branchId);
        }
        const order = await createPurchaseOrder(ctx.db, {
          ...input,
          expectedDate: parseDateOnly(input.expectedDate),
          createdByStaffProfileId: actor.staffProfileId,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantPurchaseOrder',
          targetId: order.id,
          description: `Created purchase order for supplier ${order.supplierName}`,
        });
        return serializePurchaseOrder(order);
      })
    ),

  addPurchaseOrderLine: writeProcedure
    .input(z.object({ purchaseOrderId: ID, line: PO_LINE_INPUT }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => {
        await requirePurchaseOrderAccess(ctx, input.purchaseOrderId);
        annotateAudit(ctx, {
          targetType: 'RestaurantPurchaseOrder',
          targetId: input.purchaseOrderId,
        });
        return serializePurchaseOrder(
          await addPurchaseOrderLine(ctx.db, input.purchaseOrderId, input.line)
        );
      })
    ),

  updatePurchaseOrderLine: writeProcedure
    .input(
      z
        .object({
          purchaseOrderId: ID,
          lineId: ID,
          orderedQuantity: DECIMAL.optional(),
          unitId: ID.optional(),
          unitCost: DECIMAL.optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) => {
      const { purchaseOrderId, lineId, ...patch } = input;
      return run(async () => {
        await requirePurchaseOrderAccess(ctx, purchaseOrderId);
        annotateAudit(ctx, { targetType: 'RestaurantPurchaseOrder', targetId: purchaseOrderId });
        return serializePurchaseOrder(
          await updatePurchaseOrderLine(ctx.db, purchaseOrderId, lineId, patch)
        );
      });
    }),

  removePurchaseOrderLine: writeProcedure
    .input(z.object({ purchaseOrderId: ID, lineId: ID }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => {
        await requirePurchaseOrderAccess(ctx, input.purchaseOrderId);
        annotateAudit(ctx, {
          targetType: 'RestaurantPurchaseOrder',
          targetId: input.purchaseOrderId,
        });
        return serializePurchaseOrder(
          await removePurchaseOrderLine(ctx.db, input.purchaseOrderId, input.lineId)
        );
      })
    ),

  // ── Purchase orders — lifecycle transitions ──────────────────────────────────────
  submitPurchaseOrder: writeProcedure
    .input(z.object({ purchaseOrderId: ID }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => {
        await requirePurchaseOrderAccess(ctx, input.purchaseOrderId);
        annotateAudit(ctx, {
          targetType: 'RestaurantPurchaseOrder',
          targetId: input.purchaseOrderId,
        });
        return serializePurchaseOrder(await submitPurchaseOrder(ctx.db, input.purchaseOrderId));
      })
    ),

  approvePurchaseOrder: approveProcedure
    .input(z.object({ purchaseOrderId: ID }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => {
        const { actor } = await requirePurchaseOrderAccess(ctx, input.purchaseOrderId);
        const order = await approvePurchaseOrder(ctx.db, input.purchaseOrderId, {
          approvedByStaffProfileId: actor.staffProfileId,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantPurchaseOrder',
          targetId: input.purchaseOrderId,
          description: 'Approved purchase order',
        });
        return serializePurchaseOrder(order);
      })
    ),

  cancelPurchaseOrder: writeProcedure
    .input(z.object({ purchaseOrderId: ID }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => {
        await requirePurchaseOrderAccess(ctx, input.purchaseOrderId, { allowInactiveBranches: true });
        annotateAudit(ctx, {
          targetType: 'RestaurantPurchaseOrder',
          targetId: input.purchaseOrderId,
        });
        return serializePurchaseOrder(await cancelPurchaseOrder(ctx.db, input.purchaseOrderId));
      })
    ),

  closePurchaseOrder: writeProcedure
    .input(z.object({ purchaseOrderId: ID }).strict())
    .mutation(({ ctx, input }) =>
      run(async () => {
        await requirePurchaseOrderAccess(ctx, input.purchaseOrderId, { allowInactiveBranches: true });
        annotateAudit(ctx, {
          targetType: 'RestaurantPurchaseOrder',
          targetId: input.purchaseOrderId,
        });
        return serializePurchaseOrder(await closePurchaseOrder(ctx.db, input.purchaseOrderId));
      })
    ),

  // ── Receiving & returns ──────────────────────────────────────────────────────────
  receivePurchaseOrder: writeProcedure
    .input(
      z
        .object({
          purchaseOrderId: ID,
          locationId: ID.optional(),
          reference: z.string().max(200).optional(),
          receivedAt: z.date().optional(),
          idempotencyKey: ID.optional(),
          lines: z.array(RECEIVE_LINE_INPUT).min(1),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      run(async () => {
        const scope = await requirePurchaseOrderAccess(ctx, input.purchaseOrderId);
        const { actor } = scope;
        const locationId = input.locationId ?? scope.locationId;
        if (locationId) await requireLocationInBranch(ctx, locationId, scope.branchId);
        const result = await receivePurchaseOrder(ctx.db, {
          purchaseOrderId: input.purchaseOrderId,
          locationId: input.locationId,
          reference: input.reference,
          receivedAt: input.receivedAt,
          actor: {
            staffProfileId: actor.staffProfileId,
            idempotencyKey: input.idempotencyKey,
          },
          lines: input.lines.map((line) => ({
            purchaseOrderLineId: line.purchaseOrderLineId,
            receivedQuantity: line.receivedQuantity,
            unitId: line.unitId,
            unitCost: line.unitCost,
            batch: line.batch
              ? { code: line.batch.code, expiryDate: parseDateOnly(line.batch.expiryDate) }
              : undefined,
            discrepancies: line.discrepancies,
          })),
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantPurchaseOrder',
          targetId: input.purchaseOrderId,
          description: 'Received goods against purchase order',
        });
        return serializeReceiveResult(result);
      })
    ),

  createSupplierReturn: writeProcedure
    .input(
      z
        .object({
          locationId: ID,
          reference: z.string().max(200).optional(),
          occurredAt: z.date().optional(),
          idempotencyKey: ID.optional(),
          lines: z.array(RETURN_LINE_INPUT).min(1),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      run(async () => {
        const location = await ctx.db.restaurantStockLocation.findUnique({
          where: { id: input.locationId },
          select: { branchId: true },
        });
        if (!location) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock location not found.' });
        }
        const actor = await resolveRestaurantActor(ctx, [location.branchId]);
        const result = await createSupplierReturn(ctx.db, {
          locationId: input.locationId,
          reference: input.reference,
          occurredAt: input.occurredAt,
          actor: {
            staffProfileId: actor.staffProfileId,
            idempotencyKey: input.idempotencyKey,
          },
          lines: input.lines,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantStockLocation',
          targetId: input.locationId,
          description: 'Recorded supplier return',
        });
        return {
          replayed: result.replayed,
          movements: result.movements.map(serializeMovement),
        };
      })
    ),
});

// ── Error mapping ─────────────────────────────────────────────────────────────────

/** Run a domain call, translating `PurchasingError` to a tRPC status. */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof PurchasingError) {
      throw new TRPCError({
        code: err.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST',
        message: err.message,
      });
    }
    throw err;
  }
}

// ── Serialization (Decimal → string, C4/D07) ────────────────────────────────────

function parseDateOnly(value: string | undefined): Date | undefined {
  return value ? new Date(`${value}T00:00:00.000Z`) : undefined;
}

const dec = (value: Prisma.Decimal): string => value.toString();
const decOrNull = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toString();

type OrderSummary = Awaited<ReturnType<typeof listPurchaseOrders>>['orders'][number];
function serializeOrderSummary(order: OrderSummary) {
  return order; // no Decimal fields on the summary
}

type PurchaseOrder = Awaited<ReturnType<typeof getPurchaseOrder>>;
function serializePurchaseOrder(order: PurchaseOrder) {
  return {
    ...order,
    lines: order.lines.map((line) => ({
      ...line,
      orderedQuantity: dec(line.orderedQuantity),
      unitCost: dec(line.unitCost),
      orderedQuantityCanonical: dec(line.orderedQuantityCanonical),
      receivedQuantityCanonical: dec(line.receivedQuantityCanonical),
    })),
  };
}

type PurchaseReceipt = Awaited<ReturnType<typeof getPurchaseReceipt>>;
function serializeReceipt(receipt: PurchaseReceipt) {
  return {
    ...receipt,
    lines: receipt.lines.map((line) => ({
      ...line,
      receivedQuantity: dec(line.receivedQuantity),
      unitCost: dec(line.unitCost),
    })),
    discrepancies: receipt.discrepancies.map((discrepancy) => ({
      ...discrepancy,
      expectedQuantity: dec(discrepancy.expectedQuantity),
      receivedQuantity: dec(discrepancy.receivedQuantity),
    })),
  };
}

type ReceiveResult = Awaited<ReturnType<typeof receivePurchaseOrder>>;
function serializeReceiveResult(result: ReceiveResult) {
  return {
    receiptId: result.receiptId,
    purchaseOrderId: result.purchaseOrderId,
    purchaseOrderStatus: result.purchaseOrderStatus,
    discrepancyIds: result.discrepancyIds,
    replayed: result.replayed,
    movements: result.movements.map(serializeMovement),
  };
}

function serializeMovement(movement: {
  id: string;
  stockItemId: string;
  locationId: string;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
  batchId: string | null;
}) {
  return {
    id: movement.id,
    stockItemId: movement.stockItemId,
    locationId: movement.locationId,
    quantity: dec(movement.quantity),
    unitCost: decOrNull(movement.unitCost),
    batchId: movement.batchId,
  };
}
