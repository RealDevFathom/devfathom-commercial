import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { Prisma } from '@/generated/prisma/client';
import { router, capabilityProcedure } from '../trpc';
import type { TRPCContext } from '../trpc';
import { resolveRestaurantActor, resolveRestaurantReadBranchIds } from '../restaurant-actor';
import {
  InventoryError,
  createStockItem,
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
import { INVENTORY_STOCK_LOCATIONS_LIMIT, resolveEntitlementLimit } from '@/lib/entitlement-limits';

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
const DECIMAL_QTY = /^(?:0|\d+(?:\.\d+)?|\.\d+)$/;
const NON_NEGATIVE_QTY = z.string().regex(DECIMAL_QTY, 'Quantity must be a non-negative decimal.');
const POSITIVE_QTY = NON_NEGATIVE_QTY.refine((value) => new Prisma.Decimal(value).greaterThan(0), {
  message: 'Quantity must be greater than zero.',
});
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

function stockLocationLimit(limits: Record<string, number>): number {
  const resolution = resolveEntitlementLimit(limits, INVENTORY_STOCK_LOCATIONS_LIMIT);
  if (resolution.status === 'missing') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The stock location entitlement is not configured correctly.',
    });
  }
  return resolution.value;
}

async function lockStockLocationCeiling(
  tx: { $queryRaw: (query: Prisma.Sql) => Promise<unknown> },
  organizationId: string
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory-stock-locations:${organizationId}`}, 0))`
  );
}

function requireOrganizationId(ctx: TRPCContext): string {
  const organizationId = ctx.session?.user?.organizationId;
  if (!organizationId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace access is required.' });
  }
  return organizationId;
}

function assertBelowStockLocationLimit(activeCount: number, limit: number) {
  if (activeCount >= limit) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `Your plan supports ${limit} active stock location${limit === 1 ? '' : 's'}.`,
    });
  }
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

async function requireLowStockRuleBranch(ctx: TRPCContext, ruleId: string): Promise<string> {
  const rule = await ctx.db.restaurantLowStockRule.findUnique({
    where: { id: ruleId },
    select: { location: { select: { branchId: true } } },
  });
  if (!rule) throw new TRPCError({ code: 'NOT_FOUND', message: 'Low-stock rule not found.' });
  return rule.location.branchId;
}

function mapInventoryError(err: unknown): never {
  if (err instanceof InventoryError || err instanceof StockLedgerError) {
    const code =
      err instanceof InventoryError && err.reason === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : err instanceof InventoryError && err.reason === 'STOCK_ITEM_EXISTS'
          ? 'CONFLICT'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

export const restaurantInventoryRouter = router({
  createStockItem: adjustProc
    .input(
      z
        .object({
          ingredientId: ID,
          canonicalUnitId: ID,
          trackBatches: z.boolean().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await resolveRestaurantActor(ctx, []);
      return createStockItem(ctx.db, input).catch(mapInventoryError);
    }),

  createStockLocation: adjustProc
    .input(
      z
        .object({
          branchId: ID,
          name: z.string().trim().min(1).max(120),
          code: z.string().trim().min(1).max(40).nullable().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = requireOrganizationId(ctx);
      const limit = stockLocationLimit(ctx.entitlements.limits as Record<string, number>);
      const branch = await ctx.db.restaurantBranch.findFirst({
        where: { id: input.branchId, organizationId, active: true },
        select: { id: true },
      });
      if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
      await resolveRestaurantActor(ctx, [branch.id]);

      return ctx.db.$transaction(async (tx) => {
        await lockStockLocationCeiling(tx, organizationId);
        const activeCount = await tx.restaurantStockLocation.count({ where: { isActive: true } });
        assertBelowStockLocationLimit(activeCount, limit);
        return tx.restaurantStockLocation.create({
          data: {
            branchId: branch.id,
            name: input.name,
            code: input.code ?? null,
            isActive: true,
          },
        });
      });
    }),

  setStockLocationActive: adjustProc
    .input(z.object({ id: ID, isActive: z.boolean() }).strict())
    .mutation(async ({ ctx, input }) => {
      const organizationId = requireOrganizationId(ctx);
      const location = await ctx.db.restaurantStockLocation.findUnique({
        where: { id: input.id },
        select: { id: true, branchId: true, isActive: true },
      });
      if (!location) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock location not found.' });
      }
      await resolveRestaurantActor(ctx, [location.branchId]);

      return ctx.db.$transaction(async (tx) => {
        await lockStockLocationCeiling(tx, organizationId);
        const current = await tx.restaurantStockLocation.findUnique({
          where: { id: location.id },
          select: { id: true, isActive: true },
        });
        if (!current) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock location not found.' });
        }
        if (input.isActive && !current.isActive) {
          const limit = stockLocationLimit(ctx.entitlements.limits as Record<string, number>);
          const activeCount = await tx.restaurantStockLocation.count({ where: { isActive: true } });
          assertBelowStockLocationLimit(activeCount, limit);
        }
        if (current.isActive === input.isActive) return current;
        return tx.restaurantStockLocation.update({
          where: { id: current.id },
          data: { isActive: input.isActive },
        });
      });
    }),

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
      const branchIds = await resolveRestaurantReadBranchIds(ctx);
      const rows = await listStockOnHand(ctx.db, { ...input, branchIds }).catch(mapInventoryError);
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
      const branchIds = await resolveRestaurantReadBranchIds(ctx);
      const result = await listStockMovements(ctx.db, { ...input, branchIds }).catch(
        mapInventoryError
      );
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
      const actor = await resolveRestaurantActor(ctx, [
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
          countedQuantity: NON_NEGATIVE_QTY,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await resolveRestaurantActor(ctx, [await requireCountBranch(ctx, input.stockCountId)]);
      return addStockCountLine(ctx.db, input).catch(mapInventoryError);
    }),

  submitStockCount: countProc
    .input(z.object({ stockCountId: ID }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveRestaurantActor(ctx, [
        await requireCountBranch(ctx, input.stockCountId),
      ]);
      return submitStockCount(ctx.db, { stockCountId: input.stockCountId, actor }).catch(
        mapInventoryError
      );
    }),

  postStockCount: countProc
    .input(z.object({ stockCountId: ID }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveRestaurantActor(ctx, [
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
      const branchIds = await resolveRestaurantReadBranchIds(ctx);
      const result = await listStockCounts(ctx.db, { ...input, branchIds }).catch(
        mapInventoryError
      );
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
      const actor = await resolveRestaurantActor(ctx, [
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
          quantity: POSITIVE_QTY,
          unitId: ID.optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await resolveRestaurantActor(ctx, await requireTransferBranches(ctx, input.stockTransferId));
      return addStockTransferLine(ctx.db, input).catch(mapInventoryError);
    }),

  completeStockTransfer: adjustProc
    .input(z.object({ stockTransferId: ID }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveRestaurantActor(
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
      const branchIds = await resolveRestaurantReadBranchIds(ctx);
      const result = await listStockTransfers(ctx.db, { ...input, branchIds }).catch(
        mapInventoryError
      );
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
          quantity: POSITIVE_QTY,
          unitId: ID.optional(),
          occurredAt: z.date().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveRestaurantActor(ctx, [
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
          quantity: POSITIVE_QTY,
          unitId: ID.optional(),
          orderId: ID.optional(),
          occurredAt: z.date().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveRestaurantActor(ctx, [
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
          threshold: NON_NEGATIVE_QTY,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await resolveRestaurantActor(ctx, [await requireLocationBranch(ctx, input.locationId)]);
      const rule = await createLowStockRule(ctx.db, input).catch(mapInventoryError);
      return { ...rule, threshold: qty(rule.threshold) };
    }),

  updateLowStockRule: adjustProc
    .input(
      z
        .object({
          id: ID,
          threshold: NON_NEGATIVE_QTY,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await resolveRestaurantActor(ctx, [await requireLowStockRuleBranch(ctx, input.id)]);
      const rule = await updateLowStockRule(ctx.db, input.id, { threshold: input.threshold }).catch(
        mapInventoryError
      );
      return { ...rule, threshold: qty(rule.threshold) };
    }),

  deleteLowStockRule: adjustProc
    .input(z.object({ id: ID }).strict())
    .mutation(async ({ ctx, input }) => {
      await resolveRestaurantActor(ctx, [await requireLowStockRuleBranch(ctx, input.id)]);
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
      const branchIds = await resolveRestaurantReadBranchIds(ctx);
      const flags = await evaluateLowStockRules(ctx.db, { ...input, branchIds }).catch(
        mapInventoryError
      );
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
      const branchIds = await resolveRestaurantReadBranchIds(ctx);
      const result = await listStockBatches(ctx.db, { ...input, branchIds }).catch(
        mapInventoryError
      );
      return { items: result.items, nextCursor: result.nextCursor };
    }),
});
