-- PH-RX (#234): make the prescription-fill trigger agree with the application rule.
--
-- The original trigger (20260902140000) capped total units at a single
-- `authorizedCanonicalUnits`, capped fill events at `authorizedRepeats + 1`, and
-- summed EVERY fill — so it rejected valid partial fills, never released voided
-- sales, and never subtracted returns. The app (`prescriptionConsumedUnits` +
-- `addLine`) instead allows `authorizedCanonicalUnits * (authorizedRepeats + 1)`
-- canonical units across all fills, drops fills on VOID sales, and subtracts
-- returned units. This replacement makes the DB backstop enforce exactly that
-- same allowance, so a fill the app accepts can never 500 on a raw 23514, while
-- a genuine race past the app pre-check still fails closed with a clear 23514.
BEGIN;

CREATE OR REPLACE FUNCTION pharmacy_rx_assert_fill_remaining() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed_units bigint; used_units bigint;
BEGIN
  -- Serialize fills on their immutable line (closes the concurrent double-fill
  -- race) and read the SAME allowance the app enforces.
  SELECT l."authorizedCanonicalUnits"::bigint * (p."authorizedRepeats" + 1)
    INTO allowed_units
    FROM "pharmacy_prescription_lines" l
    JOIN "pharmacy_prescriptions" p
      ON p."organizationId" = l."organizationId" AND p."id" = l."prescriptionId"
   WHERE l."organizationId" = NEW."organizationId" AND l."id" = NEW."prescriptionLineId"
   FOR UPDATE OF l;
  IF allowed_units IS NULL THEN
    RAISE EXCEPTION 'prescription line is unavailable' USING ERRCODE = '23514';
  END IF;
  -- Consumed units mirror prescriptionConsumedUnits: a VOID sale releases its
  -- fill entirely, returned units subtract, and no fill contributes below zero.
  SELECT COALESCE(SUM(CASE WHEN s.status = 'VOID' THEN 0 ELSE
      GREATEST(0, f."quantityCanonicalUnits" - COALESCE((
        SELECT SUM(r."canonicalUnits") FROM "pharmacy_sale_return_lines" r
        WHERE r."organizationId" = f."organizationId" AND r."saleLineId" = l.id
      ), 0)) END), 0)
    INTO used_units
    FROM "pharmacy_prescription_fills" f
    LEFT JOIN "pharmacy_sale_lines" l ON l."organizationId" = f."organizationId"
      AND f."idempotencyKey" IN ('rx:' || l.id, 'controlled:' || l.id)
    LEFT JOIN "pharmacy_sales" s ON s."organizationId" = l."organizationId" AND s.id = l."saleId"
   WHERE f."organizationId" = NEW."organizationId" AND f."prescriptionLineId" = NEW."prescriptionLineId";
  IF used_units + NEW."quantityCanonicalUnits" > allowed_units THEN
    RAISE EXCEPTION 'fill exceeds remaining authorized quantity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
