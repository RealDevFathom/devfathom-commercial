-- M6-L1 — Inventory & purchasing: stock locations, the stockable-ingredient
-- seam, the APPEND-ONLY stock movement ledger, batches, physical counts,
-- inter-location transfers, low-stock rules, suppliers, purchase orders,
-- goods receiving, receiving discrepancies, and an inventory idempotency-key
-- replay domain for the Restaurant vertical (restaurant/m6-inventory-purchasing).
--
-- Additive and org-scoped. Every new table carries a bare, RLS-guarded
-- organizationId (defaulting from the transaction-local setting so an INSERT
-- cannot omit or forge it) and gets forced org-level RLS with the exact clause
-- used by 20260728092000_row_level_security / M1-L1 … M5-L1 (including the
-- app.is_platform_admin control-plane escape). NO pre-M6 table is altered.
--
-- Binding design constraints (WHA-67 plan / §11.4 / D07 defaults) realised here:
--   Append-only ledger   restaurant_stock_movements is the SINGLE source of
--                        stock truth and receives SELECT + INSERT RLS policies
--                        ONLY (the M5 append-only ledger pattern). With forced
--                        RLS and no UPDATE/DELETE policy the unprivileged app
--                        role cannot mutate or delete a movement; a correction
--                        is a NEW movement (backdated via occurredAt).
--   No mutable balance   NO table carries an on-hand balance column. Balances
--                        are DERIVED by folding the movement ledger by
--                        (stockItem, location) (D07). Costing is read-time
--                        weighted-average from intrinsic-cost movements.
--   Decimal quantities   Every quantity/cost is DECIMAL(18,6); no float anywhere.
--   Signed movements     A movement `quantity` is signed (in/out); magnitudes on
--                        lines/thresholds are non-negative (CHECKs). Negative
--                        derived stock is permitted, never blocked at posting.
--   Ten reasons          RestaurantStockMovementReason is EXACTLY the §11.4 ten.
--
-- The CREATE TABLE / index / single-column FK section below is the curated
-- output of `prisma migrate diff` for these models (datamodel-to-datamodel, so
-- it carries no phantom drift for pre-existing tables). The security section
-- that follows is hand-authored because it uses migration-only constructs
-- (deferred composite tenant FKs, (organizationId, id) uniques, CHECKs, forced
-- RLS incl. the append-only policy omission) that Prisma cannot express, so an
-- auto-generated diff would try to DROP them as phantom drift.

-- CreateEnum
CREATE TYPE "RestaurantStockMovementReason" AS ENUM ('PURCHASE_RECEIPT', 'RECIPE_CONSUMPTION', 'SALE_REVERSAL', 'TRANSFER', 'PHYSICAL_COUNT_ADJUSTMENT', 'WASTAGE', 'SPOILAGE', 'STAFF_MEAL', 'SUPPLIER_RETURN', 'MANUAL_CORRECTION');

-- CreateEnum
CREATE TYPE "RestaurantStockCountStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'POSTED');

-- CreateEnum
CREATE TYPE "RestaurantStockTransferStatus" AS ENUM ('DRAFT', 'DISPATCHED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RestaurantPurchaseOrderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RestaurantReceivingDiscrepancyKind" AS ENUM ('SHORTAGE', 'OVERAGE', 'DAMAGED', 'EXPIRED', 'REJECTED', 'OTHER');

-- CreateTable
CREATE TABLE "restaurant_stock_locations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_stock_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_stock_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "ingredientId" TEXT NOT NULL,
    "canonicalUnitId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "trackBatches" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_stock_movements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "stockItemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "reason" "RestaurantStockMovementReason" NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "unitCost" DECIMAL(18,6),
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" TEXT,
    "receiptId" TEXT,
    "transferId" TEXT,
    "countId" TEXT,
    "batchId" TEXT,
    "staffProfileId" TEXT,
    "deviceId" TEXT,

    CONSTRAINT "restaurant_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_stock_batches" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "stockItemId" TEXT NOT NULL,
    "receiptId" TEXT,
    "code" TEXT NOT NULL,
    "expiryDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_stock_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_stock_counts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "locationId" TEXT NOT NULL,
    "status" "RestaurantStockCountStatus" NOT NULL DEFAULT 'DRAFT',
    "reference" TEXT,
    "countedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "postedAt" TIMESTAMP(3),
    "staffProfileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_stock_count_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "stockCountId" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "countedQuantity" DECIMAL(18,6) NOT NULL,
    "snapshotQuantity" DECIMAL(18,6) NOT NULL,
    "varianceQuantity" DECIMAL(18,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_stock_transfers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "sourceLocationId" TEXT NOT NULL,
    "destinationLocationId" TEXT NOT NULL,
    "status" "RestaurantStockTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "reference" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "staffProfileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_stock_transfer_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "stockTransferId" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_stock_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_low_stock_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "stockItemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "threshold" DECIMAL(18,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_low_stock_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_suppliers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "name" TEXT NOT NULL,
    "code" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_purchase_orders" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "supplierId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "locationId" TEXT,
    "status" "RestaurantPurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "reference" TEXT,
    "expectedDate" DATE,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdByStaffProfileId" TEXT,
    "approvedByStaffProfileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_purchase_order_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "purchaseOrderId" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "orderedQuantity" DECIMAL(18,6) NOT NULL,
    "unitId" TEXT NOT NULL,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_purchase_receipts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "purchaseOrderId" TEXT,
    "supplierId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "reference" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staffProfileId" TEXT,
    "deviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_purchase_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_purchase_receipt_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "purchaseReceiptId" TEXT NOT NULL,
    "purchaseOrderLineId" TEXT,
    "stockItemId" TEXT NOT NULL,
    "receivedQuantity" DECIMAL(18,6) NOT NULL,
    "unitId" TEXT NOT NULL,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_purchase_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_receiving_discrepancies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "purchaseReceiptId" TEXT NOT NULL,
    "purchaseReceiptLineId" TEXT,
    "stockItemId" TEXT NOT NULL,
    "kind" "RestaurantReceivingDiscrepancyKind" NOT NULL,
    "expectedQuantity" DECIMAL(18,6) NOT NULL,
    "receivedQuantity" DECIMAL(18,6) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_receiving_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_inventory_idempotency_keys" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "key" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "resultRef" TEXT,
    "deviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_inventory_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restaurant_stock_locations_organizationId_idx" ON "restaurant_stock_locations"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_stock_locations_branchId_idx" ON "restaurant_stock_locations"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_stock_items_ingredientId_key" ON "restaurant_stock_items"("ingredientId");

-- CreateIndex
CREATE INDEX "restaurant_stock_items_organizationId_idx" ON "restaurant_stock_items"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_stock_items_canonicalUnitId_idx" ON "restaurant_stock_items"("canonicalUnitId");

-- CreateIndex
CREATE INDEX "restaurant_stock_movements_organizationId_idx" ON "restaurant_stock_movements"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_stock_movements_stockItemId_locationId_idx" ON "restaurant_stock_movements"("stockItemId", "locationId");

-- CreateIndex
CREATE INDEX "restaurant_stock_movements_locationId_idx" ON "restaurant_stock_movements"("locationId");

-- CreateIndex
CREATE INDEX "restaurant_stock_movements_reason_idx" ON "restaurant_stock_movements"("reason");

-- CreateIndex
CREATE INDEX "restaurant_stock_movements_occurredAt_idx" ON "restaurant_stock_movements"("occurredAt");

-- CreateIndex
CREATE INDEX "restaurant_stock_movements_orderId_idx" ON "restaurant_stock_movements"("orderId");

-- CreateIndex
CREATE INDEX "restaurant_stock_movements_receiptId_idx" ON "restaurant_stock_movements"("receiptId");

-- CreateIndex
CREATE INDEX "restaurant_stock_movements_transferId_idx" ON "restaurant_stock_movements"("transferId");

-- CreateIndex
CREATE INDEX "restaurant_stock_movements_countId_idx" ON "restaurant_stock_movements"("countId");

-- CreateIndex
CREATE INDEX "restaurant_stock_movements_batchId_idx" ON "restaurant_stock_movements"("batchId");

-- CreateIndex
CREATE INDEX "restaurant_stock_batches_organizationId_idx" ON "restaurant_stock_batches"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_stock_batches_stockItemId_idx" ON "restaurant_stock_batches"("stockItemId");

-- CreateIndex
CREATE INDEX "restaurant_stock_batches_receiptId_idx" ON "restaurant_stock_batches"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_stock_batches_stockItemId_code_key" ON "restaurant_stock_batches"("stockItemId", "code");

-- CreateIndex
CREATE INDEX "restaurant_stock_counts_organizationId_idx" ON "restaurant_stock_counts"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_stock_counts_locationId_idx" ON "restaurant_stock_counts"("locationId");

-- CreateIndex
CREATE INDEX "restaurant_stock_counts_status_idx" ON "restaurant_stock_counts"("status");

-- CreateIndex
CREATE INDEX "restaurant_stock_count_lines_organizationId_idx" ON "restaurant_stock_count_lines"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_stock_count_lines_stockCountId_idx" ON "restaurant_stock_count_lines"("stockCountId");

-- CreateIndex
CREATE INDEX "restaurant_stock_count_lines_stockItemId_idx" ON "restaurant_stock_count_lines"("stockItemId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_stock_count_lines_stockCountId_stockItemId_key" ON "restaurant_stock_count_lines"("stockCountId", "stockItemId");

-- CreateIndex
CREATE INDEX "restaurant_stock_transfers_organizationId_idx" ON "restaurant_stock_transfers"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_stock_transfers_sourceLocationId_idx" ON "restaurant_stock_transfers"("sourceLocationId");

-- CreateIndex
CREATE INDEX "restaurant_stock_transfers_destinationLocationId_idx" ON "restaurant_stock_transfers"("destinationLocationId");

-- CreateIndex
CREATE INDEX "restaurant_stock_transfers_status_idx" ON "restaurant_stock_transfers"("status");

-- CreateIndex
CREATE INDEX "restaurant_stock_transfer_lines_organizationId_idx" ON "restaurant_stock_transfer_lines"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_stock_transfer_lines_stockTransferId_idx" ON "restaurant_stock_transfer_lines"("stockTransferId");

-- CreateIndex
CREATE INDEX "restaurant_stock_transfer_lines_stockItemId_idx" ON "restaurant_stock_transfer_lines"("stockItemId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_stock_transfer_lines_stockTransferId_stockItemId_key" ON "restaurant_stock_transfer_lines"("stockTransferId", "stockItemId");

-- CreateIndex
CREATE INDEX "restaurant_low_stock_rules_organizationId_idx" ON "restaurant_low_stock_rules"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_low_stock_rules_stockItemId_idx" ON "restaurant_low_stock_rules"("stockItemId");

-- CreateIndex
CREATE INDEX "restaurant_low_stock_rules_locationId_idx" ON "restaurant_low_stock_rules"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_low_stock_rules_stockItemId_locationId_key" ON "restaurant_low_stock_rules"("stockItemId", "locationId");

-- CreateIndex
CREATE INDEX "restaurant_suppliers_organizationId_idx" ON "restaurant_suppliers"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_orders_organizationId_idx" ON "restaurant_purchase_orders"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_orders_supplierId_idx" ON "restaurant_purchase_orders"("supplierId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_orders_branchId_idx" ON "restaurant_purchase_orders"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_orders_locationId_idx" ON "restaurant_purchase_orders"("locationId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_orders_status_idx" ON "restaurant_purchase_orders"("status");

-- CreateIndex
CREATE INDEX "restaurant_purchase_order_lines_organizationId_idx" ON "restaurant_purchase_order_lines"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_order_lines_purchaseOrderId_idx" ON "restaurant_purchase_order_lines"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_order_lines_stockItemId_idx" ON "restaurant_purchase_order_lines"("stockItemId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_order_lines_unitId_idx" ON "restaurant_purchase_order_lines"("unitId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_receipts_organizationId_idx" ON "restaurant_purchase_receipts"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_receipts_purchaseOrderId_idx" ON "restaurant_purchase_receipts"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_receipts_supplierId_idx" ON "restaurant_purchase_receipts"("supplierId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_receipts_branchId_idx" ON "restaurant_purchase_receipts"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_receipts_locationId_idx" ON "restaurant_purchase_receipts"("locationId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_receipt_lines_organizationId_idx" ON "restaurant_purchase_receipt_lines"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_receipt_lines_purchaseReceiptId_idx" ON "restaurant_purchase_receipt_lines"("purchaseReceiptId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_receipt_lines_purchaseOrderLineId_idx" ON "restaurant_purchase_receipt_lines"("purchaseOrderLineId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_receipt_lines_stockItemId_idx" ON "restaurant_purchase_receipt_lines"("stockItemId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_receipt_lines_unitId_idx" ON "restaurant_purchase_receipt_lines"("unitId");

-- CreateIndex
CREATE INDEX "restaurant_purchase_receipt_lines_batchId_idx" ON "restaurant_purchase_receipt_lines"("batchId");

-- CreateIndex
CREATE INDEX "restaurant_receiving_discrepancies_organizationId_idx" ON "restaurant_receiving_discrepancies"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_receiving_discrepancies_purchaseReceiptId_idx" ON "restaurant_receiving_discrepancies"("purchaseReceiptId");

-- CreateIndex
CREATE INDEX "restaurant_receiving_discrepancies_purchaseReceiptLineId_idx" ON "restaurant_receiving_discrepancies"("purchaseReceiptLineId");

-- CreateIndex
CREATE INDEX "restaurant_receiving_discrepancies_stockItemId_idx" ON "restaurant_receiving_discrepancies"("stockItemId");

-- CreateIndex
CREATE INDEX "restaurant_inventory_idempotency_keys_organizationId_idx" ON "restaurant_inventory_idempotency_keys"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_inventory_idempotency_keys_deviceId_idx" ON "restaurant_inventory_idempotency_keys"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_inventory_idempotency_keys_organizationId_key_key" ON "restaurant_inventory_idempotency_keys"("organizationId", "key");

-- AddForeignKey
ALTER TABLE "restaurant_stock_locations" ADD CONSTRAINT "restaurant_stock_locations_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_items" ADD CONSTRAINT "restaurant_stock_items_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "restaurant_ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_items" ADD CONSTRAINT "restaurant_stock_items_canonicalUnitId_fkey" FOREIGN KEY ("canonicalUnitId") REFERENCES "restaurant_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "restaurant_stock_movements_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "restaurant_stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "restaurant_stock_movements_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "restaurant_stock_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "restaurant_stock_movements_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "restaurant_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "restaurant_stock_movements_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "restaurant_purchase_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "restaurant_stock_movements_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "restaurant_stock_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "restaurant_stock_movements_countId_fkey" FOREIGN KEY ("countId") REFERENCES "restaurant_stock_counts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "restaurant_stock_movements_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "restaurant_stock_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "restaurant_stock_movements_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "restaurant_stock_movements_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_batches" ADD CONSTRAINT "restaurant_stock_batches_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "restaurant_stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_batches" ADD CONSTRAINT "restaurant_stock_batches_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "restaurant_purchase_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_counts" ADD CONSTRAINT "restaurant_stock_counts_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "restaurant_stock_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_counts" ADD CONSTRAINT "restaurant_stock_counts_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_count_lines" ADD CONSTRAINT "restaurant_stock_count_lines_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "restaurant_stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_count_lines" ADD CONSTRAINT "restaurant_stock_count_lines_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "restaurant_stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_transfers" ADD CONSTRAINT "restaurant_stock_transfers_sourceLocationId_fkey" FOREIGN KEY ("sourceLocationId") REFERENCES "restaurant_stock_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_transfers" ADD CONSTRAINT "restaurant_stock_transfers_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "restaurant_stock_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_transfers" ADD CONSTRAINT "restaurant_stock_transfers_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_transfer_lines" ADD CONSTRAINT "restaurant_stock_transfer_lines_stockTransferId_fkey" FOREIGN KEY ("stockTransferId") REFERENCES "restaurant_stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_stock_transfer_lines" ADD CONSTRAINT "restaurant_stock_transfer_lines_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "restaurant_stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_low_stock_rules" ADD CONSTRAINT "restaurant_low_stock_rules_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "restaurant_stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_low_stock_rules" ADD CONSTRAINT "restaurant_low_stock_rules_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "restaurant_stock_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_orders" ADD CONSTRAINT "restaurant_purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "restaurant_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_orders" ADD CONSTRAINT "restaurant_purchase_orders_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_orders" ADD CONSTRAINT "restaurant_purchase_orders_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "restaurant_stock_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_orders" ADD CONSTRAINT "restaurant_purchase_orders_createdByStaffProfileId_fkey" FOREIGN KEY ("createdByStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_orders" ADD CONSTRAINT "restaurant_purchase_orders_approvedByStaffProfileId_fkey" FOREIGN KEY ("approvedByStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_order_lines" ADD CONSTRAINT "restaurant_purchase_order_lines_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "restaurant_purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_order_lines" ADD CONSTRAINT "restaurant_purchase_order_lines_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "restaurant_stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_order_lines" ADD CONSTRAINT "restaurant_purchase_order_lines_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "restaurant_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_receipts" ADD CONSTRAINT "restaurant_purchase_receipts_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "restaurant_purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_receipts" ADD CONSTRAINT "restaurant_purchase_receipts_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "restaurant_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_receipts" ADD CONSTRAINT "restaurant_purchase_receipts_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_receipts" ADD CONSTRAINT "restaurant_purchase_receipts_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "restaurant_stock_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_receipts" ADD CONSTRAINT "restaurant_purchase_receipts_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_receipts" ADD CONSTRAINT "restaurant_purchase_receipts_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_receipt_lines" ADD CONSTRAINT "restaurant_purchase_receipt_lines_purchaseReceiptId_fkey" FOREIGN KEY ("purchaseReceiptId") REFERENCES "restaurant_purchase_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_receipt_lines" ADD CONSTRAINT "restaurant_purchase_receipt_lines_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "restaurant_purchase_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_receipt_lines" ADD CONSTRAINT "restaurant_purchase_receipt_lines_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "restaurant_stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_receipt_lines" ADD CONSTRAINT "restaurant_purchase_receipt_lines_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "restaurant_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_purchase_receipt_lines" ADD CONSTRAINT "restaurant_purchase_receipt_lines_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "restaurant_stock_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_receiving_discrepancies" ADD CONSTRAINT "restaurant_receiving_discrepancies_purchaseReceiptId_fkey" FOREIGN KEY ("purchaseReceiptId") REFERENCES "restaurant_purchase_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_receiving_discrepancies" ADD CONSTRAINT "restaurant_receiving_discrepancies_purchaseReceiptLineId_fkey" FOREIGN KEY ("purchaseReceiptLineId") REFERENCES "restaurant_purchase_receipt_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_receiving_discrepancies" ADD CONSTRAINT "restaurant_receiving_discrepancies_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "restaurant_stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_inventory_idempotency_keys" ADD CONSTRAINT "restaurant_inventory_idempotency_keys_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Cross-tenant-safe composite integrity (matches M1-L1 … M5-L1): the
-- (organizationId, id) unique on every new table referenced by a composite FK,
-- so a child can only reference a parent inside its OWN organization.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_stock_locations" ADD CONSTRAINT "restaurant_stock_locations_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_stock_items" ADD CONSTRAINT "restaurant_stock_items_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_stock_batches" ADD CONSTRAINT "restaurant_stock_batches_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_stock_counts" ADD CONSTRAINT "restaurant_stock_counts_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_stock_transfers" ADD CONSTRAINT "restaurant_stock_transfers_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_suppliers" ADD CONSTRAINT "restaurant_suppliers_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_purchase_orders" ADD CONSTRAINT "restaurant_purchase_orders_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_purchase_order_lines" ADD CONSTRAINT "restaurant_purchase_order_lines_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_purchase_receipts" ADD CONSTRAINT "restaurant_purchase_receipts_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_purchase_receipt_lines" ADD CONSTRAINT "restaurant_purchase_receipt_lines_organizationId_id_key" UNIQUE ("organizationId", "id");

-- ---------------------------------------------------------------------------
-- Business integrity the Prisma schema cannot express. Quantities that are
-- MAGNITUDES (transfer/count/order/receipt lines, thresholds) are non-negative;
-- a stock movement's `quantity` is SIGNED (in/out) so it carries NO sign check.
-- Negative DERIVED balances remain permitted (D07) — no balance pre-check here.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "restaurant_stock_movements_unitCost_nonneg_ck" CHECK ("unitCost" IS NULL OR "unitCost" >= 0);
ALTER TABLE "restaurant_stock_transfers" ADD CONSTRAINT "restaurant_stock_transfers_distinct_locations_ck" CHECK ("sourceLocationId" <> "destinationLocationId");
ALTER TABLE "restaurant_stock_transfer_lines" ADD CONSTRAINT "restaurant_stock_transfer_lines_qty_nonneg_ck" CHECK ("quantity" >= 0);
ALTER TABLE "restaurant_stock_count_lines" ADD CONSTRAINT "restaurant_stock_count_lines_counted_nonneg_ck" CHECK ("countedQuantity" >= 0);
ALTER TABLE "restaurant_low_stock_rules" ADD CONSTRAINT "restaurant_low_stock_rules_threshold_nonneg_ck" CHECK ("threshold" >= 0);
ALTER TABLE "restaurant_purchase_order_lines" ADD CONSTRAINT "restaurant_purchase_order_lines_nonneg_ck" CHECK ("orderedQuantity" >= 0 AND "unitCost" >= 0);
ALTER TABLE "restaurant_purchase_receipt_lines" ADD CONSTRAINT "restaurant_purchase_receipt_lines_nonneg_ck" CHECK ("receivedQuantity" >= 0 AND "unitCost" >= 0);
ALTER TABLE "restaurant_receiving_discrepancies" ADD CONSTRAINT "restaurant_receiving_discrepancies_nonneg_ck" CHECK ("expectedQuantity" >= 0 AND "receivedQuantity" >= 0);

-- ---------------------------------------------------------------------------
-- Deferred composite tenant foreign keys. Every single-column FK to a table
-- carrying a (organizationId, id) unique is ALSO expressed as a
-- (organizationId, <fk>) composite so a cross-organization reference is
-- impossible even inside the platform scope. Nullable FK columns use MATCH
-- SIMPLE (the default), so the composite is checked only when the column is set.
-- (No co-authorization references exist on any M6 table — C12 precedent moot.)
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_stock_locations" ADD CONSTRAINT "tenant_stockloc_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_items" ADD CONSTRAINT "tenant_stockitem_ingredientId_fk" FOREIGN KEY ("organizationId", "ingredientId") REFERENCES "restaurant_ingredients" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_items" ADD CONSTRAINT "tenant_stockitem_unitId_fk" FOREIGN KEY ("organizationId", "canonicalUnitId") REFERENCES "restaurant_units" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "tenant_stockmove_itemId_fk" FOREIGN KEY ("organizationId", "stockItemId") REFERENCES "restaurant_stock_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "tenant_stockmove_locId_fk" FOREIGN KEY ("organizationId", "locationId") REFERENCES "restaurant_stock_locations" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "tenant_stockmove_orderId_fk" FOREIGN KEY ("organizationId", "orderId") REFERENCES "restaurant_orders" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "tenant_stockmove_receiptId_fk" FOREIGN KEY ("organizationId", "receiptId") REFERENCES "restaurant_purchase_receipts" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "tenant_stockmove_transferId_fk" FOREIGN KEY ("organizationId", "transferId") REFERENCES "restaurant_stock_transfers" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "tenant_stockmove_countId_fk" FOREIGN KEY ("organizationId", "countId") REFERENCES "restaurant_stock_counts" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "tenant_stockmove_batchId_fk" FOREIGN KEY ("organizationId", "batchId") REFERENCES "restaurant_stock_batches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "tenant_stockmove_staffId_fk" FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_movements" ADD CONSTRAINT "tenant_stockmove_deviceId_fk" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_batches" ADD CONSTRAINT "tenant_stockbatch_itemId_fk" FOREIGN KEY ("organizationId", "stockItemId") REFERENCES "restaurant_stock_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_batches" ADD CONSTRAINT "tenant_stockbatch_receiptId_fk" FOREIGN KEY ("organizationId", "receiptId") REFERENCES "restaurant_purchase_receipts" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_counts" ADD CONSTRAINT "tenant_stockcount_locId_fk" FOREIGN KEY ("organizationId", "locationId") REFERENCES "restaurant_stock_locations" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_counts" ADD CONSTRAINT "tenant_stockcount_staffId_fk" FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_count_lines" ADD CONSTRAINT "tenant_countline_countId_fk" FOREIGN KEY ("organizationId", "stockCountId") REFERENCES "restaurant_stock_counts" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_count_lines" ADD CONSTRAINT "tenant_countline_itemId_fk" FOREIGN KEY ("organizationId", "stockItemId") REFERENCES "restaurant_stock_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_transfers" ADD CONSTRAINT "tenant_transfer_srcLocId_fk" FOREIGN KEY ("organizationId", "sourceLocationId") REFERENCES "restaurant_stock_locations" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_transfers" ADD CONSTRAINT "tenant_transfer_dstLocId_fk" FOREIGN KEY ("organizationId", "destinationLocationId") REFERENCES "restaurant_stock_locations" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_transfers" ADD CONSTRAINT "tenant_transfer_staffId_fk" FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_transfer_lines" ADD CONSTRAINT "tenant_transferline_transferId_fk" FOREIGN KEY ("organizationId", "stockTransferId") REFERENCES "restaurant_stock_transfers" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_stock_transfer_lines" ADD CONSTRAINT "tenant_transferline_itemId_fk" FOREIGN KEY ("organizationId", "stockItemId") REFERENCES "restaurant_stock_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_low_stock_rules" ADD CONSTRAINT "tenant_lowstock_itemId_fk" FOREIGN KEY ("organizationId", "stockItemId") REFERENCES "restaurant_stock_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_low_stock_rules" ADD CONSTRAINT "tenant_lowstock_locId_fk" FOREIGN KEY ("organizationId", "locationId") REFERENCES "restaurant_stock_locations" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_orders" ADD CONSTRAINT "tenant_po_supplierId_fk" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "restaurant_suppliers" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_orders" ADD CONSTRAINT "tenant_po_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_orders" ADD CONSTRAINT "tenant_po_locId_fk" FOREIGN KEY ("organizationId", "locationId") REFERENCES "restaurant_stock_locations" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_orders" ADD CONSTRAINT "tenant_po_createdById_fk" FOREIGN KEY ("organizationId", "createdByStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_orders" ADD CONSTRAINT "tenant_po_approvedById_fk" FOREIGN KEY ("organizationId", "approvedByStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_order_lines" ADD CONSTRAINT "tenant_poline_poId_fk" FOREIGN KEY ("organizationId", "purchaseOrderId") REFERENCES "restaurant_purchase_orders" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_order_lines" ADD CONSTRAINT "tenant_poline_itemId_fk" FOREIGN KEY ("organizationId", "stockItemId") REFERENCES "restaurant_stock_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_order_lines" ADD CONSTRAINT "tenant_poline_unitId_fk" FOREIGN KEY ("organizationId", "unitId") REFERENCES "restaurant_units" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_receipts" ADD CONSTRAINT "tenant_receipt_poId_fk" FOREIGN KEY ("organizationId", "purchaseOrderId") REFERENCES "restaurant_purchase_orders" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_receipts" ADD CONSTRAINT "tenant_receipt_supplierId_fk" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "restaurant_suppliers" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_receipts" ADD CONSTRAINT "tenant_receipt_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_receipts" ADD CONSTRAINT "tenant_receipt_locId_fk" FOREIGN KEY ("organizationId", "locationId") REFERENCES "restaurant_stock_locations" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_receipts" ADD CONSTRAINT "tenant_receipt_staffId_fk" FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_receipts" ADD CONSTRAINT "tenant_receipt_deviceId_fk" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_receipt_lines" ADD CONSTRAINT "tenant_receiptline_receiptId_fk" FOREIGN KEY ("organizationId", "purchaseReceiptId") REFERENCES "restaurant_purchase_receipts" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_receipt_lines" ADD CONSTRAINT "tenant_receiptline_poLineId_fk" FOREIGN KEY ("organizationId", "purchaseOrderLineId") REFERENCES "restaurant_purchase_order_lines" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_receipt_lines" ADD CONSTRAINT "tenant_receiptline_itemId_fk" FOREIGN KEY ("organizationId", "stockItemId") REFERENCES "restaurant_stock_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_receipt_lines" ADD CONSTRAINT "tenant_receiptline_unitId_fk" FOREIGN KEY ("organizationId", "unitId") REFERENCES "restaurant_units" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_purchase_receipt_lines" ADD CONSTRAINT "tenant_receiptline_batchId_fk" FOREIGN KEY ("organizationId", "batchId") REFERENCES "restaurant_stock_batches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_receiving_discrepancies" ADD CONSTRAINT "tenant_discrepancy_receiptId_fk" FOREIGN KEY ("organizationId", "purchaseReceiptId") REFERENCES "restaurant_purchase_receipts" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_receiving_discrepancies" ADD CONSTRAINT "tenant_discrepancy_receiptLineId_fk" FOREIGN KEY ("organizationId", "purchaseReceiptLineId") REFERENCES "restaurant_purchase_receipt_lines" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_receiving_discrepancies" ADD CONSTRAINT "tenant_discrepancy_itemId_fk" FOREIGN KEY ("organizationId", "stockItemId") REFERENCES "restaurant_stock_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_inventory_idempotency_keys" ADD CONSTRAINT "tenant_invidem_deviceId_fk" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Forced org-level RLS on every new table, identical clause to
-- 20260728092000_row_level_security / M1-L1 … M5-L1 (incl. the
-- app.is_platform_admin control-plane escape).
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_stock_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_stock_locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_stock_locations" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_stock_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_stock_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_stock_items" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_stock_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_stock_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_stock_batches" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_stock_counts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_stock_counts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_stock_counts" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_stock_count_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_stock_count_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_stock_count_lines" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_stock_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_stock_transfers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_stock_transfers" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_stock_transfer_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_stock_transfer_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_stock_transfer_lines" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_low_stock_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_low_stock_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_low_stock_rules" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_suppliers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_suppliers" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_purchase_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_purchase_orders" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_purchase_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_purchase_order_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_purchase_order_lines" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_purchase_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_purchase_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_purchase_receipts" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_purchase_receipt_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_purchase_receipt_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_purchase_receipt_lines" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_receiving_discrepancies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_receiving_discrepancies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_receiving_discrepancies" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_inventory_idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_inventory_idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_inventory_idempotency_keys" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

-- ---------------------------------------------------------------------------
-- C-append-only: the DB-enforced APPEND-ONLY stock movement ledger. SELECT +
-- INSERT policies ONLY — with forced RLS and no UPDATE/DELETE policy, the
-- unprivileged app role cannot mutate or delete any row (the operation matches
-- zero rows). A correction is observable only as a NEW movement referencing the
-- original context (backdated via occurredAt). This is the M5 append-only
-- ledger pattern (restaurant_tenders et al.) applied to stock (§11.4).
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_stock_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_stock_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_stock_movements" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_stock_movements" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
