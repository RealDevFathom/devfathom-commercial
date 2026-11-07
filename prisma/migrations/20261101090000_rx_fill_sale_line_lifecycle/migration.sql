-- #410: bind a prescription fill to the sale line that dispensed it, and let a fill of a voided
-- sale release its authorised quantity and repeat without deleting the audit row.
ALTER TABLE "pharmacy_prescription_fills"
  ADD COLUMN "saleLineId" TEXT,
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversedByUserId" TEXT;

-- The new column is NULL on every existing row, so the index build and FK validation are trivial.
CREATE UNIQUE INDEX "pharmacy_prescription_fills_organizationId_saleLineId_key"
  ON "pharmacy_prescription_fills"("organizationId", "saleLineId");

ALTER TABLE "pharmacy_prescription_fills"
  ADD CONSTRAINT "pharmacy_prescription_fills_organizationId_saleLineId_fkey"
  FOREIGN KEY ("organizationId", "saleLineId")
  REFERENCES "pharmacy_sale_lines"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Fills stay append-only. The single permitted change is a one-time reversal of a fill bound to
-- a line of a VOID sale, by the actor recorded on that sale's VOIDED event. Every other column
-- must be unchanged, and DELETE is always refused.
CREATE OR REPLACE FUNCTION pharmacy_rx_reject_fill_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."reversedAt" IS NULL
     AND NEW."reversedAt" IS NOT NULL
     AND NEW."reversedByUserId" IS NOT NULL
     AND OLD."saleLineId" IS NOT NULL
     AND (to_jsonb(NEW) - 'reversedAt' - 'reversedByUserId') = (to_jsonb(OLD) - 'reversedAt' - 'reversedByUserId')
     AND EXISTS (
       SELECT 1
         FROM "pharmacy_sale_lines" line
         JOIN "pharmacy_sales" sale
           ON sale."organizationId" = line."organizationId" AND sale."id" = line."saleId"
         JOIN "pharmacy_sale_events" ev
           ON ev."organizationId" = sale."organizationId" AND ev."saleId" = sale."id"
        WHERE line."organizationId" = OLD."organizationId"
          AND line."id" = OLD."saleLineId"
          AND sale."status" = 'VOID'
          AND ev."kind" = 'VOIDED'
          AND ev."actorId" = NEW."reversedByUserId"
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pharmacy prescription fill events are append-only' USING ERRCODE = '23514';
END $$;

DROP TRIGGER "pharmacy_prescription_fill_append_only" ON "pharmacy_prescription_fills";
CREATE TRIGGER "pharmacy_prescription_fill_append_only"
  BEFORE UPDATE OR DELETE ON "pharmacy_prescription_fills"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_reject_fill_change();

-- Reversed fills no longer consume quantity or a repeat. Sequences are immutable audit ordinals,
-- so the next one is always MAX + 1 over every historical fill and is never reused.
CREATE OR REPLACE FUNCTION pharmacy_rx_assert_fill_remaining() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed_units integer;
  allowed_events integer;
  used_units bigint;
  used_events bigint;
  next_sequence integer;
BEGIN
  SELECT l."authorizedCanonicalUnits", p."authorizedRepeats" + 1
    INTO allowed_units, allowed_events
    FROM "pharmacy_prescription_lines" l
    JOIN "pharmacy_prescriptions" p ON p."organizationId" = l."organizationId" AND p."id" = l."prescriptionId"
   WHERE l."organizationId" = NEW."organizationId" AND l."id" = NEW."prescriptionLineId"
   FOR UPDATE OF l;
  IF allowed_units IS NULL THEN RAISE EXCEPTION 'prescription line is unavailable' USING ERRCODE = '23514'; END IF;
  SELECT COALESCE(SUM("quantityCanonicalUnits") FILTER (WHERE "reversedAt" IS NULL), 0),
         COUNT(*) FILTER (WHERE "reversedAt" IS NULL),
         COALESCE(MAX("fillSequence"), 0) + 1
    INTO used_units, used_events, next_sequence
    FROM "pharmacy_prescription_fills"
   WHERE "organizationId" = NEW."organizationId" AND "prescriptionLineId" = NEW."prescriptionLineId";
  IF used_units + NEW."quantityCanonicalUnits" > allowed_units THEN RAISE EXCEPTION 'fill exceeds remaining authorized quantity' USING ERRCODE = '23514'; END IF;
  IF used_events + 1 > allowed_events THEN RAISE EXCEPTION 'fill exceeds authorized repeats' USING ERRCODE = '23514'; END IF;
  IF NEW."fillSequence" <> next_sequence THEN RAISE EXCEPTION 'fill sequence must be cumulative and is never reused' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
