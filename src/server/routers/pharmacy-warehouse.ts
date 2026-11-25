import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { BranchTransferPolicyError } from '@/lib/pharmacy/branch-transfer-policy';
import { PharmacyInventoryError } from '@/lib/pharmacy/inventory';
import { actorCanProcure, actorIsPharmacyOwner } from '@/lib/pharmacy/procurement-access';
import type { LedgerScope } from '@/lib/pharmacy/stock-ledger';
import { warehouseBoard } from '@/lib/pharmacy/warehouse-board';
import {
  completeWarehousePutAway,
  listWarehousePutAwayTasks,
} from '@/lib/pharmacy/warehouse-inbound';
import {
  adoptWarehouseTransfer,
  cancelWarehouseOutbound,
  listWarehouseOutbound,
  packWarehouseLine,
  pickWarehouseLine,
  replenishWarehouseOutbound,
} from '@/lib/pharmacy/warehouse-outbound';
import {
  recordWarehouseDispatchEvidence,
  listWarehouseQuality,
  reviewWarehouseQuality,
  setWarehouseProductTemperatures,
  warehouseRecallTrace,
} from '@/lib/pharmacy/warehouse-quality';
import {
  fulfillWarehouseRequest,
  listWarehouseRequests,
  purchaseWarehouseRequest,
  submitWarehouseRequest,
  withdrawWarehouseRequest,
} from '@/lib/pharmacy/warehouse-requests';
import { configureWarehouseSite } from '@/lib/pharmacy/warehouse-site';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { assertProcurementBranch } from '../pharmacy-procurement-scope';
import { assertModuleLicensed, capabilityProcedure, router, type TRPCContext } from '../trpc';
import { admittedInventoryBranchIds, admittedScopeFor } from './pharmacy-inventory';

const inventory = capabilityProcedure('pharmacy:inventory');
const safety = capabilityProcedure('pharmacy:safety');
const procurement = capabilityProcedure('pharmacy:procurement');
const id = z.string().trim().min(1).max(200);
const key = z.string().trim().min(1).max(128);
const scan = z.string().trim().min(1).max(512);
const units = z.number().int().positive().max(2147483647);
const site = z.object({ branchId: id }).strict();
const outboundScan = site.extend({
  reservationId: id,
  productScan: scan,
  lotScan: scan,
  stagingBinScan: scan,
  quantityUnits: units,
  idempotencyKey: key,
});

async function mutate<T>(
  ctx: TRPCContext,
  branchId: string,
  action: (db: ScopedDb, scope: LedgerScope) => Promise<T>
) {
  const scope = await admittedScopeFor(ctx, branchId);
  try {
    return await ctx.db.$transaction((tx) => action(tx as unknown as ScopedDb, scope));
  } catch (error) {
    if (error instanceof PharmacyInventoryError)
      throw new TRPCError({
        code:
          error.reason === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : error.reason === 'IDEMPOTENCY_CONFLICT'
              ? 'CONFLICT'
              : ['BLOCKED_STOCK', 'CROSS_TENANT_REFERENCE', 'CROSS_BRANCH_REFERENCE'].includes(
                    error.reason
                  )
                ? 'FORBIDDEN'
                : 'BAD_REQUEST',
        message: error.userMessage ?? error.reason,
      });
    if (error instanceof BranchTransferPolicyError)
      throw new TRPCError({ code: 'FORBIDDEN', message: error.reason });
    throw error;
  }
}

export const pharmacyWarehouseRouter = router({
  sites: inventory.query(async ({ ctx }) => {
    const branchIds = await admittedInventoryBranchIds(ctx);
    return ctx.db.pharmacyBranch.findMany({
      where: {
        organizationId: ctx.entitlements.organizationId,
        id: { in: [...branchIds] },
        active: true,
      },
      select: { id: true, name: true, warehouseEnabled: true, warehouseMinimumShelfLifeDays: true },
      orderBy: { name: 'asc' },
    });
  }),
  setup: inventory.input(site).query(async ({ ctx, input }) => {
    const scope = await admittedScopeFor(ctx, input.branchId);
    const { organizationId, branchId, actorId } = scope;
    const [branch, locations, warehouses, canConfigure, canReview, canPurchase] = await Promise.all(
      [
        ctx.db.pharmacyBranch.findUniqueOrThrow({
          where: { id: branchId },
          select: { warehouseEnabled: true, warehouseMinimumShelfLifeDays: true },
        }),
        ctx.db.pharmacyStockLocation.findMany({
          where: { organizationId, branchId, active: true },
          select: {
            id: true,
            code: true,
            name: true,
            kind: true,
            coldChain: true,
            warehouseStaging: true,
          },
          orderBy: { code: 'asc' },
        }),
        ctx.db.pharmacyBranch.findMany({
          where: { organizationId, active: true, warehouseEnabled: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        actorIsPharmacyOwner(ctx.db, organizationId, actorId),
        can(subjectFromSession(ctx.session.user), 'pharmacy:safety', undefined, { db: ctx.db }),
        actorCanProcure(ctx.db, actorId),
      ]
    );
    return {
      canConfigure,
      canReview,
      canPurchase: canPurchase && hasModule(ctx.entitlements, 'pharmacy-procurement'),
      enabled: branch.warehouseEnabled,
      minimumShelfLifeDays: branch.warehouseMinimumShelfLifeDays,
      locations,
      warehouses,
    };
  }),
  configure: inventory
    .input(
      site.extend({
        enabled: z.boolean(),
        minimumShelfLifeDays: z.number().int().min(0).max(36500),
        stagingLocationIds: z.array(id).max(500),
      })
    )
    .mutation(({ ctx, input }) =>
      mutate(ctx, input.branchId, (db, scope) => configureWarehouseSite(db, scope, input))
    ),
  searchMedicines: inventory
    .input(site.extend({ query: z.string().trim().min(1).max(150) }))
    .query(async ({ ctx, input }) => {
      const scope = await admittedScopeFor(ctx, input.branchId);
      return ctx.db.medicine.findMany({
        where: {
          organizationId: scope.organizationId,
          saleable: true,
          OR: [
            { id: input.query },
            { productName: { contains: input.query, mode: 'insensitive' } },
            { presentations: { some: { barcodes: { some: { code: input.query } } } } },
          ],
        },
        select: {
          id: true,
          productName: true,
          controlled: true,
          coldChain: true,
          minimumStorageTemperatureC: true,
          maximumStorageTemperatureC: true,
        },
        orderBy: [{ productName: 'asc' }, { id: 'asc' }],
        take: 40,
      });
    }),
  requestQueue: inventory
    .input(site)
    .query(async ({ ctx, input }) =>
      listWarehouseRequests(ctx.db, await admittedScopeFor(ctx, input.branchId))
    ),
  submitRequest: inventory
    .input(
      site.extend({
        warehouseBranchId: id,
        medicineId: id,
        destinationStockLocationId: id,
        requestedUnits: units,
        signalId: id.optional(),
        idempotencyKey: key,
      })
    )
    .mutation(({ ctx, input }) =>
      mutate(ctx, input.branchId, (db, scope) => submitWarehouseRequest(db, scope, input))
    ),
  withdrawRequest: inventory
    .input(site.extend({ requestId: id }))
    .mutation(({ ctx, input }) =>
      mutate(ctx, input.branchId, (db, scope) =>
        withdrawWarehouseRequest(db, scope, input.requestId)
      )
    ),
  fulfillRequest: inventory
    .input(site.extend({ requestId: id }))
    .mutation(({ ctx, input }) =>
      mutate(ctx, input.branchId, (db, scope) =>
        fulfillWarehouseRequest(db, scope, input.requestId)
      )
    ),
  purchaseRequest: procurement
    .input(site.extend({ requestId: id }))
    .mutation(async ({ ctx, input }) => {
      assertModuleLicensed(ctx, 'pharmacy-procurement');
      await assertProcurementBranch(ctx, input.branchId);
      return mutate(ctx, input.branchId, (db, scope) =>
        purchaseWarehouseRequest(db, scope, input.requestId)
      );
    }),
  putAwayTasks: inventory
    .input(site)
    .query(async ({ ctx, input }) =>
      listWarehousePutAwayTasks(ctx.db, await admittedScopeFor(ctx, input.branchId))
    ),
  completePutAway: inventory
    .input(
      site.extend({
        taskId: id,
        productScan: scan,
        batchScan: scan,
        destinationCode: scan,
        quantityUnits: units,
      })
    )
    .mutation(({ ctx, input }) =>
      mutate(ctx, input.branchId, (db, scope) => completeWarehousePutAway(db, scope, input))
    ),
  outbound: inventory
    .input(site)
    .query(async ({ ctx, input }) =>
      listWarehouseOutbound(ctx.db, await admittedScopeFor(ctx, input.branchId))
    ),
  pick: inventory
    .input(outboundScan.extend({ sourceBinScan: scan }))
    .mutation(({ ctx, input }) =>
      mutate(ctx, input.branchId, (db, scope) => pickWarehouseLine(db, scope, input))
    ),
  pack: inventory
    .input(outboundScan)
    .mutation(({ ctx, input }) =>
      mutate(ctx, input.branchId, (db, scope) => packWarehouseLine(db, scope, input))
    ),
  cancel: inventory
    .input(
      site.extend({ orderId: id, reason: z.string().trim().min(1).max(500), idempotencyKey: key })
    )
    .mutation(({ ctx, input }) =>
      mutate(ctx, input.branchId, (db, scope) => cancelWarehouseOutbound(db, scope, input))
    ),
  replenish: inventory
    .input(site.extend({ orderId: id, idempotencyKey: key }))
    .mutation(({ ctx, input }) =>
      mutate(ctx, input.branchId, (db, scope) => replenishWarehouseOutbound(db, scope, input))
    ),
  adoptTransfer: inventory
    .input(site.extend({ transferId: id, idempotencyKey: key }))
    .mutation(({ ctx, input }) =>
      mutate(ctx, input.branchId, (db, scope) => adoptWarehouseTransfer(db, scope, input))
    ),
  overview: inventory
    .input(site)
    .query(async ({ ctx, input }) =>
      warehouseBoard(ctx.db, await admittedScopeFor(ctx, input.branchId))
    ),
  dispatchEvidence: inventory
    .input(
      site.extend({
        transferId: id,
        minimumC: z.number().finite().nullable(),
        maximumC: z.number().finite().nullable(),
        evidenceRef: scan,
        requestKey: key,
      })
    )
    .mutation(({ ctx, input }) =>
      mutate(ctx, input.branchId, (db, scope) => recordWarehouseDispatchEvidence(db, scope, input))
    ),
  quality: inventory
    .input(site)
    .query(async ({ ctx, input }) =>
      listWarehouseQuality(ctx.db, await admittedScopeFor(ctx, input.branchId))
    ),
  reviewQuality: safety
    .input(
      site.extend({
        incidentId: id,
        destinationBinCode: scan.optional(),
        decision: z.enum(['RELEASE', 'RETURN', 'DISPOSE']),
        evidenceRef: scan,
        reason: z.string().trim().min(1).max(500),
      })
    )
    .mutation(({ ctx, input }) =>
      mutate(ctx, input.branchId, (db, scope) => reviewWarehouseQuality(db, scope, input))
    ),
  setProductTemperatures: safety
    .input(
      site.extend({ medicineId: id, minimumC: z.number().finite(), maximumC: z.number().finite() })
    )
    .mutation(({ ctx, input }) =>
      mutate(ctx, input.branchId, (db, scope) => setWarehouseProductTemperatures(db, scope, input))
    ),
  recallTrace: safety.input(site.extend({ noticeId: id })).query(async ({ ctx, input }) => {
    const scope = await admittedScopeFor(ctx, input.branchId);
    const allowed = await admittedInventoryBranchIds(ctx);
    return warehouseRecallTrace(ctx.db, scope.organizationId, input.noticeId, [...allowed]);
  }),
});
