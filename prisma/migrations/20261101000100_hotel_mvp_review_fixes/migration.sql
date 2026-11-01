-- Hotel MVP review fixes (PR #964), on top of 20261101000000.
--
--   1. Housekeeping clean/dirty is the room's own `hotel_rooms.status`, written
--      through the existing status matrix and its trigger-owned event ledger
--      (spec §4.3). The parallel `hotel_room_housekeeping` table could disagree
--      with it (an OCCUPIED room marked CLEAN), so it is dropped.
--   2. A rate plan's tax is capped at 100% (10,000 bp), the same ceiling as a
--      catalog extra's rate.
--   3. A rate plan is priced in its property's currency. Folios take the plan's
--      currency and extras are posted only in the property's currency, so a
--      foreign-currency plan would produce folios no extra can be posted to.
--   4. A folio entry must be in its folio's currency and land on an OPEN folio
--      (a closed folio is settled; corrections included).
--   5. A payment must be in its folio's currency; a refund names a collection
--      of the same folio and, with every earlier refund of it, never exceeds
--      it. The original is row-locked so concurrent refunds serialize.
--
-- The guards raise 23514 (check_violation), which the routers map to CONFLICT.

-- ---------------------------------------------------------------------------
-- 1. One room status
-- ---------------------------------------------------------------------------
DROP TABLE "hotel_room_housekeeping";
DROP TYPE "HotelHousekeepingStatus";

-- ---------------------------------------------------------------------------
-- 2. Rate plan tax ceiling
-- ---------------------------------------------------------------------------
ALTER TABLE "hotel_rate_plans" DROP CONSTRAINT "hotel_rate_plans_tax_ck";
ALTER TABLE "hotel_rate_plans" ADD CONSTRAINT "hotel_rate_plans_tax_ck"
  CHECK ("taxBasisPoints" BETWEEN 0 AND 10000);

-- ---------------------------------------------------------------------------
-- 3. Rate plan currency is the property's
-- ---------------------------------------------------------------------------
CREATE FUNCTION hotel_rate_plan_property_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "hotel_properties" p
    WHERE p."organizationId" = NEW."organizationId"
      AND p."branchId" = NEW."branchId"
      AND p."currency" = NEW."currency"
  ) THEN
    RAISE EXCEPTION 'a rate plan is priced in its property''s currency' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hotel_rate_plan_property_currency BEFORE INSERT ON "hotel_rate_plans"
  FOR EACH ROW EXECUTE FUNCTION hotel_rate_plan_property_currency();

-- ---------------------------------------------------------------------------
-- 4. Folio entries: folio currency, open folio
-- ---------------------------------------------------------------------------
CREATE FUNCTION hotel_folio_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE folio "hotel_folios"%ROWTYPE;
BEGIN
  SELECT * INTO folio FROM "hotel_folios"
    WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId" AND "id" = NEW."folioId";
  IF NOT FOUND OR folio."status" <> 'OPEN' OR folio."currency" <> NEW."currency" THEN
    RAISE EXCEPTION 'a folio entry is posted to an open folio in the folio''s currency' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hotel_folio_entries_folio_guard BEFORE INSERT ON "hotel_folio_entries"
  FOR EACH ROW EXECUTE FUNCTION hotel_folio_entry_guard();

-- ---------------------------------------------------------------------------
-- 5. Payments: folio currency; refunds bounded by the original collection
-- ---------------------------------------------------------------------------
CREATE FUNCTION hotel_folio_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  folio_currency TEXT;
  original "hotel_folio_payments"%ROWTYPE;
  refunded BIGINT;
BEGIN
  SELECT "currency" INTO folio_currency FROM "hotel_folios"
    WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId" AND "id" = NEW."folioId";
  IF folio_currency IS NULL OR folio_currency <> NEW."currency" THEN
    RAISE EXCEPTION 'a payment is recorded in its folio''s currency' USING ERRCODE = '23514';
  END IF;
  IF NEW."direction" = 'REFUND' THEN
    -- Locking the original serializes concurrent refunds of one collection.
    SELECT * INTO original FROM "hotel_folio_payments"
      WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId"
        AND "id" = NEW."refundsPaymentId"
      FOR UPDATE;
    IF NOT FOUND OR original."direction" <> 'COLLECTION'
       OR original."folioId" <> NEW."folioId" OR original."currency" <> NEW."currency" THEN
      RAISE EXCEPTION 'a refund names a collection of the same folio and currency' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM("amountMinor"), 0) INTO refunded FROM "hotel_folio_payments"
      WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId"
        AND "refundsPaymentId" = original."id";
    IF refunded + NEW."amountMinor" > original."amountMinor" THEN
      RAISE EXCEPTION 'a refund may not exceed the remaining collected amount' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hotel_folio_payments_guard BEFORE INSERT ON "hotel_folio_payments"
  FOR EACH ROW EXECUTE FUNCTION hotel_folio_payment_guard();
CREATE INDEX "hotel_folio_payments_refunds_idx"
  ON "hotel_folio_payments"("organizationId", "branchId", "refundsPaymentId");
