-- Additive only: existing lot-required ledger and prescription review uniqueness stay intact.
CREATE UNIQUE INDEX "pharmacy_sale_lines_organizationId_branchId_id_key"
  ON "pharmacy_sale_lines" ("organizationId", "branchId", "id");
CREATE TABLE "pharmacy_unidentified_return_holds" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "returnId" TEXT NOT NULL,
  "saleLineId" TEXT NOT NULL,
  "quarantineLocationId" TEXT NOT NULL,
  "canonicalUnits" INTEGER NOT NULL CHECK ("canonicalUnits" > 0),
  "integrityDecision" TEXT NOT NULL CHECK (length(btrim("integrityDecision")) > 0),
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "branchId", "id"),
  UNIQUE ("organizationId", "returnId"),
  CONSTRAINT "return_hold_return_fk" FOREIGN KEY ("organizationId", "branchId", "returnId") REFERENCES "pharmacy_sale_returns" ("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "return_hold_line_fk" FOREIGN KEY ("organizationId", "branchId", "saleLineId") REFERENCES "pharmacy_sale_lines" ("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "return_hold_location_fk" FOREIGN KEY ("organizationId", "branchId", "quarantineLocationId") REFERENCES "pharmacy_stock_locations" ("organizationId", "branchId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_unidentified_return_holds_organizationId_branchId_sal_idx"
  ON "pharmacy_unidentified_return_holds" ("organizationId", "branchId", "saleLineId");
CREATE TABLE "pharmacy_return_verification_tasks" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "holdingId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "return_task_hold_key" UNIQUE ("organizationId", "branchId", "holdingId"),
  CONSTRAINT "return_task_hold_fk" FOREIGN KEY ("organizationId", "branchId", "holdingId") REFERENCES "pharmacy_unidentified_return_holds" ("organizationId", "branchId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_return_verification_tasks_organizationId_branchId_re_idx"
  ON "pharmacy_return_verification_tasks" ("organizationId", "branchId", "requestedAt");
-- A holding is physical quarantine custody, not a fabricated stock movement.
CREATE FUNCTION pharmacy_validate_unidentified_return_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pharmacy_stock_locations WHERE "organizationId"=NEW."organizationId"
    AND "branchId"=NEW."branchId" AND id=NEW."quarantineLocationId" AND active AND kind='QUARANTINE') THEN
    RAISE EXCEPTION 'unidentified returns require an active quarantine location' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pharmacy_sale_returns r JOIN pharmacy_sale_lines l
    ON l."organizationId"=r."organizationId" AND l."branchId"=r."branchId" AND l."saleId"=r."originalSaleId"
    WHERE r."organizationId"=NEW."organizationId" AND r."branchId"=NEW."branchId"
      AND r.id=NEW."returnId" AND l.id=NEW."saleLineId") THEN
    RAISE EXCEPTION 'holding must belong to the original sale' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_unidentified_return_hold_validate BEFORE INSERT ON pharmacy_unidentified_return_holds
  FOR EACH ROW EXECUTE FUNCTION pharmacy_validate_unidentified_return_hold();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_unidentified_return_holds','pharmacy_return_verification_tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format($policy$CREATE POLICY tenant_isolation ON %I USING ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'')) WITH CHECK ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),''))$policy$,t);
    EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_append_only()',t,t);
  END LOOP;
END $$;

-- Preserve the old trigger and add the new holding-aware bound to both insert paths.
CREATE FUNCTION pharmacy_guard_return_including_holds() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sold integer; returned bigint; held bigint; allocated bigint; lot_returned bigint;
BEGIN
  SELECT "canonicalUnits" INTO sold FROM pharmacy_sale_lines WHERE "organizationId"=NEW."organizationId"
    AND "branchId"=NEW."branchId" AND id=NEW."saleLineId" FOR UPDATE;
  SELECT COALESCE(sum("canonicalUnits"),0) INTO returned FROM pharmacy_sale_return_lines
    WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "saleLineId"=NEW."saleLineId";
  SELECT COALESCE(sum("canonicalUnits"),0) INTO held FROM pharmacy_unidentified_return_holds
    WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "saleLineId"=NEW."saleLineId";
  IF sold IS NULL OR returned + held + NEW."canonicalUnits" > sold THEN
    RAISE EXCEPTION 'RETURN_EXCEEDS_SOLD' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='pharmacy_sale_return_lines' THEN
    SELECT COALESCE(sum("canonicalUnits"),0) INTO allocated FROM pharmacy_sale_line_allocations
      WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId"
        AND "saleLineId"=NEW."saleLineId" AND "inventoryLotId"=NEW."inventoryLotId";
    SELECT COALESCE(sum("canonicalUnits"),0) INTO lot_returned FROM pharmacy_sale_return_lines
      WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId"
        AND "saleLineId"=NEW."saleLineId" AND "inventoryLotId"=NEW."inventoryLotId";
    IF lot_returned + NEW."canonicalUnits" > allocated THEN
      RAISE EXCEPTION 'RETURN_EXCEEDS_SOLD' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_return_holding_quantity_guard BEFORE INSERT ON pharmacy_unidentified_return_holds
  FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_return_including_holds();
CREATE TRIGGER pharmacy_return_lot_quantity_guard BEFORE INSERT ON pharmacy_sale_return_lines
  FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_return_including_holds();
