ALTER TABLE "pharmacy_prescription_fills"
  ADD COLUMN "saleLineId" TEXT,
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversedByUserId" TEXT;

-- Historic fills predate sale-line binding and remain valid history. Every fill
-- created by the sale dispensing paths below is bound; null is legacy-only.
CREATE UNIQUE INDEX "pharmacy_prescription_fills_organizationId_saleLineId_key"
  ON "pharmacy_prescription_fills"("organizationId", "saleLineId")
  WHERE "saleLineId" IS NOT NULL;

ALTER TABLE "pharmacy_prescription_fills"
  ADD CONSTRAINT "pharmacy_prescription_fills_saleLine_fkey"
  FOREIGN KEY ("organizationId", "saleLineId")
  REFERENCES "pharmacy_sale_lines"("organizationId", "id") ON DELETE RESTRICT;

-- A fill is immutable except for its single lifecycle reversal.
CREATE OR REPLACE FUNCTION pharmacy_rx_reject_fill_change() RETURNS trigger AS $$
BEGIN
  IF OLD."reversedAt" IS NULL
     AND NEW."reversedAt" IS NOT NULL
     AND NEW."reversedByUserId" IS NOT NULL
     AND (to_jsonb(NEW) - 'reversedAt' - 'reversedByUserId') =
         (to_jsonb(OLD) - 'reversedAt' - 'reversedByUserId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pharmacy prescription fill events are append-only' USING ERRCODE='55000';
END $$ LANGUAGE plpgsql;

DROP TRIGGER pharmacy_prescription_fill_append_only ON "pharmacy_prescription_fills";
CREATE TRIGGER pharmacy_prescription_fill_append_only
  BEFORE UPDATE OR DELETE ON "pharmacy_prescription_fills"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_reject_fill_change();

CREATE OR REPLACE FUNCTION pharmacy_rx_assert_fill_remaining() RETURNS trigger AS $$
DECLARE allowed_units INTEGER; used_units INTEGER;
BEGIN
  SELECT l."authorizedCanonicalUnits" INTO allowed_units
    FROM "pharmacy_prescription_lines" l
    JOIN "pharmacy_prescriptions" p ON p."organizationId"=l."organizationId" AND p."id"=l."prescriptionId"
   WHERE l."organizationId"=NEW."organizationId" AND l."id"=NEW."prescriptionLineId"
   FOR UPDATE OF l;
  IF allowed_units IS NULL THEN RAISE EXCEPTION 'prescription line is unavailable' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(SUM("quantityCanonicalUnits"),0) INTO used_units
    FROM "pharmacy_prescription_fills"
   WHERE "organizationId"=NEW."organizationId"
     AND "prescriptionLineId"=NEW."prescriptionLineId"
     AND "reversedAt" IS NULL
     AND (NEW."saleLineId" IS NULL OR "saleLineId" IS DISTINCT FROM NEW."saleLineId");
  IF used_units + NEW."quantityCanonicalUnits" > allowed_units THEN
    RAISE EXCEPTION 'fill exceeds remaining authorized quantity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
