-- Replace the lifetime unique key and install its lifecycle guard atomically.
BEGIN;

-- Keep the deployed migration intact; SQL UNKNOWN must not admit an enabled
-- voucher without a fixed discount.
ALTER TABLE "pharmacy_campaigns"
  DROP CONSTRAINT "pharmacy_campaign_voucher_categories_ck",
  ADD CONSTRAINT "pharmacy_campaign_voucher_categories_ck" CHECK (
    (NOT "voucherEnabled" AND "voucherDiscountMinor" IS NULL)
    OR ("voucherEnabled" AND "eligibleCategoryAllowlist" = '["FRONT_SHOP"]'::jsonb
        AND "voucherDiscountMinor" IS NOT NULL AND "voucherDiscountMinor" > 0)
  ) NOT VALID;
ALTER TABLE "pharmacy_campaigns" VALIDATE CONSTRAINT "pharmacy_campaign_voucher_categories_ck";

-- Preserve every reservation, including those released by an unpaid cart's
-- immutable VOIDED event. A capture lock replaces the lifetime unique key.
ALTER TABLE "pharmacy_voucher_redemptions"
  DROP CONSTRAINT "pharmacy_voucher_redemptions_organizationId_captureId_key";
CREATE INDEX "pharmacy_voucher_redemptions_organizationId_captureId_idx"
  ON "pharmacy_voucher_redemptions" ("organizationId", "captureId");
CREATE TRIGGER pharmacy_voucher_redemptions_append_only
  BEFORE UPDATE OR DELETE ON "pharmacy_voucher_redemptions"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_mutation();

CREATE FUNCTION pharmacy_voucher_claim_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Follow the application's sale-before-capture lock order. Also prevent a
  -- stale customer read from funding a cart that was concurrently reassigned.
  PERFORM s.id FROM pharmacy_sales s
    JOIN pharmacy_sale_lines l ON l."organizationId" = s."organizationId"
      AND l."branchId" = s."branchId" AND l."saleId" = s.id
    WHERE l."organizationId" = NEW."organizationId" AND l."branchId" = NEW."branchId"
      AND l.id = NEW."saleLineId" AND s.status = 'OPEN'
      AND s."customerId" = NEW."customerId"
      AND l."discountKind" = 'PROMOTION' AND l."discountMinor" = NEW."discountMinor"
    FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'voucher must fund its recipient cart and exact discount' USING ERRCODE = '23514';
  END IF;

  -- Coordinate on the mutable campaign, leaving capture evidence append-only.
  -- This no-op write forces a serialization failure for stale snapshots at
  -- REPEATABLE READ, where a row lock alone would not refresh the next read.
  UPDATE pharmacy_campaigns SET status = status
    WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId"
      AND id = NEW."campaignId";
  PERFORM id FROM pharmacy_campaign_captures
    WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId"
      AND id = NEW."captureId" AND "campaignId" = NEW."campaignId"
      AND "customerId" = NEW."customerId"
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'voucher capture does not match recipient and campaign' USING ERRCODE = '23514';
  END IF;

  -- Each waiter checks after obtaining the capture lock. Only an explicit void
  -- of an unpaid cart releases a reservation; refunds never replenish vouchers.
  IF EXISTS (
    SELECT 1 FROM pharmacy_voucher_redemptions r
    JOIN pharmacy_sale_lines l ON l."organizationId" = r."organizationId"
      AND l."branchId" = r."branchId" AND l.id = r."saleLineId"
    JOIN pharmacy_sales s ON s."organizationId" = l."organizationId"
      AND s."branchId" = l."branchId" AND s.id = l."saleId"
    WHERE r."organizationId" = NEW."organizationId" AND r."captureId" = NEW."captureId"
      AND NOT (s.status = 'VOID'
        AND NOT EXISTS (SELECT 1 FROM pharmacy_tenders t
          WHERE t."organizationId" = s."organizationId" AND t."branchId" = s."branchId" AND t."saleId" = s.id)
        AND EXISTS (SELECT 1 FROM pharmacy_sale_events e
          WHERE e."organizationId" = s."organizationId" AND e."branchId" = s."branchId"
            AND e."saleId" = s.id AND e.kind = 'VOIDED'))
  ) THEN
    RAISE EXCEPTION 'voucher capture is already reserved or redeemed'
      USING ERRCODE = '23505', CONSTRAINT = 'pharmacy_voucher_capture_active_key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_voucher_claim_capture_guard
  BEFORE INSERT ON "pharmacy_voucher_redemptions"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_voucher_claim_capture();

CREATE FUNCTION pharmacy_voucher_protect_sale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."customerId" IS DISTINCT FROM OLD."customerId" AND EXISTS (
    SELECT 1 FROM pharmacy_voucher_redemptions r
    JOIN pharmacy_sale_lines l ON l."organizationId" = r."organizationId"
      AND l."branchId" = r."branchId" AND l.id = r."saleLineId"
    WHERE l."organizationId" = OLD."organizationId" AND l."branchId" = OLD."branchId" AND l."saleId" = OLD.id
  ) THEN
    RAISE EXCEPTION 'voucher recipient cannot be reassigned' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'VOID' AND NEW.status <> 'VOID' AND EXISTS (
    SELECT 1 FROM pharmacy_voucher_redemptions r
    JOIN pharmacy_sale_lines l ON l."organizationId" = r."organizationId"
      AND l."branchId" = r."branchId" AND l.id = r."saleLineId"
    WHERE l."organizationId" = OLD."organizationId" AND l."branchId" = OLD."branchId" AND l."saleId" = OLD.id
  ) THEN
    RAISE EXCEPTION 'void voucher cart cannot be reopened' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_voucher_protect_sale_guard
  BEFORE UPDATE OF "customerId", status ON "pharmacy_sales"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_voucher_protect_sale();

COMMIT;
