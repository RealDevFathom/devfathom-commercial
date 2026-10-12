-- CreateEnum
CREATE TYPE "PharmacySaleStatus" AS ENUM ('OPEN', 'HELD', 'QUOTATION', 'COMPLETED', 'VOID');

-- CreateEnum
CREATE TYPE "PharmacySaleEventKind" AS ENUM ('CREATED', 'LINE_ADDED', 'HELD', 'RESUMED', 'QUOTATION_CREATED', 'QUOTATION_CONVERTED', 'COMPLETED', 'VOIDED', 'RETURNED', 'EXCHANGED');

-- CreateEnum
CREATE TYPE "PharmacySaleUnit" AS ENUM ('PACK', 'STRIP', 'UNIT');

-- CreateEnum
CREATE TYPE "PharmacyDiscountKind" AS ENUM ('DISCOUNT', 'PROMOTION', 'COMPLIMENTARY');

-- CreateEnum
CREATE TYPE "PharmacyDemandReason" AS ENUM ('STOCKOUT', 'NOT_CARRIED', 'PACK_UNAVAILABLE', 'QUARANTINED_OR_EXPIRED', 'PRICE_REJECTED', 'PRESCRIPTION_RESTRICTION', 'LICENCE_RESTRICTION', 'PHARMACIST_RESTRICTION', 'SUBSTITUTE_DECLINED', 'SEARCH_FAILURE', 'SERVICE_FAILURE');

-- CreateEnum
CREATE TYPE "PharmacyDemandStatus" AS ENUM ('OPEN', 'RECOVERED');

-- CreateTable
CREATE TABLE "pharmacy_sales" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "status" "PharmacySaleStatus" NOT NULL DEFAULT 'OPEN',
    "originalSaleId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pharmacy_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_sale_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "medicineId" TEXT NOT NULL,
    "presentationId" TEXT NOT NULL,
    "packLevelId" TEXT NOT NULL,
    "saleUnit" "PharmacySaleUnit" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "canonicalUnitsPerSaleUnit" INTEGER NOT NULL,
    "canonicalUnits" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "proRataCeilingMinor" INTEGER NOT NULL,
    "unitCostMinor" INTEGER NOT NULL,
    "discountKind" "PharmacyDiscountKind",
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "approvalPolicy" TEXT,
    "approvedByUserId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pharmacy_sale_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_sale_line_allocations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "saleLineId" TEXT NOT NULL,
    "inventoryLotId" TEXT NOT NULL,
    "stockLocationId" TEXT NOT NULL,
    "canonicalUnits" INTEGER NOT NULL,
    "stockMovementId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pharmacy_sale_line_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_sale_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "kind" "PharmacySaleEventKind" NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT,
    "payload" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pharmacy_sale_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_sale_returns" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "originalSaleId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pharmacy_sale_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_sale_return_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "saleLineId" TEXT NOT NULL,
    "inventoryLotId" TEXT NOT NULL,
    "stockLocationId" TEXT NOT NULL,
    "canonicalUnits" INTEGER NOT NULL,
    "integrityDecision" TEXT NOT NULL,
    "stockMovementId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pharmacy_sale_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_unfulfilled_demand_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "saleId" TEXT,
    "requestedMedicineId" TEXT,
    "requestedText" TEXT,
    "strength" TEXT,
    "form" TEXT,
    "presentation" TEXT,
    "saleUnit" "PharmacySaleUnit" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" "PharmacyDemandReason" NOT NULL,
    "inventoryRuleSnapshot" JSONB NOT NULL,
    "estimatedValueMinor" INTEGER,
    "estimatedMarginMinor" INTEGER,
    "customerId" TEXT,
    "consentRecorded" BOOLEAN NOT NULL DEFAULT false,
    "status" "PharmacyDemandStatus" NOT NULL DEFAULT 'OPEN',
    "recoveredSaleLineId" TEXT,
    "recoveredAt" TIMESTAMP(3),
    "capturedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pharmacy_unfulfilled_demand_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pharmacy_sales_organizationId_branchId_status_createdAt_idx" ON "pharmacy_sales"("organizationId", "branchId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_sales_organizationId_id_key" ON "pharmacy_sales"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_sales_organizationId_branchId_id_key" ON "pharmacy_sales"("organizationId", "branchId", "id");

-- CreateIndex
CREATE INDEX "pharmacy_sale_lines_organizationId_branchId_saleId_idx" ON "pharmacy_sale_lines"("organizationId", "branchId", "saleId");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_sale_lines_organizationId_id_key" ON "pharmacy_sale_lines"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_sale_lines_organizationId_idempotencyKey_key" ON "pharmacy_sale_lines"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "pharmacy_sale_line_allocations_organizationId_saleLineId_idx" ON "pharmacy_sale_line_allocations"("organizationId", "saleLineId");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_sale_line_allocations_organizationId_id_key" ON "pharmacy_sale_line_allocations"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_sale_line_allocations_organizationId_stockMovement_key" ON "pharmacy_sale_line_allocations"("organizationId", "stockMovementId");

-- CreateIndex
CREATE INDEX "pharmacy_sale_events_organizationId_branchId_saleId_occurre_idx" ON "pharmacy_sale_events"("organizationId", "branchId", "saleId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_sale_events_organizationId_id_key" ON "pharmacy_sale_events"("organizationId", "id");

-- CreateIndex
CREATE INDEX "pharmacy_sale_returns_organizationId_branchId_originalSaleI_idx" ON "pharmacy_sale_returns"("organizationId", "branchId", "originalSaleId");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_sale_returns_organizationId_id_key" ON "pharmacy_sale_returns"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_sale_returns_organizationId_branchId_id_key" ON "pharmacy_sale_returns"("organizationId", "branchId", "id");

-- CreateIndex
CREATE INDEX "pharmacy_sale_return_lines_organizationId_saleLineId_idx" ON "pharmacy_sale_return_lines"("organizationId", "saleLineId");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_sale_return_lines_organizationId_id_key" ON "pharmacy_sale_return_lines"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_sale_return_lines_organizationId_stockMovementId_key" ON "pharmacy_sale_return_lines"("organizationId", "stockMovementId");

-- CreateIndex
CREATE INDEX "pharmacy_unfulfilled_demand_events_organizationId_branchId__idx" ON "pharmacy_unfulfilled_demand_events"("organizationId", "branchId", "createdAt", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_unfulfilled_demand_events_organizationId_id_key" ON "pharmacy_unfulfilled_demand_events"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "pharmacy_sales" ADD CONSTRAINT "pharmacy_sales_organizationId_branchId_originalSaleId_fkey" FOREIGN KEY ("organizationId", "branchId", "originalSaleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_sale_lines" ADD CONSTRAINT "pharmacy_sale_lines_organizationId_branchId_saleId_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_sale_lines" ADD CONSTRAINT "pharmacy_sale_lines_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "pharmacy_medicines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_sale_lines" ADD CONSTRAINT "pharmacy_sale_lines_presentationId_fkey" FOREIGN KEY ("presentationId") REFERENCES "pharmacy_presentations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_sale_lines" ADD CONSTRAINT "pharmacy_sale_lines_packLevelId_fkey" FOREIGN KEY ("packLevelId") REFERENCES "pharmacy_pack_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_sale_line_allocations" ADD CONSTRAINT "pharmacy_sale_line_allocations_organizationId_saleLineId_fkey" FOREIGN KEY ("organizationId", "saleLineId") REFERENCES "pharmacy_sale_lines"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_sale_line_allocations" ADD CONSTRAINT "pharmacy_sale_line_allocations_organizationId_branchId_inv_fkey" FOREIGN KEY ("organizationId", "branchId", "inventoryLotId") REFERENCES "pharmacy_inventory_lots"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_sale_events" ADD CONSTRAINT "pharmacy_sale_events_organizationId_branchId_saleId_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_sale_returns" ADD CONSTRAINT "pharmacy_sale_returns_organizationId_branchId_originalSale_fkey" FOREIGN KEY ("organizationId", "branchId", "originalSaleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_sale_return_lines" ADD CONSTRAINT "pharmacy_sale_return_lines_organizationId_branchId_returnI_fkey" FOREIGN KEY ("organizationId", "branchId", "returnId") REFERENCES "pharmacy_sale_returns"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_sale_return_lines" ADD CONSTRAINT "pharmacy_sale_return_lines_organizationId_saleLineId_fkey" FOREIGN KEY ("organizationId", "saleLineId") REFERENCES "pharmacy_sale_lines"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_sale_return_lines" ADD CONSTRAINT "pharmacy_sale_return_lines_organizationId_branchId_invento_fkey" FOREIGN KEY ("organizationId", "branchId", "inventoryLotId") REFERENCES "pharmacy_inventory_lots"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_unfulfilled_demand_events" ADD CONSTRAINT "pharmacy_unfulfilled_demand_events_organizationId_branchId_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_unfulfilled_demand_events" ADD CONSTRAINT "pharmacy_unfulfilled_demand_events_requestedMedicineId_fkey" FOREIGN KEY ("requestedMedicineId") REFERENCES "pharmacy_medicines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_unfulfilled_demand_events" ADD CONSTRAINT "pharmacy_unfulfilled_demand_events_organizationId_customer_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_patients"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- POS-03/04: exact canonical projection and a database backstop preventing a
-- caller from persisting a price above the lot-derived MRP ceiling.
ALTER TABLE "pharmacy_sale_lines" ADD CONSTRAINT "pharmacy_sale_lines_quantity_check"
  CHECK ("quantity" > 0 AND "canonicalUnitsPerSaleUnit" > 0
    AND "canonicalUnits" = "quantity" * "canonicalUnitsPerSaleUnit");
ALTER TABLE "pharmacy_sale_lines" ADD CONSTRAINT "pharmacy_sale_lines_price_check"
  CHECK ("unitPriceMinor" >= 0 AND "unitPriceMinor" <= "proRataCeilingMinor"
    AND "unitCostMinor" >= 0 AND "discountMinor" >= 0
    AND "discountMinor" <= "unitPriceMinor" * "quantity");
ALTER TABLE "pharmacy_sale_lines" ADD CONSTRAINT "pharmacy_sale_lines_approval_check"
  CHECK (("discountMinor" = 0 AND "discountKind" IS NULL)
    OR ("discountKind" IS NOT NULL AND length(btrim(COALESCE("approvalPolicy", ''))) > 0
      AND length(btrim(COALESCE("approvedByUserId", ''))) > 0));
ALTER TABLE "pharmacy_sale_line_allocations" ADD CONSTRAINT "pharmacy_sale_alloc_quantity_check" CHECK ("canonicalUnits" > 0);
ALTER TABLE "pharmacy_sale_return_lines" ADD CONSTRAINT "pharmacy_sale_return_quantity_check"
  CHECK ("canonicalUnits" > 0 AND length(btrim("integrityDecision")) > 0);
ALTER TABLE "pharmacy_unfulfilled_demand_events" ADD CONSTRAINT "pharmacy_demand_explicit_check"
  CHECK ("quantity" > 0 AND ("requestedMedicineId" IS NOT NULL OR length(btrim(COALESCE("requestedText", ''))) > 0));
ALTER TABLE "pharmacy_unfulfilled_demand_events" ADD CONSTRAINT "pharmacy_demand_consent_check"
  CHECK ("customerId" IS NULL OR "consentRecorded");
ALTER TABLE "pharmacy_unfulfilled_demand_events" ADD CONSTRAINT "pharmacy_demand_recovery_check"
  CHECK (("status" = 'OPEN' AND "recoveredSaleLineId" IS NULL AND "recoveredAt" IS NULL)
    OR ("status" = 'RECOVERED' AND "saleId" IS NOT NULL AND "recoveredSaleLineId" IS NOT NULL AND "recoveredAt" IS NOT NULL));

-- Invariants 8/9: event, allocation and return evidence is append-only.
CREATE FUNCTION pharmacy_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
CREATE TRIGGER pharmacy_sale_events_append_only BEFORE UPDATE OR DELETE ON "pharmacy_sale_events" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_mutation();
CREATE TRIGGER pharmacy_sale_allocations_append_only BEFORE UPDATE OR DELETE ON "pharmacy_sale_line_allocations" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_mutation();
CREATE TRIGGER pharmacy_sale_returns_append_only BEFORE UPDATE OR DELETE ON "pharmacy_sale_returns" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_mutation();
CREATE TRIGGER pharmacy_sale_return_lines_append_only BEFORE UPDATE OR DELETE ON "pharmacy_sale_return_lines" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_mutation();

-- Serialize return inserts per sold line and reject cumulative returns above sold.
CREATE FUNCTION pharmacy_guard_sale_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sold integer; already integer;
BEGIN
  SELECT "canonicalUnits" INTO sold FROM "pharmacy_sale_lines"
    WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."saleLineId" FOR UPDATE;
  SELECT COALESCE(SUM("canonicalUnits"), 0) INTO already FROM "pharmacy_sale_return_lines"
    WHERE "organizationId" = NEW."organizationId" AND "saleLineId" = NEW."saleLineId";
  IF sold IS NULL OR already + NEW."canonicalUnits" > sold THEN
    RAISE EXCEPTION 'RETURN_EXCEEDS_SOLD' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_sale_return_guard BEFORE INSERT ON "pharmacy_sale_return_lines" FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_sale_return();

-- Tenant isolation is mandatory on every new organization-owned relation.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_sales','pharmacy_sale_lines','pharmacy_sale_line_allocations','pharmacy_sale_events','pharmacy_sale_returns','pharmacy_sale_return_lines','pharmacy_unfulfilled_demand_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("organizationId" = current_setting(''app.current_organization_id'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_organization_id'', true))', t);
  END LOOP;
END $$;
