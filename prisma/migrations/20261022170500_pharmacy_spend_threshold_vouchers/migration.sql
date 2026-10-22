-- Loyalty 2/6: owner-configured, sale-idempotent spend-threshold vouchers.
-- Fail rather than wait indefinitely for the short metadata/index locks taken by this migration.
SET lock_timeout = '5s';

CREATE FUNCTION pharmacy_valid_spend_voucher_tiers(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  tier jsonb;
  seen_thresholds numeric[] := ARRAY[]::numeric[];
  threshold_minor numeric;
  value_minor numeric;
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) NOT BETWEEN 1 AND 20 THEN
    RETURN false;
  END IF;
  FOR tier IN SELECT element FROM jsonb_array_elements(value) AS elements(element) LOOP
    IF jsonb_typeof(tier) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(tier)) <> 2
       OR NOT (tier ? 'thresholdMinor' AND tier ? 'valueMinor')
       OR jsonb_typeof(tier->'thresholdMinor') <> 'number'
       OR jsonb_typeof(tier->'valueMinor') <> 'number' THEN
      RETURN false;
    END IF;
    threshold_minor := (tier->>'thresholdMinor')::numeric;
    value_minor := (tier->>'valueMinor')::numeric;
    IF threshold_minor <> trunc(threshold_minor) OR value_minor <> trunc(value_minor)
       OR threshold_minor NOT BETWEEN 1 AND 9007199254740991
       OR value_minor NOT BETWEEN 1 AND 2147483647
       OR threshold_minor = ANY(seen_thresholds) THEN
      RETURN false;
    END IF;
    seen_thresholds := array_append(seen_thresholds, threshold_minor);
  END LOOP;
  RETURN true;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
  RETURN false;
END;
$$;

ALTER TABLE pharmacy_loyalty_settings
  ADD COLUMN "spendVoucherTiers" JSONB NOT NULL DEFAULT '[{"thresholdMinor":1000000,"valueMinor":50000},{"thresholdMinor":2000000,"valueMinor":100000}]'::jsonb,
  ADD COLUMN "spendVoucherMinBasketMinor" INTEGER NOT NULL DEFAULT 0
    CHECK ("spendVoucherMinBasketMinor" >= 0),
  ADD CONSTRAINT pharmacy_loyalty_settings_spend_tiers_valid
    CHECK (pharmacy_valid_spend_voucher_tiers("spendVoucherTiers"));

ALTER TABLE pharmacy_vouchers ADD COLUMN "issuedSaleId" TEXT;
CREATE UNIQUE INDEX pharmacy_vouchers_issued_sale_key
  ON pharmacy_vouchers("organizationId", "issuedSaleId") WHERE "issuedSaleId" IS NOT NULL;
CREATE INDEX pharmacy_vouchers_issued_sale_lookup_idx
  ON pharmacy_vouchers("organizationId", "branchId", "issuedSaleId");
