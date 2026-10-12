-- DEM-03 / §8A invariants 6, 19 and 20: explicit-event restock interest,
-- consented capture-only notifications, reservations and receipt recovery.
CREATE TYPE "PharmacyRestockInterestStatus" AS ENUM ('OPEN', 'NOTIFIED', 'RECOVERED', 'OPTED_OUT');
CREATE TYPE "PharmacyRestockReservationStatus" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED');
CREATE TYPE "PharmacyRestockNotificationStatus" AS ENUM ('CAPTURED', 'CANCELLED');

CREATE TABLE "pharmacy_restock_interests" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "demandEventId" TEXT NOT NULL,
  "patientId" TEXT,
  "channel" "PatientConsentChannel",
  "reserveOnArrival" BOOLEAN NOT NULL DEFAULT false,
  "quantityUnits" INTEGER NOT NULL,
  "campaignKey" TEXT,
  "status" "PharmacyRestockInterestStatus" NOT NULL DEFAULT 'OPEN',
  "recoveredSaleId" TEXT,
  "recoveredSaleLineId" TEXT,
  "recoveredAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_restock_interests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_restock_interest_contact_ck" CHECK (("patientId" IS NULL AND "channel" IS NULL) OR ("patientId" IS NOT NULL AND "channel" IN ('SMS', 'WHATSAPP'))),
  CONSTRAINT "pharmacy_restock_interest_quantity_ck" CHECK ("quantityUnits" > 0),
  CONSTRAINT "pharmacy_restock_interest_recovery_ck" CHECK (("status" = 'RECOVERED' AND "recoveredSaleId" IS NOT NULL AND "recoveredSaleLineId" IS NOT NULL AND "recoveredAt" IS NOT NULL) OR ("status" <> 'RECOVERED' AND "recoveredSaleId" IS NULL AND "recoveredSaleLineId" IS NULL AND "recoveredAt" IS NULL))
);

CREATE TABLE "pharmacy_restock_reservations" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "interestId" TEXT NOT NULL,
  "inventoryLotId" TEXT NOT NULL,
  "stockLocationId" TEXT NOT NULL,
  "reservedUnits" INTEGER NOT NULL,
  "status" "PharmacyRestockReservationStatus" NOT NULL DEFAULT 'RESERVED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "pharmacy_restock_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_restock_reservation_quantity_ck" CHECK ("reservedUnits" > 0),
  CONSTRAINT "pharmacy_restock_reservation_settlement_ck" CHECK (("status" = 'RESERVED' AND "settledAt" IS NULL) OR ("status" <> 'RESERVED' AND "settledAt" IS NOT NULL))
);

CREATE TABLE "pharmacy_restock_notifications" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "interestId" TEXT NOT NULL,
  "channel" "PatientConsentChannel" NOT NULL,
  "destination" TEXT NOT NULL,
  "status" "PharmacyRestockNotificationStatus" NOT NULL DEFAULT 'CAPTURED',
  "consentId" TEXT NOT NULL,
  "inventoryLotId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelledAt" TIMESTAMP(3),
  CONSTRAINT "pharmacy_restock_notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_restock_notification_capture_ck" CHECK ("channel" IN ('SMS', 'WHATSAPP') AND length(btrim("destination")) > 0),
  CONSTRAINT "pharmacy_restock_notification_cancel_ck" CHECK (("status" = 'CAPTURED' AND "cancelledAt" IS NULL) OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL))
);

CREATE UNIQUE INDEX "pharmacy_restock_interests_org_id_key" ON "pharmacy_restock_interests"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_restock_interests_org_branch_event_key" ON "pharmacy_restock_interests"("organizationId", "branchId", "demandEventId");
CREATE UNIQUE INDEX "pharmacy_restock_interests_org_branch_id_key" ON "pharmacy_restock_interests"("organizationId", "branchId", "id");
CREATE INDEX "pharmacy_restock_interests_org_branch_status_idx" ON "pharmacy_restock_interests"("organizationId", "branchId", "status", "createdAt");
CREATE INDEX "pharmacy_restock_interests_org_branch_campaign_idx" ON "pharmacy_restock_interests"("organizationId", "branchId", "campaignKey", "status");
CREATE UNIQUE INDEX "pharmacy_restock_reservations_org_id_key" ON "pharmacy_restock_reservations"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_restock_reservations_org_branch_interest_key" ON "pharmacy_restock_reservations"("organizationId", "branchId", "interestId");
CREATE INDEX "pharmacy_restock_reservations_availability_idx" ON "pharmacy_restock_reservations"("organizationId", "branchId", "inventoryLotId", "stockLocationId", "status");
CREATE UNIQUE INDEX "pharmacy_restock_notifications_org_id_key" ON "pharmacy_restock_notifications"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_restock_notifications_org_idempotency_key" ON "pharmacy_restock_notifications"("organizationId", "idempotencyKey");
CREATE INDEX "pharmacy_restock_notifications_org_branch_status_idx" ON "pharmacy_restock_notifications"("organizationId", "branchId", "status", "queuedAt");

ALTER TABLE "pharmacy_restock_interests" ADD CONSTRAINT "pharmacy_restock_interests_demand_fkey" FOREIGN KEY ("organizationId", "demandEventId") REFERENCES "pharmacy_unfulfilled_demand_events"("organizationId", "id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_restock_interests" ADD CONSTRAINT "pharmacy_restock_interests_patient_fkey" FOREIGN KEY ("organizationId", "patientId") REFERENCES "pharmacy_patients"("organizationId", "id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_restock_interests" ADD CONSTRAINT "pharmacy_restock_interests_recovered_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "recoveredSaleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_restock_reservations" ADD CONSTRAINT "pharmacy_restock_reservations_interest_fkey" FOREIGN KEY ("organizationId", "branchId", "interestId") REFERENCES "pharmacy_restock_interests"("organizationId", "branchId", "id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_restock_reservations" ADD CONSTRAINT "pharmacy_restock_reservations_lot_fkey" FOREIGN KEY ("organizationId", "branchId", "inventoryLotId") REFERENCES "pharmacy_inventory_lots"("organizationId", "branchId", "id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_restock_notifications" ADD CONSTRAINT "pharmacy_restock_notifications_interest_fkey" FOREIGN KEY ("organizationId", "branchId", "interestId") REFERENCES "pharmacy_restock_interests"("organizationId", "branchId", "id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_restock_notifications" ADD CONSTRAINT "pharmacy_restock_notifications_consent_fkey" FOREIGN KEY ("organizationId", "consentId") REFERENCES "pharmacy_patient_consents"("organizationId", "id") ON DELETE RESTRICT;

CREATE FUNCTION pharmacy_validate_restock_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE available_units INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."organizationId", NEW."branchId", NEW."interestId", NEW."inventoryLotId", NEW."stockLocationId", NEW."reservedUnits", NEW."createdAt") IS DISTINCT FROM (OLD."organizationId", OLD."branchId", OLD."interestId", OLD."inventoryLotId", OLD."stockLocationId", OLD."reservedUnits", OLD."createdAt")
      OR OLD."status" <> 'RESERVED' OR NEW."status" NOT IN ('CONSUMED', 'RELEASED') THEN
      RAISE EXCEPTION 'restock reservation payload or settled state is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT balance."onHandUnits" - COALESCE((SELECT SUM(c."reservedUnits") FROM "pharmacy_supplier_claims" c WHERE c."organizationId" = NEW."organizationId" AND c."branchId" = NEW."branchId" AND c."inventoryLotId" = NEW."inventoryLotId" AND c."status" = 'RESERVED'), 0) - COALESCE((SELECT SUM(r."reservedUnits") FROM "pharmacy_restock_reservations" r WHERE r."organizationId" = NEW."organizationId" AND r."branchId" = NEW."branchId" AND r."inventoryLotId" = NEW."inventoryLotId" AND r."stockLocationId" = NEW."stockLocationId" AND r."status" = 'RESERVED'), 0)
  INTO available_units
  FROM "pharmacy_stock_balances" balance
  JOIN "pharmacy_inventory_lots" lot ON lot."organizationId" = balance."organizationId" AND lot."branchId" = balance."branchId" AND lot."id" = balance."inventoryLotId"
  JOIN "pharmacy_manufacturing_batches" batch ON batch."organizationId" = lot."organizationId" AND batch."id" = lot."manufacturingBatchId"
  JOIN "pharmacy_restock_interests" interest ON interest."organizationId" = NEW."organizationId" AND interest."branchId" = NEW."branchId" AND interest."id" = NEW."interestId"
  JOIN "pharmacy_unfulfilled_demand_events" demand ON demand."organizationId" = interest."organizationId" AND demand."id" = interest."demandEventId"
  WHERE balance."organizationId" = NEW."organizationId" AND balance."branchId" = NEW."branchId" AND balance."inventoryLotId" = NEW."inventoryLotId" AND balance."stockLocationId" = NEW."stockLocationId" AND balance."disposition" = 'AVAILABLE' AND lot."receivedAt" IS NOT NULL AND batch."state" = 'ACTIVE' AND batch."expiresAt" > CURRENT_TIMESTAMP AND demand."requestedMedicineId" = batch."medicineId"
  FOR UPDATE OF balance;
  IF available_units IS NULL OR available_units < NEW."reservedUnits" THEN RAISE EXCEPTION 'restock reservation exceeds safe available stock' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_restock_reservation_guard BEFORE INSERT OR UPDATE ON "pharmacy_restock_reservations" FOR EACH ROW EXECUTE FUNCTION pharmacy_validate_restock_reservation();

-- A DEM-03 recovery can occur on a later receipt even when the explicit POS-10
-- event was captured outside a sale. The recovered line remains the attribution.
ALTER TABLE "pharmacy_unfulfilled_demand_events" DROP CONSTRAINT "pharmacy_demand_recovery_check";
ALTER TABLE "pharmacy_unfulfilled_demand_events" ADD CONSTRAINT "pharmacy_demand_recovery_check"
  CHECK (("status" = 'OPEN' AND "recoveredSaleLineId" IS NULL AND "recoveredAt" IS NULL)
    OR ("status" = 'RECOVERED' AND "recoveredSaleLineId" IS NOT NULL AND "recoveredAt" IS NOT NULL));

CREATE FUNCTION pharmacy_validate_restock_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pharmacy_restock_interests" interest
    JOIN "pharmacy_patient_consents" consent ON consent."organizationId" = interest."organizationId" AND consent."patientId" = interest."patientId" AND consent."purpose" = 'REMINDERS' AND consent."channel" = interest."channel" AND consent."granted" AND consent."revokedAt" IS NULL
    WHERE interest."organizationId" = NEW."organizationId" AND interest."branchId" = NEW."branchId" AND interest."id" = NEW."interestId" AND interest."status" <> 'OPTED_OUT' AND interest."channel" = NEW."channel" AND consent."id" = NEW."consentId"
      AND NOT EXISTS (SELECT 1 FROM "pharmacy_patient_consents" newer WHERE newer."organizationId" = consent."organizationId" AND newer."patientId" = consent."patientId" AND newer."purpose" = consent."purpose" AND newer."channel" = consent."channel" AND newer."version" > consent."version")
  ) THEN RAISE EXCEPTION 'current reminders consent required' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_restock_notification_consent_guard BEFORE INSERT ON "pharmacy_restock_notifications" FOR EACH ROW EXECUTE FUNCTION pharmacy_validate_restock_notification();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_restock_interests','pharmacy_restock_reservations','pharmacy_restock_notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_branch_select ON %I FOR SELECT USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), ''''))', t);
    EXECUTE format('CREATE POLICY tenant_branch_insert ON %I FOR INSERT WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), ''''))', t);
    EXECUTE format('CREATE POLICY tenant_branch_update ON %I FOR UPDATE USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), '''')) WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), ''''))', t);
  END LOOP;
END $$;
