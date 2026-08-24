-- WHA-132 / M8 correction B — a bill's grand total may never be negative.
--
-- M5 pinned the fraction constraints and M8 added `discountTotal >= 0`, but nothing
-- stopped the two deductions on a bill (a comp and a loyalty redemption) from being
-- applied to the same money twice and driving `grandTotal` below zero. The command
-- layer now clamps the comp and releases the redemption instead (`bills.compLine`,
-- `loyalty.releaseLoyaltyRedemption`); this is the durable floor under it, so no
-- future writer can persist a negative grand total.
--
-- Additive and precondition-safe:
--   * the constraint is added only when absent, so a re-run is a no-op;
--   * it is added NOT VALID first — enforced on every INSERT/UPDATE from this point
--     on — and then validated in a subtransaction. On a database that already holds
--     a negative bill (exactly the corruption this guards against) the validation
--     fails, is caught, and the deploy proceeds with the constraint enforcing new
--     writes while a warning names the rows an operator must correct. A clean
--     database — every test database, and any migrated-from-empty deploy — ends with
--     the constraint fully VALID.
--
-- No Prisma schema change: `prisma/schema.prisma` cannot express a CHECK, so this
-- introduces no datamodel drift.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.restaurant_bills'::regclass
       AND conname = 'restaurant_bills_grandTotal_nonneg_ck'
  ) THEN
    ALTER TABLE "restaurant_bills"
      ADD CONSTRAINT "restaurant_bills_grandTotal_nonneg_ck" CHECK ("grandTotal" >= 0) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  ALTER TABLE "restaurant_bills" VALIDATE CONSTRAINT "restaurant_bills_grandTotal_nonneg_ck";
EXCEPTION
  WHEN check_violation THEN
    RAISE WARNING 'restaurant_bills_grandTotal_nonneg_ck left NOT VALID: existing rows have grandTotal < 0. New writes are already rejected; correct the historical rows, then run ALTER TABLE "restaurant_bills" VALIDATE CONSTRAINT "restaurant_bills_grandTotal_nonneg_ck";';
END
$$;
