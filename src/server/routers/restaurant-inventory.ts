import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { Prisma } from '@/generated/prisma/client';
import { router, capabilityProcedure } from '../trpc';
import {
  InventoryError,
  createStockCount,
  addStockCountLine,
  submitStockCount,
  postStockCount,
  createStockTransfer,
  addStockTransferLine,
  completeStockTransfer,
  postWastage,
  postSaleReversal,
  createLowStockRule,
  updateLowStockRule,
  deleteLowStockRule,
  evaluateLowStockRules,
  listStockOnHand,
  listStockMovements,
  listStockCounts,
  listStockTransfers,
  listStockBatches,
} from '@/lib/restaurant/inventory';
import { StockLedgerError } from '@/lib/restaurant/inventory-ledger';

/**
 * M6-L2 — inventory operations console router.
 *
 * All procedures are org-role-driven through the ABAC engine's `customDecision`
 * path. Four capability gates:
 *   - `inventory:read`   — stock on hand, ledger, counts, transfers, batches,
 *                          low-stock rules
 *   - `inventory:count`  — physical count lifecycle (create/addLine/submit/post)
 *   - `inventory:adjust` — transfers, sale reversals, low-stock rule CRUD
 *   - `inventory:waste`  — wastage / spoilage / staff-meal movements
 *
 * Quantities and costs cross the tRPC boundary as strings (Decimal round-trip
 * safety; same contract as M5 money router). Inputs are `.strict()` (house style).
 */

const ID = z.string().min(1);
const QTY = z.string().min(1); // Decimal string — caller must pass a valid number string
const WASTAGE_REASON = z.enum(['WASTAGE', 'SPOILAGE', 'STAFF_MEAL']);
const COUNT_STATUS = z.enum(['DRAFT', 'SUBMITTED', 'POSTED']);
const TRANSFER_STATUS = z.enum(['DRAFT', 'DISPATCHED', 'RECEIVED', 'CANCELLED']);
const MOVEMENT_REASON = z.enum([
  'PURCHASE_RECEIPT',
  'RECIPE_CONSUMPTION',
  'SALE_REVERSAL',
  'TRANSFER',
  'PHYSICAL_COUNT_ADJUSTMENT',
  'WASTAGE',
  'SPOILAGE',
  'STAFF_MEAL',
  'SUPPLIER_RETURN',
  'MANUAL_CORRECTION',
]);

const qty = (v: Prisma.Decimal): string => v.toString();
const qtyOrNull = (v: Prisma.Decimal | null): string | null => (v === null ? null : v.toString());

const readProc = capabilityProcedure('inventory:read');
const countProc = capabilityProcedure('inventory:count');
const adjustProc = capabilityProcedure('inventory:adjust');
const wasteProc = capabilityProcedure('inventory:waste');

function mapInventoryError(err: unknown): never {
  if (err instanceof InventoryError || err instanceof StockLedgerError) {
    const code =
      err instanceof InventoryError && err.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

export const restaurantInventoryRouter = router({
  // ── Stock on hand ─────────────────────────────────────────────────────────────

  listStockOnHand: readProc
    .input(
      z
        .object({
          branchId: ID.optional(),
          locationId: ID.optional(),
          stockItemId: ID.optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const rows = await listStockOnHand(ctx.db, input).catch(mapInventoryError);
      return rows.map((r) => ({
        stockItemId: r.stockItemId,
        ingredientName: r.ingredientName,
        locationId: r.locationId,
        locationName: r.locationName,
        onHand: qty(r.onHand),
        isNegative: r.isNegative,
        weightedAverageCost: r.weightedAverageCost == null ? null : qty(r.weightedAverageCost),
      }));
    }),

  // ── Ledger browse ─────────────────────────────────────────────────────────────

  listStockMovements: readProc
    .input(
      z
        .object({
          stockItemId: ID.optional(),
          locationId: ID.optional(),
          reason: MOVEMENT_REASON.optional(),
          from: z.date().optional(),
          to: z.date().optional(),
          cursor: ID.optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const result = await listStockMovements(ctx.db, input).catch(mapInventoryError);
      return {
        items: result.items.map((m) => ({
          ...m,
          quantity: qty(m.quantity),
          unitCost: qtyOrNull(m.unitCost),
        })),
        nextCursor: result.nextCursor,
      };
    }),

  // ── Physical counts ───────────────────────────────────────────────────────────

  createStockCount: countProc
    .input(
      z
        .object({
          locationId: ID,
          reference: z.string().optional(),
          countedAt: z.date().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = { staffProfileId: ctx.session.user.id };
      return createStockCount(ctx.db, { ...input, actor }).catch(mapInventoryError);
    }),

  addStockCountLine: countProc
    .input(
      z
        .object({
          stockCountId: ID,
          stockItemId: ID,
          countedQuantity: QTY,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      return addStockCountLine(ctx.db, input).catch(mapInventoryError);
    }),

  submitStockCount: countProc
    .input(z.object({ stockCountId: ID }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = { staffProfileId: ctx.session.user.id };
      return submitStockCount(ctx.db, { stockCountId: input.stockCountId, actor }).catch(
        mapInventoryError
      );
    }),

  postStockCount: countProc
    .input(z.object({ stockCountId: ID }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = { staffProfileId: ctx.session.user.id };
      return postStockCount(ctx.db, { stockCountId: input.stockCountId, actor }).catch(
        mapInventoryError
      );
    }),

  listStockCounts: readProc
    .input(
      z
        .object({
          locationId: ID.optional(),
          status: COUNT_STATUS.optional(),
          cursor: ID.optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const result = await listStockCounts(ctx.db, input).catch(mapInventoryError);
      return { items: result.items, nextCursor: result.nextCursor };
    }),

  // ── Stock transfers ───────────────────────────────────────────────────────────

  createStockTransfer: adjustProc
    .input(
      z
        .object({
          sourceLocationId: ID,
          destinationLocationId: ID,
          reference: z.string().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = { staffProfileId: ctx.session.user.id };
      return createStockTransfer(ctx.db, { ...input, actor }).catch(mapInventoryError);
    }),

  addStockTransferLine: adjustProc
    .input(
      z
        .object({
          stockTransferId: ID,
          stockItemId: ID,
          quantity: QTY,
          unitId: ID.optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      return addStockTransferLine(ctx.db, input).catch(mapInventoryError);
    }),

  completeStockTransfer: adjustProc
    .input(z.object({ stockTransferId: ID }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = { staffProfileId: ctx.session.user.id };
      return completeStockTransfer(ctx.db, { stockTransferId: input.stockTransferId, actor }).catch(
        mapInventoryError
      );
    }),

  listStockTransfers: readProc
    .input(
      z
        .object({
          sourceLocationId: ID.optional(),
          destinationLocationId: ID.optional(),
          status: TRANSFER_STATUS.optional(),
          cursor: ID.optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const result = await listStockTransfers(ctx.db, input).catch(mapInventoryError);
      return { items: result.items, nextCursor: result.nextCursor };
    }),

  // ── Wastage / spoilage / staff-meal ──────────────────────────────────────────

  postWastage: wasteProc
    .input(
      z
        .object({
          stockItemId: ID,
          locationId: ID,
          reason: WASTAGE_REASON,
          quantity: QTY,
          unitId: ID.optional(),
          occurredAt: z.date().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = { staffProfileId: ctx.session.user.id };
      const movement = await postWastage(ctx.db, { ...input, actor }).catch(mapInventoryError);
      return { id: movement.id, quantity: qty(movement.quantity) };
    }),

  // ── Sale reversal ─────────────────────────────────────────────────────────────

  postSaleReversal: adjustProc
    .input(
      z
        .object({
          stockItemId: ID,
          locationId: ID,
          quantity: QTY,
          unitId: ID.optional(),
          orderId: ID.optional(),
          occurredAt: z.date().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = { staffProfileId: ctx.session.user.id };
      const movement = await postSaleReversal(ctx.db, { ...input, actor }).catch(mapInventoryError);
      return { id: movement.id, quantity: qty(movement.quantity) };
    }),

  // ── Low-stock rules ───────────────────────────────────────────────────────────

  createLowStockRule: adjustProc
    .input(
      z
        .object({
          stockItemId: ID,
          locationId: ID,
          threshold: QTY,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const rule = await createLowStockRule(ctx.db, input).catch(mapInventoryError);
      return { ...rule, threshold: qty(rule.threshold) };
    }),

  updateLowStockRule: adjustProc
    .input(
      z
        .object({
          id: ID,
          threshold: QTY,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const rule = await updateLowStockRule(ctx.db, input.id, { threshold: input.threshold }).catch(
        mapInventoryError
      );
      return { ...rule, threshold: qty(rule.threshold) };
    }),

  deleteLowStockRule: adjustProc
    .input(z.object({ id: ID }).strict())
    .mutation(async ({ ctx, input }) => {
      await deleteLowStockRule(ctx.db, input.id).catch(mapInventoryError);
      return { deleted: true };
    }),

  evaluateLowStockRules: readProc
    .input(
      z
        .object({
          locationId: ID.optional(),
          stockItemId: ID.optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const flags = await evaluateLowStockRules(ctx.db, input).catch(mapInventoryError);
      return flags.map((f) => ({
        ruleId: f.ruleId,
        stockItemId: f.stockItemId,
        locationId: f.locationId,
        threshold: qty(f.threshold),
        onHand: qty(f.onHand),
        isTriggered: f.isTriggered,
      }));
    }),

  // ── Stock batches (read-only) ─────────────────────────────────────────────────

  listStockBatches: readProc
    .input(
      z
        .object({
          stockItemId: ID.optional(),
          cursor: ID.optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const result = await listStockBatches(ctx.db, input).catch(mapInventoryError);
      return { items: result.items, nextCursor: result.nextCursor };
    }),
});
