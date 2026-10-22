ALTER TABLE "pharmacy_prescription_fills"
  ADD COLUMN "saleLineId" TEXT,
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversedByUserId" TEXT;

CREATE OR REPLACE FUNCTION pharmacy_rx_reject_fill_change() RETURNS trigger AS $$
BEGIN
  IF OLD."reversedAt" IS NULL AND NEW."reversedAt" IS NOT NULL AND NEW."reversedByUserId" IS NOT NULL
     AND (to_jsonb(NEW) - 'reversedAt' - 'reversedByUserId') = (to_jsonb(OLD) - 'reversedAt' - 'reversedByUserId') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'pharmacy prescription fill events are append-only' USING ERRCODE='55000';
END $$ LANGUAGE plpgsql;
DROP TRIGGER pharmacy_prescription_fill_append_only ON "pharmacy_prescription_fills";
CREATE TRIGGER pharmacy_prescription_fill_append_only BEFORE UPDATE OR DELETE ON "pharmacy_prescription_fills"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_reject_fill_change();

-- Reversals release quantity and one authorized dispensing event, but sequences
-- are immutable audit ordinals and are therefore never reused.
CREATE OR REPLACE FUNCTION pharmacy_rx_assert_fill_remaining() RETURNS trigger AS $$
DECLARE
  allowed_units INTEGER;
  allowed_events INTEGER;
  used_units BIGINT;
  used_events BIGINT;
  next_sequence INTEGER;
BEGIN
  SELECT l."authorizedCanonicalUnits", p."authorizedRepeats" + 1
    INTO allowed_units, allowed_events
    FROM "pharmacy_prescription_lines" l
    JOIN "pharmacy_prescriptions" p ON p."organizationId"=l."organizationId" AND p."id"=l."prescriptionId"
   WHERE l."organizationId"=NEW."organizationId" AND l."id"=NEW."prescriptionLineId" FOR UPDATE OF l;
  IF allowed_units IS NULL THEN RAISE EXCEPTION 'prescription line is unavailable' USING ERRCODE='23514'; END IF;
  SELECT
      COALESCE(SUM("quantityCanonicalUnits") FILTER (WHERE "reversedAt" IS NULL AND (NEW."saleLineId" IS NULL OR "saleLineId" IS DISTINCT FROM NEW."saleLineId")), 0),
      COUNT(*) FILTER (WHERE "reversedAt" IS NULL AND (NEW."saleLineId" IS NULL OR "saleLineId" IS DISTINCT FROM NEW."saleLineId")),
      COALESCE(MAX("fillSequence"), 0) + 1
    INTO used_units, used_events, next_sequence
    FROM "pharmacy_prescription_fills"
   WHERE "organizationId"=NEW."organizationId" AND "prescriptionLineId"=NEW."prescriptionLineId";
  IF used_units + NEW."quantityCanonicalUnits" > allowed_units THEN RAISE EXCEPTION 'fill exceeds remaining authorized quantity' USING ERRCODE='23514'; END IF;
  IF used_events + 1 > allowed_events THEN RAISE EXCEPTION 'fill exceeds authorized repeats' USING ERRCODE='23514'; END IF;
  IF NEW."fillSequence" <> next_sequence THEN RAISE EXCEPTION 'fill sequence must be cumulative and is never reused after reversal' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
