import {
  addStockCountLine,
  createLowStockRule,
  createStockCount,
  evaluateLowStockRules,
  postStockCount,
  postWastage,
  submitStockCount,
} from '@/lib/restaurant/inventory';
import {
  approvePurchaseOrder,
  createPurchaseOrder,
  createSupplier,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from '@/lib/restaurant/purchasing';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';

import type { DemoRestaurantCatalogIds } from './seed-catalog';
import type { DemoRestaurantSeed } from './seed-data';
import type { DemoRestaurantOperationsIds } from './seed-operations';

export type DemoRestaurantInventoryIds = {
  supplier: Record<string, string>;
  purchaseOrder: Record<string, string>;
  purchaseReceipt: Record<string, string>;
  stockCount: Record<string, string>;
  stockMovement: Record<string, string>;
  lowStockRule: Record<string, string>;
  openPurchaseOrderId: string;
  counts: {
    suppliers: number;
    historicalPurchaseOrders: number;
    openPurchaseOrders: number;
    purchaseReceipts: number;
    purchaseReceiptMovements: number;
    stockCounts: number;
    stockCountLines: number;
    stockCountMovements: number;
    wastageMovements: number;
    lowStockRules: number;
  };
};

function requiredId(ids: Record<string, string>, key: string, label: string): string {
  const id = ids[key];
  if (!id) throw new Error(`Missing demo ${label} mapping for ${key}.`);
  return id;
}

const at = (value: string): Date => new Date(value);

export async function seedDemoRestaurantInventory(
  db: ScopedDb,
  seed: DemoRestaurantSeed,
  catalog: DemoRestaurantCatalogIds,
  context: TRPCContext,
  operations: DemoRestaurantOperationsIds
): Promise<DemoRestaurantInventoryIds> {
  void context;
  const ids: DemoRestaurantInventoryIds = {
    supplier: {},
    purchaseOrder: {},
    purchaseReceipt: {},
    stockCount: {},
    stockMovement: {},
    lowStockRule: {},
    openPurchaseOrderId: '',
    counts: {
      suppliers: 0,
      historicalPurchaseOrders: 0,
      openPurchaseOrders: 0,
      purchaseReceipts: 0,
      purchaseReceiptMovements: 0,
      stockCounts: 0,
      stockCountLines: 0,
      stockCountMovements: 0,
      wastageMovements: 0,
      lowStockRules: 0,
    },
  };

  for (const supplier of seed.purchasing.suppliers) {
    const created = await createSupplier(db, {
      name: supplier.name,
      code: supplier.key.toUpperCase(),
      contactEmail: supplier.email,
      contactPhone: supplier.phone,
    });
    ids.supplier[supplier.id] = created.id;
    ids.counts.suppliers += 1;
  }

  for (const order of seed.purchasing.purchaseOrders) {
    const orderedAt = at(order.orderedAt);
    const created = await createPurchaseOrder(db, {
      supplierId: requiredId(ids.supplier, order.supplierId, 'supplier'),
      branchId: requiredId(catalog.branch, order.branchId, 'branch'),
      locationId: requiredId(catalog.stockLocation, order.branchId, 'stock location'),
      reference: order.purchaseOrderNumber,
      expectedDate: at(order.expectedAt),
      createdByStaffProfileId: operations.managerStaffProfileId,
      now: orderedAt,
      lines: order.lines.map((line) => ({
        stockItemId: requiredId(catalog.stockItem, line.ingredientId, 'stock item'),
        orderedQuantity: line.quantity,
        unitId: requiredId(catalog.unit, line.baseUnit, 'unit'),
        unitCost: line.unitCostPkr,
      })),
    });
    ids.purchaseOrder[order.id] = created.id;
    ids.counts.historicalPurchaseOrders += 1;

    await submitPurchaseOrder(db, created.id, orderedAt);
    await approvePurchaseOrder(db, created.id, {
      approvedByStaffProfileId: operations.approverStaffProfileId,
      now: orderedAt,
    });

    const actualLineByStockItem = new Map(
      created.lines.map((line) => [line.stockItemId, line] as const)
    );
    for (const receipt of order.receipts) {
      const receivedAt = at(receipt.receivedAt);
      const received = await receivePurchaseOrder(db, {
        purchaseOrderId: created.id,
        locationId: requiredId(catalog.stockLocation, order.branchId, 'stock location'),
        reference: receipt.receiptNumber,
        receivedAt,
        now: receivedAt,
        actor: {
          staffProfileId: operations.managerStaffProfileId,
          idempotencyKey: `demo:${seed.identity.seatNumber}:receipt:${receipt.id}`,
        },
        lines: receipt.lines.map((line) => {
          const stockItemId = requiredId(catalog.stockItem, line.ingredientId, 'stock item');
          const actualLine = actualLineByStockItem.get(stockItemId);
          if (!actualLine)
            throw new Error(`Missing created purchase-order line for ${line.ingredientId}.`);
          return {
            purchaseOrderLineId: actualLine.id,
            receivedQuantity: line.quantity,
            unitId: requiredId(catalog.unit, line.baseUnit, 'unit'),
            unitCost: actualLine.unitCost,
          };
        }),
      });
      if (received.purchaseOrderStatus !== 'RECEIVED') {
        throw new Error(
          `Historical purchase order ${order.purchaseOrderNumber} did not reach RECEIVED.`
        );
      }
      ids.purchaseReceipt[receipt.id] = received.receiptId;
      ids.counts.purchaseReceipts += 1;
      ids.counts.purchaseReceiptMovements += received.movements.length;
    }
  }

  const tourSource = seed.purchasing.purchaseOrders.at(-1);
  if (!tourSource)
    throw new Error('Restaurant demo requires a purchase order for the receiving tour.');
  const tourCreated = await createPurchaseOrder(db, {
    supplierId: requiredId(ids.supplier, tourSource.supplierId, 'supplier'),
    branchId: requiredId(catalog.branch, tourSource.branchId, 'branch'),
    locationId: requiredId(catalog.stockLocation, tourSource.branchId, 'stock location'),
    reference: `KK-S${seed.identity.seatNumber}-PO-RECEIVING-TOUR`,
    expectedDate: new Date(at(seed.generatedAt).getTime() + 24 * 60 * 60 * 1_000),
    createdByStaffProfileId: operations.managerStaffProfileId,
    lines: tourSource.lines.slice(0, 3).map((line) => ({
      stockItemId: requiredId(catalog.stockItem, line.ingredientId, 'stock item'),
      orderedQuantity: line.quantity,
      unitId: requiredId(catalog.unit, line.baseUnit, 'unit'),
      unitCost: line.unitCostPkr,
    })),
  });
  await submitPurchaseOrder(db, tourCreated.id, at(seed.generatedAt));
  await approvePurchaseOrder(db, tourCreated.id, {
    approvedByStaffProfileId: operations.approverStaffProfileId,
    now: at(seed.generatedAt),
  });
  ids.purchaseOrder.receivingTour = tourCreated.id;
  ids.openPurchaseOrderId = tourCreated.id;
  ids.counts.openPurchaseOrders = 1;

  for (const movement of seed.inventory.stockMovements) {
    if (movement.kind === 'OPENING' || movement.kind === 'COUNT') continue;
    const posted = await postWastage(db, {
      stockItemId: requiredId(catalog.stockItem, movement.ingredientId, 'stock item'),
      locationId: requiredId(catalog.stockLocation, movement.branchId, 'stock location'),
      reason: movement.kind,
      quantity: Math.abs(movement.quantityDelta),
      unitId: requiredId(catalog.unit, movement.baseUnit, 'unit'),
      occurredAt: at(movement.occurredAt),
      now: at(movement.occurredAt),
      actor: {
        staffProfileId: operations.managerStaffProfileId,
        idempotencyKey: `demo:${seed.identity.seatNumber}:wastage:${movement.id}`,
      },
    });
    ids.stockMovement[movement.id] = posted.id;
    ids.counts.wastageMovements += 1;
  }

  return ids;
}

export async function reconcileDemoRestaurantInventory(
  db: ScopedDb,
  seed: DemoRestaurantSeed,
  catalog: DemoRestaurantCatalogIds,
  context: TRPCContext,
  operations: DemoRestaurantOperationsIds,
  inventoryIds: DemoRestaurantInventoryIds
): Promise<DemoRestaurantInventoryIds> {
  void context;
  const ids = inventoryIds;

  for (const count of seed.inventory.stockCounts) {
    const created = await createStockCount(db, {
      locationId: requiredId(catalog.stockLocation, count.branchId, 'stock location'),
      reference: `DEMO-${count.id}`,
      countedAt: at(count.countedAt),
      actor: { staffProfileId: operations.managerStaffProfileId },
    });
    ids.stockCount[count.id] = created.id;
    ids.counts.stockCounts += 1;

    for (const line of count.lines) {
      await addStockCountLine(db, {
        stockCountId: created.id,
        stockItemId: requiredId(catalog.stockItem, line.ingredientId, 'stock item'),
        countedQuantity: line.countedQuantity,
      });
      ids.counts.stockCountLines += 1;
    }
    await submitStockCount(db, {
      stockCountId: created.id,
      actor: { staffProfileId: operations.managerStaffProfileId },
    });
    const posted = await postStockCount(db, {
      stockCountId: created.id,
      now: at(count.countedAt),
      actor: {
        staffProfileId: operations.managerStaffProfileId,
        idempotencyKey: `demo:${seed.identity.seatNumber}:count:${count.id}`,
      },
    });
    ids.counts.stockCountMovements += posted.movementsPosted;
  }

  for (const rule of seed.inventory.lowStockRules) {
    const created = await createLowStockRule(db, {
      stockItemId: requiredId(catalog.stockItem, rule.ingredientId, 'stock item'),
      locationId: requiredId(catalog.stockLocation, rule.branchId, 'stock location'),
      threshold: rule.thresholdQuantity,
    });
    ids.lowStockRule[rule.id] = created.id;
    ids.counts.lowStockRules += 1;
  }

  const actualFlags = await evaluateLowStockRules(db);
  const flagById = new Map(actualFlags.map((flag) => [flag.ruleId, flag] as const));
  for (const expected of seed.inventory.lowStockRules) {
    const flag = flagById.get(requiredId(ids.lowStockRule, expected.id, 'low-stock rule'));
    if (!flag?.onHand.equals(expected.currentQuantity) || flag.isTriggered !== expected.triggered) {
      throw new Error(`Low-stock ledger state does not match demo target for ${expected.id}.`);
    }
  }

  return ids;
}
