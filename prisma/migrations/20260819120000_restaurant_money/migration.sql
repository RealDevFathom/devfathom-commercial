-- M5-L1 — Money: bills & splits, tenders & tips, a capability-shaped MOCK
-- payment adapter, refunds, register drawer sessions, the immutable daily
-- close, and the receipt-number seam for the Restaurant vertical
-- (restaurant/m5-money).
--
-- Additive and org-scoped. Every new table carries a bare, RLS-guarded
-- organizationId (defaulting from the transaction-local setting so an INSERT
-- cannot omit or forge it) and gets forced org-level RLS with the exact clause
-- used by 20260728092000_row_level_security / M1-L1 … M4-L1 (including the
-- app.is_platform_admin control-plane escape). NO pre-M5 table is altered.
--
-- Binding design constraints (WHA-52 plan) realised here:
--   C1  Forced org RLS on ALL 12 new tables.
--   C2  Every monetary column is DECIMAL(12,2); no floating point anywhere.
--   C3  DB-ENFORCED append-only ledgers. restaurant_tenders,
--       restaurant_payment_events, restaurant_refunds,
--       restaurant_drawer_movements, restaurant_daily_closes and
--       restaurant_daily_close_tender_totals receive SELECT + INSERT RLS
--       policies ONLY. With forced RLS and no UPDATE/DELETE policy, the
--       unprivileged app role cannot UPDATE or DELETE any row (the operation
--       matches zero rows). Corrections are NEW records referencing the original.
--   C4  Bills snapshot totals; splits are recorded via bill lines / fraction
--       pairs (bounds enforced by CHECK); a comp nets a line to zero.
--   C8  At most one OPEN drawer session per register (partial unique index).
--   C10 Receipt numbers live on a SEPARATE per-(branch, businessDate) sequence;
--       a bill's receipt number is unique per (branch, businessDate) via a
--       partial unique index (assigned once, at settlement).
--   C11 Money commands carry a device-scoped idempotency key,
--       unique (deviceId, key).
--
-- The CREATE TABLE / index / single-column FK section below is the curated
-- output of `prisma migrate diff` for these models. The security section that
-- follows is hand-authored because it uses migration-only constructs (deferred
-- composite tenant FKs, (organizationId, id) uniques, partial unique indexes,
-- CHECKs, forced RLS incl. the append-only policy omission) that Prisma cannot
-- express, so an auto-generated diff would try to DROP them as phantom drift.

-- CreateEnum
CREATE TYPE "RestaurantBillStatus" AS ENUM ('OPEN', 'SETTLED', 'VOID');

-- CreateEnum
CREATE TYPE "RestaurantBillSplitKind" AS ENUM ('NONE', 'BY_ITEM', 'BY_SEAT', 'FRACTIONAL');

-- CreateEnum
CREATE TYPE "RestaurantTenderType" AS ENUM ('CASH', 'CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "RestaurantPaymentProvider" AS ENUM ('MOCK');

-- CreateEnum
CREATE TYPE "RestaurantPaymentCapability" AS ENUM ('SALE', 'AUTH', 'CAPTURE', 'ADJUST', 'VOID', 'REFUND');

-- CreateEnum
CREATE TYPE "RestaurantPaymentStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'CAPTURED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DECLINED', 'FAILED');

-- CreateEnum
CREATE TYPE "RestaurantRefundKind" AS ENUM ('REFUND', 'VOID_REVERSAL');

-- CreateEnum
CREATE TYPE "RestaurantDrawerSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "RestaurantDrawerMovementKind" AS ENUM ('OPENING_FLOAT', 'CASH_SALE', 'CASH_REFUND', 'PAID_IN', 'PAID_OUT', 'DROP', 'CLOSING_COUNT');

-- CreateTable
CREATE TABLE "restaurant_bills" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "orderId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "status" "RestaurantBillStatus" NOT NULL DEFAULT 'OPEN',
    "splitKind" "RestaurantBillSplitKind" NOT NULL DEFAULT 'NONE',
    "fractionNumerator" INTEGER,
    "fractionDenominator" INTEGER,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "serviceChargeTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "compTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "roundingAdjustment" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "receiptNumber" INTEGER,
    "settledAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "voidCoAuthorizationId" TEXT,
    "openerStaffProfileId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_bill_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "billId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "lineSubtotal" DECIMAL(12,2) NOT NULL,
    "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "serviceChargeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "compAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "compReason" TEXT,
    "compCoAuthorizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_bill_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_payments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "billId" TEXT NOT NULL,
    "provider" "RestaurantPaymentProvider" NOT NULL DEFAULT 'MOCK',
    "capability" "RestaurantPaymentCapability" NOT NULL,
    "status" "RestaurantPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(12,2) NOT NULL,
    "tipAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "providerRef" TEXT,
    "staffProfileId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_payment_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "paymentId" TEXT NOT NULL,
    "capability" "RestaurantPaymentCapability" NOT NULL,
    "eventType" TEXT NOT NULL,
    "amount" DECIMAL(12,2),
    "providerRef" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_tenders" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "billId" TEXT NOT NULL,
    "type" "RestaurantTenderType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "tipAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cashReceived" DECIMAL(12,2),
    "changeGiven" DECIMAL(12,2),
    "drawerSessionId" TEXT,
    "paymentId" TEXT,
    "businessDate" DATE NOT NULL,
    "staffProfileId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_tenders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_refunds" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "originalTenderId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "tipRefundAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "kind" "RestaurantRefundKind" NOT NULL,
    "businessDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "coAuthorizationId" TEXT NOT NULL,
    "drawerSessionId" TEXT,
    "paymentId" TEXT,
    "staffProfileId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_drawer_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "staffProfileId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "status" "RestaurantDrawerSessionStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "openingFloat" DECIMAL(12,2) NOT NULL,
    "expectedCash" DECIMAL(12,2),
    "countedCash" DECIMAL(12,2),
    "variance" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_drawer_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_drawer_movements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "drawerSessionId" TEXT NOT NULL,
    "kind" "RestaurantDrawerMovementKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,
    "tenderId" TEXT,
    "refundId" TEXT,
    "staffProfileId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_drawer_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_daily_closes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "supersedesCloseId" TEXT,
    "correctionReason" TEXT,
    "coAuthorizationId" TEXT,
    "cutByStaffProfileId" TEXT NOT NULL,
    "deviceId" TEXT,
    "grossSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "serviceChargeTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tipTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "compTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refundTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "voidTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cashExpected" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cashCounted" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cashVariance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_daily_closes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_daily_close_tender_totals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "dailyCloseId" TEXT NOT NULL,
    "tenderType" "RestaurantTenderType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tipAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_daily_close_tender_totals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_receipt_number_sequences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "nextNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_receipt_number_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_money_idempotency_keys" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "deviceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "resultRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_money_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restaurant_bills_organizationId_idx" ON "restaurant_bills"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_bills_orderId_idx" ON "restaurant_bills"("orderId");

-- CreateIndex
CREATE INDEX "restaurant_bills_branchId_idx" ON "restaurant_bills"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_bills_status_idx" ON "restaurant_bills"("status");

-- CreateIndex
CREATE INDEX "restaurant_bills_businessDate_idx" ON "restaurant_bills"("businessDate");

-- CreateIndex
CREATE INDEX "restaurant_bill_lines_organizationId_idx" ON "restaurant_bill_lines"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_bill_lines_billId_idx" ON "restaurant_bill_lines"("billId");

-- CreateIndex
CREATE INDEX "restaurant_bill_lines_orderItemId_idx" ON "restaurant_bill_lines"("orderItemId");

-- CreateIndex
CREATE INDEX "restaurant_payments_organizationId_idx" ON "restaurant_payments"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_payments_billId_idx" ON "restaurant_payments"("billId");

-- CreateIndex
CREATE INDEX "restaurant_payments_status_idx" ON "restaurant_payments"("status");

-- CreateIndex
CREATE INDEX "restaurant_payments_providerRef_idx" ON "restaurant_payments"("providerRef");

-- CreateIndex
CREATE INDEX "restaurant_payment_events_organizationId_idx" ON "restaurant_payment_events"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_payment_events_paymentId_idx" ON "restaurant_payment_events"("paymentId");

-- CreateIndex
CREATE INDEX "restaurant_tenders_organizationId_idx" ON "restaurant_tenders"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_tenders_billId_idx" ON "restaurant_tenders"("billId");

-- CreateIndex
CREATE INDEX "restaurant_tenders_businessDate_idx" ON "restaurant_tenders"("businessDate");

-- CreateIndex
CREATE INDEX "restaurant_tenders_drawerSessionId_idx" ON "restaurant_tenders"("drawerSessionId");

-- CreateIndex
CREATE INDEX "restaurant_tenders_paymentId_idx" ON "restaurant_tenders"("paymentId");

-- CreateIndex
CREATE INDEX "restaurant_tenders_type_idx" ON "restaurant_tenders"("type");

-- CreateIndex
CREATE INDEX "restaurant_refunds_organizationId_idx" ON "restaurant_refunds"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_refunds_originalTenderId_idx" ON "restaurant_refunds"("originalTenderId");

-- CreateIndex
CREATE INDEX "restaurant_refunds_billId_idx" ON "restaurant_refunds"("billId");

-- CreateIndex
CREATE INDEX "restaurant_refunds_businessDate_idx" ON "restaurant_refunds"("businessDate");

-- CreateIndex
CREATE INDEX "restaurant_refunds_drawerSessionId_idx" ON "restaurant_refunds"("drawerSessionId");

-- CreateIndex
CREATE INDEX "restaurant_refunds_paymentId_idx" ON "restaurant_refunds"("paymentId");

-- CreateIndex
CREATE INDEX "restaurant_drawer_sessions_organizationId_idx" ON "restaurant_drawer_sessions"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_drawer_sessions_branchId_idx" ON "restaurant_drawer_sessions"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_drawer_sessions_deviceId_idx" ON "restaurant_drawer_sessions"("deviceId");

-- CreateIndex
CREATE INDEX "restaurant_drawer_sessions_staffProfileId_idx" ON "restaurant_drawer_sessions"("staffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_drawer_sessions_businessDate_idx" ON "restaurant_drawer_sessions"("businessDate");

-- CreateIndex
CREATE INDEX "restaurant_drawer_sessions_status_idx" ON "restaurant_drawer_sessions"("status");

-- CreateIndex
CREATE INDEX "restaurant_drawer_movements_organizationId_idx" ON "restaurant_drawer_movements"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_drawer_movements_drawerSessionId_idx" ON "restaurant_drawer_movements"("drawerSessionId");

-- CreateIndex
CREATE INDEX "restaurant_drawer_movements_tenderId_idx" ON "restaurant_drawer_movements"("tenderId");

-- CreateIndex
CREATE INDEX "restaurant_drawer_movements_refundId_idx" ON "restaurant_drawer_movements"("refundId");

-- CreateIndex
CREATE INDEX "restaurant_drawer_movements_kind_idx" ON "restaurant_drawer_movements"("kind");

-- CreateIndex
CREATE INDEX "restaurant_daily_closes_organizationId_idx" ON "restaurant_daily_closes"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_daily_closes_branchId_idx" ON "restaurant_daily_closes"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_daily_closes_businessDate_idx" ON "restaurant_daily_closes"("businessDate");

-- CreateIndex
CREATE INDEX "restaurant_daily_closes_supersedesCloseId_idx" ON "restaurant_daily_closes"("supersedesCloseId");

-- CreateIndex
CREATE INDEX "restaurant_daily_close_tender_totals_organizationId_idx" ON "restaurant_daily_close_tender_totals"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_daily_close_tender_totals_dailyCloseId_idx" ON "restaurant_daily_close_tender_totals"("dailyCloseId");

-- CreateIndex
CREATE INDEX "restaurant_receipt_number_sequences_organizationId_idx" ON "restaurant_receipt_number_sequences"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_receipt_number_sequences_branchId_idx" ON "restaurant_receipt_number_sequences"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_receipt_number_sequences_branchId_businessDate_key" ON "restaurant_receipt_number_sequences"("branchId", "businessDate");

-- CreateIndex
CREATE INDEX "restaurant_money_idempotency_keys_organizationId_idx" ON "restaurant_money_idempotency_keys"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_money_idempotency_keys_deviceId_idx" ON "restaurant_money_idempotency_keys"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_money_idempotency_keys_deviceId_key_key" ON "restaurant_money_idempotency_keys"("deviceId", "key");

-- AddForeignKey
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "restaurant_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_openerStaffProfileId_fkey" FOREIGN KEY ("openerStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_voidCoAuthorizationId_fkey" FOREIGN KEY ("voidCoAuthorizationId") REFERENCES "restaurant_co_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_bill_lines" ADD CONSTRAINT "restaurant_bill_lines_billId_fkey" FOREIGN KEY ("billId") REFERENCES "restaurant_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_bill_lines" ADD CONSTRAINT "restaurant_bill_lines_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "restaurant_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_bill_lines" ADD CONSTRAINT "restaurant_bill_lines_compCoAuthorizationId_fkey" FOREIGN KEY ("compCoAuthorizationId") REFERENCES "restaurant_co_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_payments" ADD CONSTRAINT "restaurant_payments_billId_fkey" FOREIGN KEY ("billId") REFERENCES "restaurant_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_payments" ADD CONSTRAINT "restaurant_payments_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_payments" ADD CONSTRAINT "restaurant_payments_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_payment_events" ADD CONSTRAINT "restaurant_payment_events_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "restaurant_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_tenders" ADD CONSTRAINT "restaurant_tenders_billId_fkey" FOREIGN KEY ("billId") REFERENCES "restaurant_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_tenders" ADD CONSTRAINT "restaurant_tenders_drawerSessionId_fkey" FOREIGN KEY ("drawerSessionId") REFERENCES "restaurant_drawer_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_tenders" ADD CONSTRAINT "restaurant_tenders_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "restaurant_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_tenders" ADD CONSTRAINT "restaurant_tenders_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_tenders" ADD CONSTRAINT "restaurant_tenders_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "restaurant_refunds_originalTenderId_fkey" FOREIGN KEY ("originalTenderId") REFERENCES "restaurant_tenders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "restaurant_refunds_billId_fkey" FOREIGN KEY ("billId") REFERENCES "restaurant_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "restaurant_refunds_coAuthorizationId_fkey" FOREIGN KEY ("coAuthorizationId") REFERENCES "restaurant_co_authorizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "restaurant_refunds_drawerSessionId_fkey" FOREIGN KEY ("drawerSessionId") REFERENCES "restaurant_drawer_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "restaurant_refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "restaurant_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "restaurant_refunds_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "restaurant_refunds_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_drawer_sessions" ADD CONSTRAINT "restaurant_drawer_sessions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_drawer_sessions" ADD CONSTRAINT "restaurant_drawer_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_drawer_sessions" ADD CONSTRAINT "restaurant_drawer_sessions_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_drawer_movements" ADD CONSTRAINT "restaurant_drawer_movements_drawerSessionId_fkey" FOREIGN KEY ("drawerSessionId") REFERENCES "restaurant_drawer_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_drawer_movements" ADD CONSTRAINT "restaurant_drawer_movements_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "restaurant_tenders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_drawer_movements" ADD CONSTRAINT "restaurant_drawer_movements_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "restaurant_refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_drawer_movements" ADD CONSTRAINT "restaurant_drawer_movements_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_drawer_movements" ADD CONSTRAINT "restaurant_drawer_movements_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_daily_closes" ADD CONSTRAINT "restaurant_daily_closes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_daily_closes" ADD CONSTRAINT "restaurant_daily_closes_supersedesCloseId_fkey" FOREIGN KEY ("supersedesCloseId") REFERENCES "restaurant_daily_closes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_daily_closes" ADD CONSTRAINT "restaurant_daily_closes_coAuthorizationId_fkey" FOREIGN KEY ("coAuthorizationId") REFERENCES "restaurant_co_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_daily_closes" ADD CONSTRAINT "restaurant_daily_closes_cutByStaffProfileId_fkey" FOREIGN KEY ("cutByStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_daily_closes" ADD CONSTRAINT "restaurant_daily_closes_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_daily_close_tender_totals" ADD CONSTRAINT "restaurant_daily_close_tender_totals_dailyCloseId_fkey" FOREIGN KEY ("dailyCloseId") REFERENCES "restaurant_daily_closes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_receipt_number_sequences" ADD CONSTRAINT "restaurant_receipt_number_sequences_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_money_idempotency_keys" ADD CONSTRAINT "restaurant_money_idempotency_keys_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Cross-tenant-safe composite integrity (matches M1-L1 … M4-L1): the
-- (organizationId, id) unique on every new table referenced by a composite FK,
-- so a child can only reference a parent inside its OWN organization.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_payments" ADD CONSTRAINT "restaurant_payments_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_tenders" ADD CONSTRAINT "restaurant_tenders_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "restaurant_refunds_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_drawer_sessions" ADD CONSTRAINT "restaurant_drawer_sessions_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_daily_closes" ADD CONSTRAINT "restaurant_daily_closes_organizationId_id_key" UNIQUE ("organizationId", "id");

-- ---------------------------------------------------------------------------
-- Business uniqueness / integrity the Prisma schema cannot express.
-- ---------------------------------------------------------------------------
-- C10: a settled bill's receipt number is unique per (branch, businessDate).
-- Partial (WHERE receiptNumber IS NOT NULL) so OPEN/VOID bills without a receipt
-- do not collide; the receipt seam itself lives on restaurant_receipt_number_sequences.
CREATE UNIQUE INDEX "restaurant_bills_branch_date_receipt_key" ON "restaurant_bills"("branchId", "businessDate", "receiptNumber") WHERE "receiptNumber" IS NOT NULL;
-- C8: at most one OPEN drawer session per register (device).
CREATE UNIQUE INDEX "restaurant_drawer_sessions_device_open_key" ON "restaurant_drawer_sessions"("deviceId") WHERE "status" = 'OPEN';
-- C4: FRACTIONAL split fraction pairs are set together and within bounds.
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_fraction_pair_ck" CHECK (("fractionNumerator" IS NULL) = ("fractionDenominator" IS NULL));
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_fraction_bounds_ck" CHECK ("fractionDenominator" IS NULL OR ("fractionDenominator" > 0 AND "fractionNumerator" >= 0 AND "fractionNumerator" <= "fractionDenominator"));
-- C2: non-negative money magnitudes where applicable (signs are applied by the
-- Decimal core / ledger fold, never stored negative).
ALTER TABLE "restaurant_payments" ADD CONSTRAINT "restaurant_payments_amounts_nonneg_ck" CHECK ("amount" >= 0 AND "tipAmount" >= 0);
ALTER TABLE "restaurant_tenders" ADD CONSTRAINT "restaurant_tenders_amounts_nonneg_ck" CHECK ("amount" >= 0 AND "tipAmount" >= 0 AND ("cashReceived" IS NULL OR "cashReceived" >= 0) AND ("changeGiven" IS NULL OR "changeGiven" >= 0));
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "restaurant_refunds_amounts_nonneg_ck" CHECK ("amount" >= 0 AND "tipRefundAmount" >= 0);
ALTER TABLE "restaurant_drawer_sessions" ADD CONSTRAINT "restaurant_drawer_sessions_openingFloat_nonneg_ck" CHECK ("openingFloat" >= 0);
ALTER TABLE "restaurant_drawer_movements" ADD CONSTRAINT "restaurant_drawer_movements_amount_nonneg_ck" CHECK ("amount" >= 0);
ALTER TABLE "restaurant_daily_close_tender_totals" ADD CONSTRAINT "restaurant_daily_close_tender_totals_nonneg_ck" CHECK ("amount" >= 0 AND "tipAmount" >= 0 AND "count" >= 0);

-- ---------------------------------------------------------------------------
-- Deferred composite tenant foreign keys. Every single-column FK to a table
-- that carries a (organizationId, id) unique is also expressed as a
-- (organizationId, <fk>) composite so a cross-organization reference is
-- impossible even inside the platform scope. Nullable FK columns use MATCH
-- SIMPLE (the default), so the composite is checked only when present.
-- (Co-authorization references carry NO composite tenant FK: restaurant_co_
-- authorizations has no (organizationId, id) unique and is consumed, never
-- modified — the M4 precedent for the void co-auth reference. C12.)
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "tenant_bill_orderId_fk" FOREIGN KEY ("organizationId", "orderId") REFERENCES "restaurant_orders" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "tenant_bill_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "tenant_bill_openerStaffId_fk" FOREIGN KEY ("organizationId", "openerStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "tenant_bill_deviceId_fk" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_bill_lines" ADD CONSTRAINT "tenant_billline_billId_fk" FOREIGN KEY ("organizationId", "billId") REFERENCES "restaurant_bills" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_bill_lines" ADD CONSTRAINT "tenant_billline_orderItemId_fk" FOREIGN KEY ("organizationId", "orderItemId") REFERENCES "restaurant_order_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_payments" ADD CONSTRAINT "tenant_payment_billId_fk" FOREIGN KEY ("organizationId", "billId") REFERENCES "restaurant_bills" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_payments" ADD CONSTRAINT "tenant_payment_staffId_fk" FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_payments" ADD CONSTRAINT "tenant_payment_deviceId_fk" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_payment_events" ADD CONSTRAINT "tenant_payevent_paymentId_fk" FOREIGN KEY ("organizationId", "paymentId") REFERENCES "restaurant_payments" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_tenders" ADD CONSTRAINT "tenant_tender_billId_fk" FOREIGN KEY ("organizationId", "billId") REFERENCES "restaurant_bills" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_tenders" ADD CONSTRAINT "tenant_tender_drawerSessionId_fk" FOREIGN KEY ("organizationId", "drawerSessionId") REFERENCES "restaurant_drawer_sessions" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_tenders" ADD CONSTRAINT "tenant_tender_paymentId_fk" FOREIGN KEY ("organizationId", "paymentId") REFERENCES "restaurant_payments" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_tenders" ADD CONSTRAINT "tenant_tender_staffId_fk" FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_tenders" ADD CONSTRAINT "tenant_tender_deviceId_fk" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "tenant_refund_tenderId_fk" FOREIGN KEY ("organizationId", "originalTenderId") REFERENCES "restaurant_tenders" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "tenant_refund_billId_fk" FOREIGN KEY ("organizationId", "billId") REFERENCES "restaurant_bills" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "tenant_refund_drawerSessionId_fk" FOREIGN KEY ("organizationId", "drawerSessionId") REFERENCES "restaurant_drawer_sessions" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "tenant_refund_paymentId_fk" FOREIGN KEY ("organizationId", "paymentId") REFERENCES "restaurant_payments" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "tenant_refund_staffId_fk" FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "tenant_refund_deviceId_fk" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_drawer_sessions" ADD CONSTRAINT "tenant_drawer_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_drawer_sessions" ADD CONSTRAINT "tenant_drawer_deviceId_fk" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_drawer_sessions" ADD CONSTRAINT "tenant_drawer_staffId_fk" FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_drawer_movements" ADD CONSTRAINT "tenant_drawermove_sessionId_fk" FOREIGN KEY ("organizationId", "drawerSessionId") REFERENCES "restaurant_drawer_sessions" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_drawer_movements" ADD CONSTRAINT "tenant_drawermove_tenderId_fk" FOREIGN KEY ("organizationId", "tenderId") REFERENCES "restaurant_tenders" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_drawer_movements" ADD CONSTRAINT "tenant_drawermove_refundId_fk" FOREIGN KEY ("organizationId", "refundId") REFERENCES "restaurant_refunds" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_drawer_movements" ADD CONSTRAINT "tenant_drawermove_staffId_fk" FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_drawer_movements" ADD CONSTRAINT "tenant_drawermove_deviceId_fk" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_daily_closes" ADD CONSTRAINT "tenant_close_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_daily_closes" ADD CONSTRAINT "tenant_close_supersedesId_fk" FOREIGN KEY ("organizationId", "supersedesCloseId") REFERENCES "restaurant_daily_closes" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_daily_closes" ADD CONSTRAINT "tenant_close_cutByStaffId_fk" FOREIGN KEY ("organizationId", "cutByStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_daily_closes" ADD CONSTRAINT "tenant_close_deviceId_fk" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_daily_close_tender_totals" ADD CONSTRAINT "tenant_closetender_closeId_fk" FOREIGN KEY ("organizationId", "dailyCloseId") REFERENCES "restaurant_daily_closes" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_receipt_number_sequences" ADD CONSTRAINT "tenant_receiptseq_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_money_idempotency_keys" ADD CONSTRAINT "tenant_moneyidem_deviceId_fk" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Forced org-level RLS on every new table, identical clause to
-- 20260728092000_row_level_security / M1-L1 … M4-L1 (incl. the
-- app.is_platform_admin control-plane escape).
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_bills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_bills" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_bills" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_bill_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_bill_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_bill_lines" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_payments" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_drawer_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_drawer_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_drawer_sessions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_receipt_number_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_receipt_number_sequences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_receipt_number_sequences" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_money_idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_money_idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_money_idempotency_keys" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

-- ---------------------------------------------------------------------------
-- C3: DB-enforced APPEND-ONLY ledgers. SELECT + INSERT policies ONLY — with
-- forced RLS and no UPDATE/DELETE policy, the unprivileged app role cannot
-- mutate or delete any row (the operation matches zero rows). A correction is
-- observable only as a NEW record referencing the original.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_tenders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_tenders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_tenders" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_tenders" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_payment_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_payment_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_payment_events" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_payment_events" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_refunds" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_refunds" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_refunds" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_drawer_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_drawer_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_drawer_movements" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_drawer_movements" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_daily_closes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_daily_closes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_daily_closes" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_daily_closes" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_daily_close_tender_totals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_daily_close_tender_totals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_daily_close_tender_totals" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_daily_close_tender_totals" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
