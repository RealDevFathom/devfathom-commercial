-- A sale line can span lots with different printed MRPs. Persist its exact
-- weighted gross rather than reconstructing it from one representative price.
ALTER TABLE "pharmacy_sale_lines"
  ADD COLUMN "grossMinor" INTEGER;

-- Backfill in committed batches. A single UPDATE retains every historical row
-- lock and all of its WAL until migrate-deploy finishes, which can stall live
-- checkout on a populated ledger. Prisma runs PostgreSQL migration scripts
-- without an enclosing transaction, allowing this procedure to commit each
-- bounded batch before continuing.
CREATE PROCEDURE pharmacy_backfill_sale_line_gross_minor()
LANGUAGE plpgsql
AS $$
DECLARE
  affected_rows INTEGER;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
      FROM "pharmacy_sale_lines"
      WHERE "grossMinor" IS NULL
      ORDER BY id
      LIMIT 5000
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "pharmacy_sale_lines" AS line
    SET "grossMinor" = line."unitPriceMinor" * line."quantity"
    FROM batch
    WHERE line.id = batch.id;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    COMMIT;
    EXIT WHEN affected_rows = 0;
  END LOOP;
END;
$$;

CALL pharmacy_backfill_sale_line_gross_minor();
DROP PROCEDURE pharmacy_backfill_sale_line_gross_minor();

-- Validate the contract under the weaker validation lock before the brief
-- catalog-only SET NOT NULL operation. The temporary check is then removed.
ALTER TABLE "pharmacy_sale_lines"
  ADD CONSTRAINT "pharmacy_sale_lines_gross_minor_not_null"
  CHECK ("grossMinor" IS NOT NULL) NOT VALID;

ALTER TABLE "pharmacy_sale_lines"
  VALIDATE CONSTRAINT "pharmacy_sale_lines_gross_minor_not_null";

ALTER TABLE "pharmacy_sale_lines"
  ALTER COLUMN "grossMinor" SET NOT NULL;

ALTER TABLE "pharmacy_sale_lines"
  DROP CONSTRAINT "pharmacy_sale_lines_gross_minor_not_null";

ALTER TABLE "pharmacy_sale_lines"
  DROP CONSTRAINT "pharmacy_sale_lines_price_check";

ALTER TABLE "pharmacy_sale_lines"
  ADD CONSTRAINT "pharmacy_sale_lines_price_check"
  CHECK (
    "unitPriceMinor" >= 0
    AND "unitPriceMinor" <= "proRataCeilingMinor"
    AND "grossMinor" >= 0
    AND "unitCostMinor" >= 0
    AND "discountMinor" >= 0
    AND "discountMinor" <= "grossMinor"
  ) NOT VALID;

ALTER TABLE "pharmacy_sale_lines"
  VALIDATE CONSTRAINT "pharmacy_sale_lines_price_check";
