-- Expand first. The backfill CALL must be its own migration/query so that
-- PostgreSQL permits the procedure's bounded transaction commits.
ALTER TABLE "pharmacy_sale_lines" ADD COLUMN "grossMinor" INTEGER;

-- Keep old application writes safe while the backfill runs.
CREATE FUNCTION pharmacy_default_sale_line_gross_minor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."grossMinor" := COALESCE(NEW."grossMinor", NEW."unitPriceMinor" * NEW."quantity");
  RETURN NEW;
END;
$$;
CREATE TRIGGER pharmacy_default_sale_line_gross_minor
BEFORE INSERT OR UPDATE ON "pharmacy_sale_lines"
FOR EACH ROW EXECUTE FUNCTION pharmacy_default_sale_line_gross_minor();

ALTER TABLE "pharmacy_sale_lines"
  ADD CONSTRAINT "pharmacy_sale_lines_gross_minor_not_null"
  CHECK ("grossMinor" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "pharmacy_sale_lines_gross_price_check"
  CHECK (
    "unitPriceMinor" >= 0
    AND "unitPriceMinor" <= "proRataCeilingMinor"
    AND "grossMinor" >= 0
    AND "grossMinor"::bigint <= "proRataCeilingMinor"::bigint * "quantity"
    AND "unitCostMinor" >= 0
    AND "discountMinor" >= 0
    AND "discountMinor" <= "grossMinor"
  ) NOT VALID;

-- Historical append-only evidence is left unchanged. New evidence snapshots
-- exact charged/reversed amounts; null means the historical uniform-price rule.
ALTER TABLE "pharmacy_sale_line_allocations"
  ADD COLUMN "grossMinor" INTEGER,
  ADD COLUMN "discountMinor" INTEGER,
  ADD CONSTRAINT "pharmacy_sale_alloc_money_check" CHECK (
    ("grossMinor" IS NULL AND "discountMinor" IS NULL) OR
    ("grossMinor" IS NOT NULL AND "discountMinor" IS NOT NULL
      AND "grossMinor" >= 0 AND "discountMinor" >= 0 AND "discountMinor" <= "grossMinor")
  );
ALTER TABLE "pharmacy_sale_return_lines"
  ADD COLUMN "grossMinor" INTEGER,
  ADD COLUMN "discountMinor" INTEGER,
  ADD CONSTRAINT "pharmacy_sale_return_money_check" CHECK (
    ("grossMinor" IS NULL AND "discountMinor" IS NULL) OR
    ("grossMinor" IS NOT NULL AND "discountMinor" IS NOT NULL
      AND "grossMinor" >= 0 AND "discountMinor" >= 0 AND "discountMinor" <= "grossMinor")
  );
ALTER TABLE "pharmacy_unidentified_return_holds"
  ADD COLUMN "grossMinor" INTEGER,
  ADD COLUMN "discountMinor" INTEGER,
  ADD CONSTRAINT "pharmacy_return_hold_money_check" CHECK (
    ("grossMinor" IS NULL AND "discountMinor" IS NULL) OR
    ("grossMinor" IS NOT NULL AND "discountMinor" IS NOT NULL
      AND "grossMinor" >= 0 AND "discountMinor" >= 0 AND "discountMinor" <= "grossMinor")
  );

CREATE PROCEDURE pharmacy_backfill_sale_line_gross_minor()
LANGUAGE plpgsql AS $$
DECLARE
  tenant_id TEXT;
  affected_rows INTEGER;
BEGIN
  -- Organization visibility accepts platform context, while the sales policy
  -- requires the tenant setting. Re-establish that setting after every COMMIT.
  PERFORM set_config('app.is_platform_admin', 'true', true);
  FOR tenant_id IN SELECT id FROM organizations ORDER BY id LOOP
    LOOP
      PERFORM set_config('app.current_organization_id', tenant_id, true);
      WITH batch AS (
        SELECT id FROM "pharmacy_sale_lines"
        WHERE "grossMinor" IS NULL
        ORDER BY id LIMIT 5000 FOR UPDATE
      )
      UPDATE "pharmacy_sale_lines" AS line
      SET "grossMinor" = line."unitPriceMinor" * line."quantity"
      FROM batch WHERE line.id = batch.id;
      GET DIAGNOSTICS affected_rows = ROW_COUNT;
      COMMIT;
      EXIT WHEN affected_rows = 0;
    END LOOP;
  END LOOP;
END;
$$;
REVOKE ALL ON PROCEDURE pharmacy_backfill_sale_line_gross_minor() FROM PUBLIC;
