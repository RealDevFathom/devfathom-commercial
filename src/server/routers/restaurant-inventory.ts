import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import { router, capabilityProcedure } from '../trpc';
import type { TRPCContext } from '../trpc';
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

const ACTOR_DENIED = new TRPCError({
  code: 'FORBIDDEN',
  message: 'Your account is not linked to an active staff profile authorized for this branch.',
});

async function resolveInventoryActor(ctx: TRPCContext, branchIds: string[]) {
  const user = ctx.session?.user;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });

  const actor = await ctx.db.restaurantStaffProfile.findFirst({
    where: { userId: user.id, status: 'ACTIVE' },
    select: { id: true, primaryBranchId: true },
  });
  if (!actor) throw ACTOR_DENIED;

  const requiredBranchIds = [...new Set(branchIds)];
  const assigned = await ctx.db.restaurantBranchAssignment.findMany({
    where: { userId: user.id, branchId: { in: requiredBranchIds } },
    select: { branchId: true },
  });
  const authorizedBranchIds = new Set(assigned.map(({ branchId }) => branchId));
  if (actor.primaryBranchId) authorizedBranchIds.add(actor.primaryBranchId);

  if (requiredBranchIds.every((branchId) => authorizedBranchIds.has(branchId))) {
    return { staffProfileId: actor.id };
  }

  const configuresAllBranches = await can(
    subjectFromSession(user),
    'restaurant:configure',
    undefined,
    { db: ctx.db, source: 'TRPC', ip: ctx.requestMeta.ip }
  );
  if (!configuresAllBranches) throw ACTOR_DENIED;
  return { staffProfileId: actor.id };
}

async function requireLocationBranch(ctx: TRPCContext, locationId: string): Promise<string> {
  const location = await ctx.db.restaurantStockLocation.findUnique({
    where: { id: locationId },
    select: { branchId: true },
  });
  if (!location) throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock location not found.' });
  return location.branchId;
}

async function requireCountBranch(ctx: TRPCContext, stockCountId: string): Promise<string> {
  const count = await ctx.db.restaurantStockCount.findUnique({
    where: { id: stockCountId },
    select: { location: { select: { branchId: true } } },
  });
  if (!count) throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock count not found.' });
  return count.location.branchId;
}

async function requireTransferBranches(ctx: TRPCContext, stockTransferId: string) {
  const transfer = await ctx.db.restaurantStockTransfer.findUnique({
    where: { id: stockTransferId },
    select: {
      sourceLocation: { select: { branchId: true } },
      destinationLocation: { select: { branchId: true } },
    },
  });
  if (!transfer) throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock transfer not found.' });
  return [transfer.sourceLocation.branchId, transfer.destinationLocation.branchId];
}

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
      const actor = await resolveInventoryActor(ctx, [
        await requireLocationBranch(ctx, input.locationId),
      ]);
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
      const actor = await resolveInventoryActor(ctx, [
        await requireCountBranch(ctx, input.stockCountId),
      ]);
      return submitStockCount(ctx.db, { stockCountId: input.stockCountId, actor }).catch(
        mapInventoryError
      );
    }),

  postStockCount: countProc
    .input(z.object({ stockCountId: ID }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveInventoryActor(ctx, [
        await requireCountBranch(ctx, input.stockCountId),
      ]);
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
      const actor = await resolveInventoryActor(ctx, [
        await requireLocationBranch(ctx, input.sourceLocationId),
        await requireLocationBranch(ctx, input.destinationLocationId),
      ]);
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
      const actor = await resolveInventoryActor(
        ctx,
        await requireTransferBranches(ctx, input.stockTransferId)
      );
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
      const actor = await resolveInventoryActor(ctx, [
        await requireLocationBranch(ctx, input.locationId),
      ]);
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
      const actor = await resolveInventoryActor(ctx, [
        await requireLocationBranch(ctx, input.locationId),
      ]);
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
